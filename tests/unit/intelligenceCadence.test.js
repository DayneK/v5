import { describe, expect, it, vi } from 'vitest';
import { PARTICLE_STRIDE, STRIDE_INDEXES } from '../../src/constants.js';
import { createParticleBuffer, setMass, setEnergy } from '../../src/state/particleBuffer.js';
import { createMemoryBuffers, speciesMemory } from '../../src/state/memoryBuffers.js';
import { createIntelligenceCadence } from '../../src/intelligenceCadence.js';

function makeCadence({ count = 2, lawActiveCount = 1 } = {}) {
  const storage = createParticleBuffer(8, PARTICLE_STRIDE);
  setMass(storage.buffer, 0, PARTICLE_STRIDE, 2);
  setEnergy(storage.buffer, 0, PARTICLE_STRIDE, 60);
  storage.view[STRIDE_INDEXES.SPECIES_ID] = 1;
  storage.view[STRIDE_INDEXES.POS_X] = 4;
  storage.view[STRIDE_INDEXES.POS_Y] = 5;
  storage.view[STRIDE_INDEXES.POS_Z] = 6;
  const lineageEngine = {
    bus: { emit: vi.fn() }, particles: new Map(), cfg: { maxEvents: 10 }, events: [],
    totalBirths: 0, totalDeaths: 0, speciesGenerations: new Map(), longestLineage: 0,
  };
  const context = {
    particleView: storage.view,
    particleCount: count,
    tick: 0,
    fps: 60,
    insightEngine: { lastClusters: { clusters: [{ id: 1 }, { id: 2 }] } },
    groupRegistry: { groups: new Map([[1, {}]]) },
    lineageEngine,
    worldParams: { CULTURAL_TRANSMISSION: 0.8 },
    epochEngine: { extinctionOpen: true },
    tickInFlight: vi.fn(() => false),
    onError: vi.fn(),
    getLawCount: vi.fn(() => lawActiveCount),
  };
  return { cadence: createIntelligenceCadence(context), context, lineageEngine, storage };
}

describe('intelligence cadence', () => {
  it('computes live aggregate metrics and caches particle scans while refreshing law count', () => {
    const { cadence, context } = makeCadence();
    const first = cadence.getMetrics();
    expect(first.populationAlive).toBe(1);
    expect(first.speciesAlive).toBe(1);
    expect(first.clusterCount).toBe(2);
    expect(first.groupCount).toBe(1);
    expect(first.avgEnergy).toBe(60);
    expect(first.speciesPop[1]).toBe(1);
    expect(first.speciesMass[1]).toBe(2);
    expect(first.speciesPos[1]).toEqual([4, 5, 6]);

    context.getLawCount.mockReturnValue(0);
    context.particleView[STRIDE_INDEXES.ENERGY] = 20;
    const cached = cadence.getMetrics();
    expect(cached).toBe(first);
    expect(cached.avgEnergy).toBe(60);
    expect(cached.lawActiveCount).toBe(0);

    context.tick = 8;
    expect(cadence.getMetrics().avgEnergy).toBe(20);
    context.tick = 3;
    context.particleCount = 0;
    expect(cadence.getMetrics().populationAlive).toBe(0);
  });

  it('records only cadence-bound death transitions and classifies causes', () => {
    const { cadence, context, lineageEngine, storage } = makeCadence();
    cadence.scanDeaths(); // tick 0 baseline: no deaths
    storage.view[STRIDE_INDEXES.DEAD] = 1;
    storage.view[STRIDE_INDEXES.HUNGER] = 100;
    context.tick = 1;
    cadence.scanDeaths(); // non-cadence tick is skipped
    expect(lineageEngine.totalDeaths).toBe(0);
    context.tick = 4;
    cadence.scanDeaths();
    expect(lineageEngine.totalDeaths).toBe(1);
    expect(lineageEngine.events.at(-1)).toMatchObject({ type: 'death', particleId: 0, cause: 'starvation' });
    cadence.scanDeaths();
    expect(lineageEngine.totalDeaths).toBe(1);

    storage.view[PARTICLE_STRIDE + STRIDE_INDEXES.DEAD] = 1;
    storage.view[PARTICLE_STRIDE + STRIDE_INDEXES.ENERGY] = 0;
    context.particleCount = 2;
    context.tick = 8;
    cadence.scanDeaths();
    expect(lineageEngine.events.at(-1)).toMatchObject({ type: 'death', particleId: 1, cause: 'energy-depletion' });
  });

  it('adapts species memory from energy, population, and extinction signals', () => {
    const { cadence } = makeCadence();
    const buffers = createMemoryBuffers();
    cadence.adaptCultureFromMetrics(buffers, { speciesPop: { 3: 50 }, speciesEnergy: { 3: 4000 } });
    const memory = speciesMemory(buffers, 3);
    expect(memory[0]).toBeCloseTo(0.8 * 0.4, 5);
    expect(memory[1]).toBeCloseTo(((50 / 200) * 2 - 1) * 0.4, 5);
    expect(memory[2]).toBeCloseTo(0.5 * 0.4, 5);
    expect(memory[3]).toBeCloseTo(0.4, 5);
  });

  it('clears cached metrics and resets death baselines against the current population', () => {
    const { cadence, context, storage, lineageEngine } = makeCadence();
    cadence.getMetrics();
    cadence.scanDeaths();
    context.particleCount = 0;
    cadence.reset();
    expect(cadence.getMetrics().populationAlive).toBe(0);
    context.particleCount = 1;
    cadence.reset();
    storage.view[STRIDE_INDEXES.DEAD] = 1;
    context.tick = 4;
    cadence.scanDeaths();
    expect(lineageEngine.totalDeaths).toBe(1);
    expect(lineageEngine.events.at(-1)).toMatchObject({ type: 'death', particleId: 0, cause: 'unknown' });
    context.particleCount = 0;
    expect(cadence.getMetrics().populationAlive).toBe(0);
  });

  it('skips frame work while the worker owns the buffer and contains pass errors', () => {
    const { cadence, context } = makeCadence();
    const update = vi.fn(() => { throw new Error('test failure'); });
    context.tickInFlight.mockReturnValue(true);
    cadence.run(update);
    expect(update).not.toHaveBeenCalled();
    context.tickInFlight.mockReturnValue(false);
    cadence.run(update);
    expect(context.onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'test failure' }));
  });
});
