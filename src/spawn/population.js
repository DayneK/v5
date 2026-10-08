/**
 * VEPA4 — population lifecycle (DECOMPOSITION_PLAN P4, step 2).
 *
 * Population state stays in the app; this factory receives the live context
 * through getters/setters so spawn operations do not capture stale snapshots.
 */
import {
  PARTICLE_STRIDE, MAX_PARTICLES, MAX_SPECIES, STRIDE_INDEXES,
  DNA_INDEXES, DNA_RANGES,
} from '../constants.js';
import {
  setX, setY, setVelocity, setMass, setSpeciesId, setEnergy,
} from '../state/particleBuffer.js';
import { getDNAFloat } from '../dna/dnaBuffer.js';
import { quantizeDNA } from '../dna/codec.js';
import {
  sampleSpawnPosition, buildSpawnCentres, initialPopulationTarget,
  perSpeciesAllocation,
} from './distribution.js';
import { spawnCaps } from '../state/worldParams.js';
import { trackBirth } from '../engines/lineageTracker.js';

const EXTRA_SPECIES_COLORS = [
  [120, 160, 255], [255, 140, 60], [180, 255, 120], [255, 120, 220],
  [120, 255, 220], [240, 220, 100], [160, 120, 255], [255, 160, 160],
];

const LEGACY_PROFILE_KEYS = Object.freeze({
  force: 'FORCE', viscosity: 'VISCOSITY', birthRate: 'BIRTH_RATE',
  predationBias: 'PREDATION_BIAS', fusion: 'FUSION', mutation: 'MUTATION',
  signalResp: 'SIGNAL_RESP', pulseRate: 'PULSE_RATE', deathRate: 'DEATH_RATE',
  hiddenMass: 'HIDDEN_MASS',
});

