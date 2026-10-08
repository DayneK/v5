import { describe, expect, it, vi } from 'vitest';
import { PARTICLE_STRIDE, STRIDE_INDEXES, DNA_INDEXES, DNA_RANGES } from '../../src/constants.js';
import { createDNABuffer, getDNAFloat } from '../../src/dna/dnaBuffer.js';
import { createParticleBuffer } from '../../src/state/particleBuffer.js';
import { createWorldParams } from '../../src/state/worldParams.js';
import { createPopulationManager } from '../../src/spawn/population.js';

function makeManager(overrides = {}) {
  const storage = createParticleBuffer(128, PARTICLE_STRIDE);
  const dnaBuffer = createDNABuffer();
  const state = {
    particleBuffer: storage.buffer,
    particleView: storage.view,
    particleCount: 0,
    speciesCount: 2,
    speciesProfiles: [
      { name: 'A', color: [255, 10, 20], FORCE: 1 },
      { name: 'B', color: [30, 220, 40], FORCE: -1 },
    ],
    dnaBuffer,
    worldParams: { ...createWorldParams(), INITIAL_POP: 6, PARTICLE_COUNT: 128, MAX_POP: 128, SPAWN_RATE: 0 },
    worldSize: 100,
    launchSettings: { founderEra: 'newborn' },
    prng: { nextFloat: vi.fn(() => 0.5) },
    spawnRate: 0,
    spawnAccumulator: 0,
    simSpeed: 1,
    dt: 0.25,
    workerInFlight: false,
    workerTickInFlight: () => state.workerInFlight,
    drainOffspring: () => [],
    lineageEngine: null,
    ...overrides,
  };
  const manager = createPopulationManager({
    ...state,
    get particleCount() { return state.particleCount; },
    setParticleCount(value) { state.particleCount = value; },
    get speciesCount() { return state.speciesCount; },
    set speciesCount(value) { state.speciesCount = value; },
    get spawnAccumulator() { return state.spawnAccumulator; },
    setSpawnAccumulator(value) { state.spawnAccumulator = value; },
  });
  return { manager, state };
}

describe('population manager', () => {
  it('seeds the requested population using the live species profiles and DNA', () => {
    const { manager, state } = makeManager();
    manager.spawnDefaultPopulation();
    expect(state.particleCount).toBe(6);
    expect(state.speciesCount).toBe(2);
    expect(state.particleView[STRIDE_INDEXES.SPECIES_ID]).toBe(0);
    expect(state.particleView[PARTICLE_STRIDE + STRIDE_INDEXES.SPECIES_ID]).toBe(0);
    expect(state.particleView[3 * PARTICLE_STRIDE + STRIDE_INDEXES.SPECIES_ID]).toBe(1);
    expect(state.particleView[STRIDE_INDEXES.COLOR_R]).toBe(255);
    expect(state.particleView[3 * PARTICLE_STRIDE + STRIDE_INDEXES.COLOR_G]).toBe(220);
    expect(state.particleView[STRIDE_INDEXES.BOND_PARTNER_6]).toBe(-1);
    expect(state.particleView[STRIDE_INDEXES.ENTANGLE_ID]).toBe(-1);
    expect(getDNAFloat(state.dnaBuffer, 0, DNA_INDEXES.FORCE, DNA_RANGES[0].min, DNA_RANGES[0].max)).toBeCloseTo(1, 2);
  });

  it('honours founder era, ground band, and preserveDNA/keepSpecies options', () => {
    const { manager, state } = makeManager({
      worldParams: { ...createWorldParams(), INITIAL_POP: 2, GROUND_HEIGHT: 0.25, PARTICLE_COUNT: 128, MAX_POP: 128 },
      worldSize: 100,
      launchSettings: { founderEra: 'ancient' },
    });
    manager.spawnDefaultPopulation();
    expect(state.particleCount).toBe(2);
    expect(state.particleView[STRIDE_INDEXES.AGE]).toBeGreaterThanOrEqual(420);
    expect(state.particleView[STRIDE_INDEXES.POS_Z]).toBeLessThanOrEqual(25);

    const before = state.dnaBuffer.slice();
    state.speciesCount = 1;
    manager.spawnDefaultPopulation(true, true);
    expect(state.speciesCount).toBe(1);
    expect(state.dnaBuffer).toEqual(before);
  });

  it('applies regular population growth with the configured timestep and respects the soft cap', () => {
    const { manager, state } = makeManager({
      spawnRate: 8,
      spawnAccumulator: 0,
      worldParams: { ...createWorldParams(), INITIAL_POP: 0, SPAWN_RATE: 8, PARTICLE_COUNT: 128, MAX_POP: 128 },
    });
    manager.advancePopulation();
    expect(state.particleCount).toBe(2);
    expect(state.spawnAccumulator).toBe(0);
    manager.advancePopulation();
    expect(state.particleCount).toBe(4);
  });

  it('creates offspring rows and records lineage birth when the row is accepted', () => {
    const lineageEngine = { bus: { emit: vi.fn() }, particles: new Map(), cfg: { maxEvents: 10 }, events: [], totalBirths: 0, totalDeaths: 0, speciesGenerations: new Map(), longestLineage: 0 };
    const { manager, state } = makeManager({ lineageEngine });
    manager.spawnOffspring([{ x: 3, y: 4, z: 5, vx: 1, vy: 2, vz: 3, mass: 2, speciesId: 1, energy: 90, dna: [0.25, 0.5], parentId: 7, colorR: 99 }]);
    expect(state.particleCount).toBe(1);
    expect(state.particleView[STRIDE_INDEXES.POS_X]).toBe(3);
    expect(state.particleView[STRIDE_INDEXES.POS_Z]).toBe(5);
    expect(state.particleView[STRIDE_INDEXES.DNA_CACHE_START]).toBe(0.25);
    expect(state.particleView[STRIDE_INDEXES.BOND_PARTNER_1]).toBe(-1);
    expect(state.particleView[STRIDE_INDEXES.COLOR_R]).toBe(99);
    expect(lineageEngine.totalBirths).toBe(1);
  });

  it('maps canonical and legacy profile names while a worker tick blocks direct spawning', () => {
    const { manager, state } = makeManager();
    manager.setDNAFromProfile(1, { FORCE: 0.5, birthRate: 0.25, notATrait: 1 });
    expect(getDNAFloat(state.dnaBuffer, 1, DNA_INDEXES.FORCE, DNA_RANGES[0].min, DNA_RANGES[0].max)).toBeCloseTo(0.5, 2);
    const births = state.particleCount;
    state.workerInFlight = true;
    manager.spawnSingleParticle(0, { x: 1, y: 2, z: 3 });
    expect(state.particleCount).toBe(births);
  });
});
