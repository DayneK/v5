/**
 * VEPA4 — provider-neutral ComputeSession contract (RB decision D3).
 *
 * The session owns authoritative, strictly ordered ticks; the browser keeps
 * UI/camera/input/render. Local adapters (main thread, worker) are the default:
 * they work offline, need no account, and touch no network. The remote adapter
 * is a *port* — fully specified, exercised in tests through an injected
 * transport, and never instantiated by the app until a provider ADR (§6/D3)
 * lands. Nothing here is required to boot or restore a world.
 *
 * Contract: `vepa-compute-session/1.0.0`
 *   - one tick in flight at a time (serialization ⇒ ordered delivery);
 *   - `step()` queues under a bounded backlog and rejects with
 *     `ComputeBackpressureError` past the limit — the caller keeps rendering;
 *   - adapters report capabilities; consumers must check `remote` /
 *     `requiresNetwork` before offering any remote UX.
 */

export const COMPUTE_SESSION_CONTRACT = 'vepa-compute-session/1.0.0';

export class ComputeBackpressureError extends Error {
  constructor(limit) {
    super(`compute session queue full (limit ${limit})`);
    this.name = 'ComputeBackpressureError';
    this.limit = limit;
  }
}

export class ComputeStateError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ComputeStateError';
  }
}

const LOCAL_CAPABILITIES = Object.freeze({
  remote: false,
  requiresNetwork: false,
  authoritative: true,
  ordered: true,
  offline: true,
});

/* ── Adapters ───────────────────────────────────────────────────────────── */

/**
 * Main-thread adapter: `runTick({ seq, dt, source })` executes the tick
 * inline (the ArrayBuffer fallback path). Synchronous throws reject the step.
 */
export function createMainAdapter({ name = 'main-thread', runTick }) {
  if (typeof runTick !== 'function') throw new TypeError('createMainAdapter requires runTick');
  return Object.freeze({
    kind: 'local',
    name,
    capabilities: LOCAL_CAPABILITIES,
    async start() {},
    async tick(job) {
      return runTick(job);
    },
    async stop() {},
  });
}

/**
 * Worker adapter over a postMessage-style transport. The transport is
 * injected (`send`, `subscribe`) so this contract is testable without a real
 * Worker; `src/main.js` keeps its own bridge until an integration ADR wires
 * the app through this session.
 *
 * The transport must reply `{ type: 'TICK_COMPLETE', seq }` or
 * `{ type: 'ERROR', seq, message }`; late replies for stale seqs are ignored.
 */
export function createWorkerAdapter({ name = 'worker', send, subscribe }) {
  if (typeof send !== 'function' || typeof subscribe !== 'function') {
    throw new TypeError('createWorkerAdapter requires send and subscribe functions');
  }
  return Object.freeze({
    kind: 'local',
    name,
    capabilities: LOCAL_CAPABILITIES,
    async start() {},
    tick({ seq, dt, source }) {
      return new Promise((resolve, reject) => {
        const unsubscribe = subscribe((message) => {
          if (!message || message.seq !== seq) return;
          unsubscribe();
          if (message.type === 'ERROR') reject(new Error(message.message || 'worker tick failed'));
          else resolve(message.result);
        });
        try {
          send({ type: 'TICK', seq, dt, source });
        } catch (error) {
          unsubscribe();
          reject(error);
        }
      });
    },
    async stop() {},
  });
}

/**
 * Remote adapter — the provider port (decision D3: provider-neutral only).
 *
 * No provider is chosen: the endpoint and transport are injected. The default
 * transport is a thin POST wrapper around `fetch`, but it only ever runs when
 * a caller explicitly constructs this adapter AND calls `start()` — nothing in
 * the app does, and boot/restore never depends on it. A future provider ADR
 * supplies endpoint, auth, region, cost and latency policy.
 */