export function createPopulationManager(ctx) {
  function profileColor(species) {
    const profile = ctx.speciesProfiles[species];
    return profile ? profile.color : EXTRA_SPECIES_COLORS[species % EXTRA_SPECIES_COLORS.length];
  }

  function setDNAFromProfile(species, profile) {
    for (const [key, value] of Object.entries(profile)) {
      const dnaKey = DNA_INDEXES[key] !== undefined ? key : LEGACY_PROFILE_KEYS[key];
      if (!dnaKey) continue;
      const paramIdx = DNA_INDEXES[dnaKey];
      if (paramIdx === undefined) continue;
      const range = DNA_RANGES[paramIdx];
      ctx.dnaBuffer[species * 64 + paramIdx] = quantizeDNA(value, range.min, range.max);
    }
  }

  function spawnSingleParticle(species, pos) {
    if (ctx.workerTickInFlight()) return;
    if (ctx.particleCount >= MAX_PARTICLES) return;
    const idx = ctx.particleCount;
    const ptr = idx * PARTICLE_STRIDE;
    setX(ctx.particleBuffer, idx, PARTICLE_STRIDE, pos.x);
    setY(ctx.particleBuffer, idx, PARTICLE_STRIDE, pos.y);
    ctx.particleView[ptr + STRIDE_INDEXES.POS_Z] = pos.z;
    setVelocity(ctx.particleBuffer, idx, PARTICLE_STRIDE, 0, 0, 0);
    setMass(ctx.particleBuffer, idx, PARTICLE_STRIDE, 1.0 + ctx.prng.nextFloat(0, 1.0));
    setSpeciesId(ctx.particleBuffer, idx, PARTICLE_STRIDE, species);
    setEnergy(ctx.particleBuffer, idx, PARTICLE_STRIDE, 50 + ctx.prng.nextFloat(0, 50));
    for (let d = 0; d < 42; d++) {
      const range = DNA_RANGES[d] || { min: -1, max: 1 };
      ctx.particleView[ptr + STRIDE_INDEXES.DNA_CACHE_START + d] = getDNAFloat(ctx.dnaBuffer, species, d, range.min, range.max);
    }
    const profile = ctx.speciesProfiles[species] || ctx.speciesProfiles[0];
    ctx.particleView[ptr + STRIDE_INDEXES.COLOR_R] = profile.color[0];
    ctx.particleView[ptr + STRIDE_INDEXES.COLOR_G] = profile.color[1];
    ctx.particleView[ptr + STRIDE_INDEXES.COLOR_B] = profile.color[2];
    ctx.particleView[ptr + STRIDE_INDEXES.DEAD] = 0;
    ctx.particleView[ptr + STRIDE_INDEXES.AGE] = 0;
    ctx.particleView[ptr + STRIDE_INDEXES.SIGNAL] = 0;
    ctx.particleView[ptr + STRIDE_INDEXES.BOND_COUNT] = 0;
    ctx.particleView[ptr + STRIDE_INDEXES.BOND_PARTNER_1] = -1;
    ctx.particleView[ptr + STRIDE_INDEXES.BOND_PARTNER_2] = -1;
    ctx.particleView[ptr + STRIDE_INDEXES.BOND_PARTNER_3] = -1;
    ctx.particleView[ptr + STRIDE_INDEXES.BOND_PARTNER_4] = -1;
    ctx.particleView[ptr + STRIDE_INDEXES.BOND_PARTNER_5] = -1;
    ctx.particleView[ptr + STRIDE_INDEXES.BOND_PARTNER_6] = -1;
    ctx.particleView[ptr + STRIDE_INDEXES.ACCR_LINK_MASK] = 0;
    ctx.particleView[ptr + STRIDE_INDEXES.MEMORY] = 0;
    ctx.particleView[ptr + STRIDE_INDEXES.HUNGER] = 0;
    ctx.particleView[ptr + STRIDE_INDEXES.ARMOR] = ctx.prng.nextFloat(0, 0.5);
    ctx.particleView[ptr + STRIDE_INDEXES.MITOSIS_TIMER] = 0;
    ctx.particleView[ptr + STRIDE_INDEXES.PARTNER_ID] = -1;
    ctx.particleView[ptr + STRIDE_INDEXES.TEMPERATURE] = 0.5;
    ctx.particleView[ptr + STRIDE_INDEXES.CHARGE] = 0;
    ctx.particleView[ptr + STRIDE_INDEXES.ALPHA] = 0.8;
    ctx.particleView[ptr + STRIDE_INDEXES.RADIUS] = 0.6;
    ctx.particleView[ptr + STRIDE_INDEXES.ENTANGLE_ID] = -1;
    ctx.particleView[ptr + STRIDE_INDEXES.ENTANGLE_PHASE] = 0;
    ctx.setParticleCount(ctx.particleCount + 1);
  }

  function spawnDefaultPopulation(preserveDNA = false, keepSpecies = false) {
    const profiles = ctx.speciesProfiles;
    if (!keepSpecies) ctx.speciesCount = Math.min(profiles.length, MAX_SPECIES);
    let idx = 0;
    const caps = spawnCaps(ctx.worldParams);
    const totalTarget = initialPopulationTarget(ctx.worldParams, caps);
    const perSpecies = perSpeciesAllocation(totalTarget, ctx.speciesCount);
    const groundH = Math.max(0, Math.min(1, ctx.worldParams.GROUND_HEIGHT));

    for (let species = 0; species < ctx.speciesCount; species++) {
      const profile = profiles[species] || null;
      if (profile && !preserveDNA) setDNAFromProfile(species, profile);
      const gridDim = Math.max(2, Math.ceil(Math.cbrt(perSpecies)));
      const cellSize = (ctx.worldSize - 10) / gridDim;
      const centres = buildSpawnCentres(
        Math.max(1, Math.min(64, Math.round(ctx.worldParams.SPAWN_CENTRES) || 1)),
        ctx.worldParams.SPAWN_CENTRE_RANDOM,
        ctx.worldSize,
        ctx.prng,
      );

      for (let i = 0; i < perSpecies && idx < caps.hardCap; i++) {
        const ptr = idx * PARTICLE_STRIDE;
        const gx = i % gridDim;
        const gy = Math.floor(i / gridDim) % gridDim;
        const gz = Math.floor(i / (gridDim * gridDim));
        let px = 5 + gx * cellSize + cellSize * 0.5 + (ctx.prng.nextFloat(0, 1) - 0.5) * cellSize * 0.4;
        let py = 5 + gy * cellSize + cellSize * 0.5 + (ctx.prng.nextFloat(0, 1) - 0.5) * cellSize * 0.4;
        let pz = 5 + gz * cellSize + cellSize * 0.5 + (ctx.prng.nextFloat(0, 1) - 0.5) * cellSize * 0.4;
        if (ctx.worldParams.SHAPE > 0) {
          px += (ctx.prng.nextFloat(0, ctx.worldSize) - px) * ctx.worldParams.SHAPE;
          py += (ctx.prng.nextFloat(0, ctx.worldSize) - py) * ctx.worldParams.SHAPE;
          pz += (ctx.prng.nextFloat(0, ctx.worldSize) - pz) * ctx.worldParams.SHAPE;
        }
        if (ctx.worldParams.SPAWN_CENTRE_BIAS > 0 && centres.length > 0) {
          const centre = centres[Math.floor(ctx.prng.nextFloat(0, centres.length))];
          px += (centre.x - px) * ctx.worldParams.SPAWN_CENTRE_BIAS;
          py += (centre.y - py) * ctx.worldParams.SPAWN_CENTRE_BIAS;
          pz += (centre.z - pz) * ctx.worldParams.SPAWN_CENTRE_BIAS;
        }
        if (groundH < 1) pz = Math.min(pz, Math.max(0, ctx.worldSize * groundH));
        setX(ctx.particleBuffer, idx, PARTICLE_STRIDE, px);
        setY(ctx.particleBuffer, idx, PARTICLE_STRIDE, py);
        ctx.particleView[ptr + STRIDE_INDEXES.POS_Z] = pz;
        setVelocity(ctx.particleBuffer, idx, PARTICLE_STRIDE, 0, 0, 0);
        setMass(ctx.particleBuffer, idx, PARTICLE_STRIDE, 1.0 + ctx.prng.nextFloat(0, 1.0));
        setSpeciesId(ctx.particleBuffer, idx, PARTICLE_STRIDE, species);
        const founderEra = ctx.launchSettings?.founderEra || 'newborn';
        const age = founderEra === 'ancient' ? 420 + ctx.prng.nextFloat(0, 180)
          : founderEra === 'established' ? ctx.prng.nextFloat(80, 420) : 0;
        const energy = founderEra === 'ancient' ? 25 + ctx.prng.nextFloat(0, 55)
          : founderEra === 'established' ? 40 + ctx.prng.nextFloat(0, 70) : 50 + ctx.prng.nextFloat(0, 50);
        setEnergy(ctx.particleBuffer, idx, PARTICLE_STRIDE, energy);
        ctx.particleView[ptr + STRIDE_INDEXES.AGE] = age;
        const dnaBase = species * 64;
        for (let d = 0; d < 42; d++) {
          const raw = ctx.dnaBuffer[dnaBase + d] || 0;
          const norm = raw / 65535;
          const range = DNA_RANGES[d] || { min: -1, max: 1 };
          ctx.particleView[ptr + STRIDE_INDEXES.DNA_CACHE_START + d] = norm * (range.max - range.min) + range.min;
        }
        ctx.particleView[ptr + STRIDE_INDEXES.DEAD] = 0;
        ctx.particleView[ptr + STRIDE_INDEXES.AGE] = age;
        ctx.particleView[ptr + STRIDE_INDEXES.SIGNAL] = 0;
        ctx.particleView[ptr + STRIDE_INDEXES.BOND_COUNT] = 0;
        for (let bond = 1; bond <= 6; bond++) {
          ctx.particleView[ptr + STRIDE_INDEXES[`BOND_PARTNER_${bond}`]] = -1;
        }
        ctx.particleView[ptr + STRIDE_INDEXES.ACCR_LINK_MASK] = 0;
        ctx.particleView[ptr + STRIDE_INDEXES.MEMORY] = 0;
        ctx.particleView[ptr + STRIDE_INDEXES.HUNGER] = 0;
        ctx.particleView[ptr + STRIDE_INDEXES.ARMOR] = ctx.prng.nextFloat(0, 0.5);
        ctx.particleView[ptr + STRIDE_INDEXES.MITOSIS_TIMER] = 0;
        ctx.particleView[ptr + STRIDE_INDEXES.PARTNER_ID] = -1;
        ctx.particleView[ptr + STRIDE_INDEXES.TEMPERATURE] = 0.5;
        ctx.particleView[ptr + STRIDE_INDEXES.CHARGE] = 0;
        ctx.particleView[ptr + STRIDE_INDEXES.ELECTRIC_ENERGY] = 0;
        ctx.particleView[ptr + STRIDE_INDEXES.STORED_ENERGY] = 0;
        ctx.particleView[ptr + STRIDE_INDEXES.REPRO_DRIVE] = 0;
        ctx.particleView[ptr + STRIDE_INDEXES.RADIATION_EXPOSURE] = 0;
        ctx.particleView[ptr + STRIDE_INDEXES.PHASE_1] = 0;
        ctx.particleView[ptr + STRIDE_INDEXES.PHASE_2] = 0;
        ctx.particleView[ptr + STRIDE_INDEXES.SOUL] = 0;
        ctx.particleView[ptr + STRIDE_INDEXES.TRAIL_X] = 0;
        ctx.particleView[ptr + STRIDE_INDEXES.TRAIL_Y] = 0;
        ctx.particleView[ptr + STRIDE_INDEXES.TRAIL_Z] = 0;
        ctx.particleView[ptr + STRIDE_INDEXES.ENTANGLE_ID] = -1;
        ctx.particleView[ptr + STRIDE_INDEXES.ENTANGLE_PHASE] = 0;
        for (let d = 0; d < 42; d++) {
          ctx.particleView[ptr + STRIDE_INDEXES.DNA_CACHE_START + d] = getDNAFloat(
            ctx.dnaBuffer, species, d, DNA_RANGES[d].min, DNA_RANGES[d].max,
          );
        }
        const color = profileColor(species);
        ctx.particleView[ptr + STRIDE_INDEXES.COLOR_R] = color[0];
        ctx.particleView[ptr + STRIDE_INDEXES.COLOR_G] = color[1];
        ctx.particleView[ptr + STRIDE_INDEXES.COLOR_B] = color[2];
        ctx.particleView[ptr + STRIDE_INDEXES.ALPHA] = 0.8;
        ctx.particleView[ptr + STRIDE_INDEXES.RADIUS] = 0.6;
        idx++;
      }
    }
    ctx.setParticleCount(idx);
  }

  function spawnOffspring(offspring = null) {
    const list = offspring || ctx.drainOffspring();
    if (!list.length) return;
    for (const off of list) {
      if (ctx.particleCount >= MAX_PARTICLES) break;
      const ptr = ctx.particleCount * PARTICLE_STRIDE;
      setX(ctx.particleBuffer, ctx.particleCount, PARTICLE_STRIDE, off.x);
      setY(ctx.particleBuffer, ctx.particleCount, PARTICLE_STRIDE, off.y);
      ctx.particleView[ptr + STRIDE_INDEXES.POS_Z] = off.z || 0;
      setVelocity(ctx.particleBuffer, ctx.particleCount, PARTICLE_STRIDE, off.vx || 0, off.vy || 0, off.vz || 0);
      setMass(ctx.particleBuffer, ctx.particleCount, PARTICLE_STRIDE, off.mass || 1.0);
      setSpeciesId(ctx.particleBuffer, ctx.particleCount, PARTICLE_STRIDE, off.speciesId);
      setEnergy(ctx.particleBuffer, ctx.particleCount, PARTICLE_STRIDE, off.energy || 60);
      if (off.dna && off.dna.length) {
        for (let d = 0; d < 42 && d < off.dna.length; d++) {
          ctx.particleView[ptr + STRIDE_INDEXES.DNA_CACHE_START + d] = off.dna[d];
        }
      }
      ctx.particleView[ptr + STRIDE_INDEXES.DEAD] = 0;
      ctx.particleView[ptr + STRIDE_INDEXES.AGE] = 0;
      ctx.particleView[ptr + STRIDE_INDEXES.SIGNAL] = 0;
      ctx.particleView[ptr + STRIDE_INDEXES.BOND_COUNT] = 0;
      for (let bond = 1; bond <= 6; bond++) {
        ctx.particleView[ptr + STRIDE_INDEXES[`BOND_PARTNER_${bond}`]] = -1;
      }
      ctx.particleView[ptr + STRIDE_INDEXES.ACCR_LINK_MASK] = 0;
      ctx.particleView[ptr + STRIDE_INDEXES.MEMORY] = 0;
      ctx.particleView[ptr + STRIDE_INDEXES.HUNGER] = 0;
      ctx.particleView[ptr + STRIDE_INDEXES.ARMOR] = 0.2;
      ctx.particleView[ptr + STRIDE_INDEXES.MITOSIS_TIMER] = 0;
      ctx.particleView[ptr + STRIDE_INDEXES.PARTNER_ID] = -1;
      ctx.particleView[ptr + STRIDE_INDEXES.TEMPERATURE] = 0.5;
      ctx.particleView[ptr + STRIDE_INDEXES.CHARGE] = 0;
      ctx.particleView[ptr + STRIDE_INDEXES.SOUL] = 0;
      ctx.particleView[ptr + STRIDE_INDEXES.ENTANGLE_ID] = -1;
      ctx.particleView[ptr + STRIDE_INDEXES.ENTANGLE_PHASE] = 0;
      const profile = ctx.speciesProfiles[off.speciesId] || ctx.speciesProfiles[0];
      const color = profile ? profile.color : [200, 200, 200];
      ctx.particleView[ptr + STRIDE_INDEXES.COLOR_R] = off.colorR != null ? Math.max(0, Math.min(255, off.colorR)) : color[0];
      ctx.particleView[ptr + STRIDE_INDEXES.COLOR_G] = off.colorG != null ? Math.max(0, Math.min(255, off.colorG)) : color[1];
      ctx.particleView[ptr + STRIDE_INDEXES.COLOR_B] = off.colorB != null ? Math.max(0, Math.min(255, off.colorB)) : color[2];
      ctx.particleView[ptr + STRIDE_INDEXES.ALPHA] = 0.8;
      ctx.particleView[ptr + STRIDE_INDEXES.RADIUS] = 0.6;
      ctx.setParticleCount(ctx.particleCount + 1);
      if (ctx.lineageEngine) {
        trackBirth(ctx.lineageEngine, off.parentId != null ? off.parentId : -1, ctx.particleCount - 1, off.speciesId, 0);
      }
    }
  }

  function advancePopulation(offspring = null) {
    spawnOffspring(offspring);
    const caps = spawnCaps(ctx.worldParams);
    if (ctx.spawnRate > 0 && ctx.particleCount < caps.softCap) {
      let accumulator = ctx.spawnAccumulator;
      accumulator += ctx.spawnRate * (ctx.dt * ctx.simSpeed);
      while (accumulator >= 1 && ctx.particleCount < caps.softCap) {
        accumulator -= 1;
        spawnSingleParticle(
          Math.floor(ctx.prng.nextFloat(0, ctx.speciesCount)),
          sampleSpawnPosition(ctx.worldParams, ctx.worldSize, ctx.prng),
        );
      }
      ctx.setSpawnAccumulator(accumulator);
    }
  }

  return { profileColor, setDNAFromProfile, spawnSingleParticle, spawnDefaultPopulation, spawnOffspring, advancePopulation };

}
