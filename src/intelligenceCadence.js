/**
 * VEPA4 — intelligence cadence state (DECOMPOSITION_PLAN P4, step 3).
 *
 * The orchestrator still orders its engines, while this module owns the
 * cross-tick cache and bounded scans shared by those passes. All live world
 * state is read from an injected context so resets and worker completion
 * always observe current buffers rather than snapshots captured at boot.
 */
import { PARTICLE_STRIDE, STRIDE_INDEXES } from './constants.js';
import { speciesMemory, adaptMemory } from './state/memoryBuffers.js';
import { trackDeath } from './engines/lineageTracker.js';

export const METRICS_CADENCE = 8;
export const LINEAGE_CADENCE = 4;

export function createIntelligenceCadence(ctx) {
  let cachedMetrics = null;
  let metricsTick = -1;
  let previousDead = new Uint8Array(0);

  function computeMetrics() {
    let alive = 0;
    let energySum = 0;
    const speciesAlive = new Set();
    const speciesPop = {};
    const speciesEnergy = {};
    const speciesMass = {};
    const speciesPos = {};
    const view = ctx.particleView;
    const count = ctx.particleCount;

    for (let i = 0; i < count; i++) {
      const base = i * PARTICLE_STRIDE;
      if (view[base + STRIDE_INDEXES.DEAD] < 0.5 && (view[base + STRIDE_INDEXES.MASS] || 0) > 0) {
        alive++;
        const species = view[base + STRIDE_INDEXES.SPECIES_ID] || 0;
        const energy = view[base + STRIDE_INDEXES.ENERGY] || 0;
        energySum += energy;
        speciesAlive.add(species);
        speciesPop[species] = (speciesPop[species] || 0) + 1;
        speciesEnergy[species] = (speciesEnergy[species] || 0) + energy;
        speciesMass[species] = (speciesMass[species] || 0) + (view[base + STRIDE_INDEXES.MASS] || 0);
        const position = speciesPos[species] || (speciesPos[species] = [0, 0, 0]);
        position[0] += view[base + STRIDE_INDEXES.POS_X];
        position[1] += view[base + STRIDE_INDEXES.POS_Y];
        position[2] += view[base + STRIDE_INDEXES.POS_Z];
      }
    }

    const insight = ctx.insightEngine;
    const registry = ctx.groupRegistry;
    return {
      populationAlive: alive,
      speciesAlive: speciesAlive.size,
      clusterCount: insight && insight.lastClusters ? insight.lastClusters.clusters.length : 0,
      groupCount: registry ? registry.groups.size : 0,
      avgEnergy: alive ? energySum / alive : 0,
      frameDelta: ctx.fps,
      lawActiveCount: ctx.getLawCount(),
      speciesPop,
      speciesEnergy,
      speciesMass,
      speciesPos,
    };
  }

  function getMetrics() {
    const tick = ctx.tick;
    if (!cachedMetrics || metricsTick < 0 || tick < metricsTick || tick - metricsTick >= METRICS_CADENCE) {
      cachedMetrics = computeMetrics();
      metricsTick = tick;
    } else {
      cachedMetrics.lawActiveCount = ctx.getLawCount();
    }
    return cachedMetrics;
  }

  function adaptCultureFromMetrics(buffers, metrics) {
    const params = ctx.worldParams;
    const rate = (params.CULTURAL_TRANSMISSION || 0.5) * 0.5;
    const threatSignal = ctx.epochEngine && ctx.epochEngine.extinctionOpen ? 1 : 0;
    for (const key of Object.keys(metrics.speciesPop || {})) {
      const species = Number(key);
      const population = metrics.speciesPop[key] || 0;
      const energy = metrics.speciesEnergy[key] || 0;
      const averageEnergy = population ? energy / population : 0;
      adaptMemory(speciesMemory(buffers, species), [
        Math.max(0, Math.min(1, averageEnergy / 100)),
        Math.max(-1, Math.min(1, (population / 200) * 2 - 1)),
        population > 100 ? -0.5 : 0.5,
        threatSignal,
      ], rate);
    }
  }

  function scanDeaths() {
    const { lineageEngine, particleView: view, particleCount: count, tick } = ctx;
    if (!lineageEngine || tick % LINEAGE_CADENCE !== 0) return;
    if (previousDead.length < count) {
      const grown = new Uint8Array(count);
      grown.set(previousDead);
      previousDead = grown;
    }
    for (let i = 0; i < count; i++) {
      const base = i * PARTICLE_STRIDE;
      const dead = view[base + STRIDE_INDEXES.DEAD] >= 0.5 ? 1 : 0;
      if (dead && !previousDead[i]) {
        let cause = 'unknown';
        if ((view[base + STRIDE_INDEXES.HUNGER] || 0) >= 100) cause = 'starvation';
        else if ((view[base + STRIDE_INDEXES.ENERGY] || 0) <= 0) cause = 'energy-depletion';
        trackDeath(lineageEngine, i, cause);
      }
      previousDead[i] = dead;
    }
  }

  function run(updateCore) {
    if (ctx.tickInFlight()) return;
    try {
      updateCore();
    } catch (error) {
      ctx.onError(error);
    }
  }

  function invalidateMetrics() {
    cachedMetrics = null;
    metricsTick = -1;
  }

  function reset() {
    invalidateMetrics();
    previousDead = new Uint8Array(ctx.particleCount);
  }

  return { computeMetrics, getMetrics, adaptCultureFromMetrics, scanDeaths, run, invalidateMetrics, reset };
}