export function createRemoteAdapter({ name = 'remote', endpoint, transport, fetchImpl } = {}) {
  if (typeof endpoint !== 'string' || !/^https?:\/\//.test(endpoint)) {
    throw new TypeError('createRemoteAdapter requires an http(s) endpoint (provider ADR, D3)');
  }
  const send = transport || (async (url, body) => {
    const doFetch = fetchImpl || globalThis.fetch;
    if (typeof doFetch !== 'function') throw new Error('no fetch implementation available for remote compute');
    const response = await doFetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-vepa-compute-contract': COMPUTE_SESSION_CONTRACT },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`remote tick failed: HTTP ${response.status}`);
    return response.json();
  });
  return Object.freeze({
    kind: 'remote',
    name,
    endpoint,
    capabilities: Object.freeze({
      remote: true,
      requiresNetwork: true,
      authoritative: false, // browser remains authoritative until an ADR says otherwise
      ordered: true,
      offline: false,
    }),
    async start() {},
    async tick(job) {
      return send(endpoint, { contract: COMPUTE_SESSION_CONTRACT, ...job });
    },
    async stop() {},
  });
}

/* ── Session ────────────────────────────────────────────────────────────── */

/**
 * Create a compute session over an adapter.
 *
 * @param {object} options
 * @param {object} options.adapter adapter from a factory above
 * @param {number} [options.queueLimit=64] max queued `step()` calls
 * @param {() => any} [options.source] payload accessor (particle state) passed to each tick
 */
export function createComputeSession({ adapter, queueLimit = 64, source } = {}) {
  if (!adapter || typeof adapter.tick !== 'function') {
    throw new TypeError('createComputeSession requires an adapter with tick()');
  }
  if (!(Number.isFinite(queueLimit) && queueLimit >= 1)) {
    throw new TypeError('queueLimit must be a positive number');
  }

  const state = { status: 'idle', seq: 0, inFlight: false, queue: [] };
  const listeners = { tick: new Set(), error: new Set(), state: new Set() };

  function emit(event, payload) {
    for (const cb of listeners[event] || []) {
      try { cb(payload); } catch { /* listener errors never break the session */ }
    }
  }

  function setStatus(status) {
    if (state.status === status) return;
    state.status = status;
    emit('state', status);
  }

  function pump() {
    if (state.inFlight || !state.queue.length) return;
    if (state.status !== 'running') return;
    const job = state.queue.shift();
    state.inFlight = true;
    state.seq += 1;
    const seq = state.seq;
    Promise.resolve()
      .then(() => adapter.tick({ seq, dt: job.dt, source: typeof source === 'function' ? source() : source, meta: job.meta }))
      .then((result) => {
        state.inFlight = false;
        const entry = { seq, result };
        job.resolve(entry);
        emit('tick', entry);
        pump();
      }, (error) => {
        state.inFlight = false;
        job.reject(error);
        emit('error', error);
        pump();
      });
  }

  return Object.freeze({
    contract: COMPUTE_SESSION_CONTRACT,
    adapter,
    capabilities: adapter.capabilities,
    get status() { return state.status; },
    get queued() { return state.queue.length; },
    get seq() { return state.seq; },

    on(event, cb) {
      if (!listeners[event]) throw new TypeError(`unknown event "${event}"`);
      listeners[event].add(cb);
      return () => listeners[event].delete(cb);
    },

    async start() {
      if (state.status === 'disposed') throw new ComputeStateError('session disposed');
      await adapter.start();
      setStatus('running');
      pump();
      return this;
    },

    pause() {
      if (state.status !== 'running') throw new ComputeStateError(`cannot pause from "${state.status}"`);
      setStatus('paused');
    },

    resume() {
      if (state.status !== 'paused') throw new ComputeStateError(`cannot resume from "${state.status}"`);
      setStatus('running');
      pump();
    },

    /** Request one authoritative tick. Resolves with `{ seq, result }`. */
    step(dt = 0, meta) {
      if (state.status === 'disposed') return Promise.reject(new ComputeStateError('session disposed'));
      if (state.status === 'idle') return Promise.reject(new ComputeStateError('session not started'));
      if (state.queue.length >= queueLimit) return Promise.reject(new ComputeBackpressureError(queueLimit));
      return new Promise((resolve, reject) => {
        state.queue.push({ dt, meta, resolve, reject });
        pump();
      });
    },

    async dispose() {
      if (state.status === 'disposed') return;
      const pending = state.queue.splice(0, state.queue.length);
      for (const job of pending) job.reject(new ComputeStateError('session disposed'));
      setStatus('disposed');
      await adapter.stop();
    },
  });
}
