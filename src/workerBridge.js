/**
 * VEPA4 — physics worker bridge (DECOMPOSITION_PLAN phase P4, step 1).
 *
 * Pure extraction from `src/main.js`: this module owns the Web Worker
 * lifecycle and the single serialized in-flight tick — the *transport* only.
 * Every piece of world state and every main-thread consequence of a
 * completed tick is injected through `ctx`, so the bridge has no import
 * cycle back into the orchestrator:
 *
 *   ctx.dt                      base timestep (main.js DT)
 *   ctx.particleBuffer          getter — the SharedArrayBuffer/ArrayBuffer
 *   ctx.particleCount           getter — live particle count
 *   ctx.worldSize               getter — current world edge length
 *   ctx.lawState                getter — the 136-law bitmask state
 *   ctx.dnaBuffer               getter — species genome Uint16Array
 *   ctx.seed                    getter — WORKER_SEED (launch seed)
 *   ctx.onStopped()             main-thread side effects of stop()
 *                               (metrics cache reset)
 *   ctx.onTickComplete(tick, message)
 *                               adopt the worker tick counter, then run
 *                               population/intelligence/HUD (finishPhysicsTick)
 *   ctx.emit(type, payload)     event-bus fan-out (physics:backend, …)
 *
 * SharedArrayBuffer lets the worker mutate the same particle memory without
 * copying; browsers without cross-origin isolation keep the safe main-thread
 * path (solve falls through to the local solver) instead of paying a
 * per-tick transfer cost.
 */
import { PARTICLE_STRIDE } from './constants.js';
import { serialize as serializeLawState } from './state/lawState.js';
import { runtimeConfig } from './state/runtimeConfig.js';
import { solve as solveMain, drainOffspring as drainSolverOffspring } from './physics/solver.js';
import { logDebug } from './debug.js';

export function createWorkerBridge(ctx) {
    let physicsWorker = null;
    let workerReady = false;
    let workerPending = false;
    let workerBusy = false;
    let workerFailed = false;
    let workerTickSentAt = 0;
    let _workerTickInFlight = false;
    let _workerOffspring = [];

    function canUsePhysicsWorker() {
        return typeof Worker !== 'undefined' && typeof SharedArrayBuffer !== 'undefined'
            && ctx.particleBuffer instanceof SharedArrayBuffer;
    }

    function stopPhysicsWorker() {
        if (physicsWorker) physicsWorker.terminate();
        physicsWorker = null;
        workerReady = false;
        workerPending = false;
        workerBusy = false;
        _workerTickInFlight = false;
        _workerOffspring.length = 0;
        if (ctx.onStopped) ctx.onStopped();
    }

    function workerConfig() {
        return {
            particleCount: ctx.particleCount,
            worldSize: ctx.worldSize,
            stride: PARTICLE_STRIDE,
            dt: ctx.dt * runtimeConfig.simSpeed,
            seed: ctx.seed,
            worldParams: { ...(runtimeConfig.worldParams || {}) },
            computeEngine: runtimeConfig.computeEngine,
            lawState: serializeLawState(ctx.lawState),
        };
    }

    function syncPhysicsWorker() {
        if (!physicsWorker || !workerReady || workerFailed) return;
        // DNA is a regular Uint16Array (the particle buffer is the large SAB),
        // so include a fresh structured-clone on edits; otherwise the worker
        // would keep simulating the boot-time genome forever.
        physicsWorker.postMessage({
            type: 'CONFIG',
            config: workerConfig(),
            dnaBuffer: ctx.dnaBuffer ? ctx.dnaBuffer.buffer : undefined,
        });
    }

    function solve(...args) {
        if (physicsWorker && workerReady && !workerFailed) {
            // The worker owns the solver; queue one serialized tick and return.
            // The authoritative tick counter arrives via TICK_COMPLETE.
            if (!workerBusy) {
                workerBusy = true;
                _workerTickInFlight = true;
                workerTickSentAt = performance.now();
                physicsWorker.postMessage({
                    type: 'TICK',
                    particleCount: args[1],
                    dt: args[6] || ctx.dt,
                });
            }
            return false;
        }
        solveMain(...args);
        return true;
    }

    function drainOffspring() {
        const local = drainSolverOffspring();
        if (_workerOffspring.length) return local.concat(_workerOffspring.splice(0));
        return local;
    }

    function startPhysicsWorker() {
        stopPhysicsWorker();
        workerFailed = false;
        if (!canUsePhysicsWorker()) return false;
        try {
            physicsWorker = new Worker(new URL('./worker/physics.worker.js', import.meta.url), { type: 'module' });
            workerPending = true;
            physicsWorker.onmessage = (event) => {
                const message = event.data || {};
                if (message.type === 'WORKER_READY') return;
                if (message.type === 'INIT_COMPLETE') {
                    workerReady = true;
                    workerPending = false;
                    logDebug('physics worker ready (SharedArrayBuffer, deterministic solver)');
                    return;
                }
                if (message.type === 'TICK_COMPLETE') {
                    // Bridge bookkeeping first (exactly as before the split):
                    // release the serialized tick, capture the tick start, then
                    // hand the message to main.js for tick adoption + finish.
                    workerBusy = false;
                    _workerTickInFlight = false;
                    const tickStart = workerTickSentAt || performance.now();
                    ctx.onTickComplete(tickStart, message);
                    ctx.emit('physics:backend', {
                        engine: message.gpuActive ? 'webgpu' : 'cpu',
                        available: !!message.gpuAvailable,
                        tick: message.tickCount,
                    });
                    return;
                }
                if (message.type === 'GPU_FALLBACK') {
                    logDebug('WebGPU fallback to reference CPU: ' + (message.error || message.reason || 'unknown'), 'warn');
                    ctx.emit('physics:backend', {
                        engine: 'cpu',
                        available: false,
                        reason: message.reason || 'gpu-fallback',
                    });
                    return;
                }
                if (message.type === 'ERROR') {
                    logDebug('physics worker error: ' + message.error, 'error');
                    workerFailed = true;
                    stopPhysicsWorker();
                    return;
                }
            };
            physicsWorker.onerror = (error) => {
                logDebug('physics worker unavailable: ' + (error.message || 'unknown error'), 'warn');
                workerFailed = true;
                stopPhysicsWorker();
            };
            physicsWorker.postMessage({
                type: 'INIT',
                buffer: ctx.particleBuffer,
                count: ctx.particleCount,
                dnaBuffer: ctx.dnaBuffer.buffer,
                config: workerConfig(),
            });
            return true;
        } catch (error) {
            logDebug('physics worker unavailable: ' + (error.message || error), 'warn');
            stopPhysicsWorker();
            workerFailed = true;
            return false;
        }
    }

    return {
        canUse: canUsePhysicsWorker,
        stop: stopPhysicsWorker,
        config: workerConfig,
        sync: syncPhysicsWorker,
        start: startPhysicsWorker,
        solve,
        drain: drainOffspring,
        isActive: () => physicsWorker !== null,
        tickInFlight: () => _workerTickInFlight,
        isBusy: () => workerBusy,
    };
}
