import { describe, it, expect } from 'vitest';
import {
  CONTROL_PROFILE_SCHEMA,
  WORLD_EASY_GROUPS,
  SPECIES_EASY_GROUPS,
  validateControlProfile,
  getEasyGroup,
  previewWorldEasy,
  applyWorldEasy,
  projectWorldEasy,
  previewSpeciesEasy,
  applySpeciesEasy,
  projectSpeciesEasy,
} from '../../src/state/controlProfile.js';
import { createWorldParams, worldParamDef } from '../../src/state/worldParams.js';
import {
  CONTROL_MODE_STORAGE_KEY,
  normalizeControlMode,
  readControlModes,
  writeControlMode,
} from '../../src/state/controlMode.js';
import { DNA_RANGES, DNA_INDEXES, DNA_COUNT, MAX_SPECIES } from '../../src/constants.js';
import { setDNAFloat } from '../../src/dna/dnaBuffer.js';

function fakeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    _map: map,
  };
}

function defaultDnaBuffer() {
  const buf = new Uint16Array(DNA_COUNT * MAX_SPECIES);
  for (let s = 0; s < MAX_SPECIES; s++) {
    for (let i = 0; i < DNA_COUNT; i++) {
      const r = DNA_RANGES[i];
      const norm = (r.default - r.min) / (r.max - r.min);
      buf[s * DNA_COUNT + i] = Math.round(norm * 65535);
    }
  }
  return buf;
}

describe('ControlProfile schema — declaration validity', () => {
  it('declares a versioned schema', () => {
    expect(CONTROL_PROFILE_SCHEMA).toBe('vepa-control-profile/v1');
  });

  it('validateControlProfile() reports zero issues', () => {
    expect(validateControlProfile()).toEqual([]);
  });

  it('covers the approved recipe set (5 world / 6 species composites)', () => {
    expect(WORLD_EASY_GROUPS.length).toBeGreaterThanOrEqual(5);
    expect(SPECIES_EASY_GROUPS.length).toBe(6);
    const speciesIds = SPECIES_EASY_GROUPS.map((g) => g.id).sort();
    expect(speciesIds).toEqual(['appearance', 'metabolism', 'motion', 'reproduction', 'resilience', 'signaling']);
  });

  it('every recipe writes only known canonical targets', () => {
    for (const g of WORLD_EASY_GROUPS) {
      for (const m of g.members) expect(worldParamDef(m.target), m.target).toBeTruthy();
    }
    for (const g of SPECIES_EASY_GROUPS) {
      for (const m of g.members) expect(DNA_INDEXES[m.target], m.target).not.toBeUndefined();
    }
  });

  it('discloses reset/reseed behavior for every recipe', () => {
    for (const g of [...WORLD_EASY_GROUPS, ...SPECIES_EASY_GROUPS]) {
      expect(g.effect, g.id).toBeTruthy();
      expect(g.label, g.id).toBeTruthy();
      expect(g.description, g.id).toBeTruthy();
    }
  });

  it('getEasyGroup resolves by surface + id and rejects unknown ids', () => {
    expect(getEasyGroup('world', 'motion')?.id).toBe('motion');
    expect(getEasyGroup('species', 'motion')?.id).toBe('motion');
    expect(getEasyGroup('world', 'nope')).toBeNull();
    expect(getEasyGroup('species', 'scale')).toBeNull();
  });
});

describe('World recipes — preview / apply', () => {
  it('preview is pure and deterministic', () => {
    const state = createWorldParams();
    const snapshot = JSON.stringify(state);
    const a = previewWorldEasy(state, 'motion', 0.42);
    const b = previewWorldEasy(state, 'motion', 0.42);
    expect(a).toEqual(b);
    expect(JSON.stringify(state)).toBe(snapshot);
  });

  it('preview lists exactly the declared members with before/after values', () => {
    const state = createWorldParams();
    const p = previewWorldEasy(state, 'life', 0.5);
    const members = getEasyGroup('world', 'life').members.map((m) => m.target).sort();
    expect(p.affected.slice().sort()).toEqual(members);
    expect(p.summary).toHaveLength(members.length);
    for (const s of p.summary) {
      expect(state[s.target]).toBeCloseTo(s.before, 10);
      expect(s.after).not.toBeCloseTo(s.before, 6); // midpoint moved every member
      const def = worldParamDef(s.target);
      expect(s.after).toBeGreaterThanOrEqual(def.min);
      expect(s.after).toBeLessThanOrEqual(def.max);
    }
  });

  it('apply writes only member keys — everything else is untouched', () => {
    const state = createWorldParams();
    const { next, affected } = applyWorldEasy(state, 'motion', 0.7);
    expect(next).not.toBe(state);
    for (const key of Object.keys(state)) {
      if (affected.includes(key)) continue;
      expect(next[key], key).toBe(state[key]);
    }
    const members = new Set(getEasyGroup('world', 'motion').members.map((m) => m.target));
    for (const key of affected) expect(members.has(key)).toBe(true);
    for (const key of affected) expect(next[key]).not.toBe(state[key]);
  });

  it('clamps t (including NaN) into [0, 1]', () => {
    const state = createWorldParams();
    const at1 = applyWorldEasy(state, 'environment', 1);
    expect(applyWorldEasy(state, 'environment', 5).changes).toEqual(at1.changes);
    expect(applyWorldEasy(state, 'environment', -3).changes).toEqual(
      applyWorldEasy(state, 'environment', 0).changes
    );
    expect(applyWorldEasy(state, 'environment', NaN).changes).toEqual(
      applyWorldEasy(state, 'environment', 0).changes
    );
  });

  it('apply → project round-trips every recipe at many positions', () => {
    const state = createWorldParams();
    for (const g of WORLD_EASY_GROUPS) {
      for (const t of [0, 0.25, 0.5, 0.75, 1]) {
        const { next } = applyWorldEasy(state, g.id, t);
        const proj = projectWorldEasy(next, g.id);
        expect(proj.t, `${g.id}@${t}`).toBeCloseTo(t, 9);
        expect(proj.customized, `${g.id}@${t}`).toBe(false);
      }
    }
  });

  it('a first-run default world never looks customized', () => {
    const state = createWorldParams();
    for (const g of WORLD_EASY_GROUPS) {
      const proj = projectWorldEasy(state, g.id);
      expect(proj.customized, g.id).toBe(false);
      // Defaults anchor at t=0 except the caps recipe (stock world runs at cap).
      if (g.id === 'population') expect(proj.t, g.id).toBeCloseTo(1, 6);
      else expect(proj.t, g.id).toBeCloseTo(0, 3);
    }
  });

  it('flags an Advanced single-parameter edit as customized', () => {
    const state = createWorldParams();
    const { next } = applyWorldEasy(state, 'motion', 0.5);
    expect(projectWorldEasy(next, 'motion').customized).toBe(false);
    // Advanced slider edit: one step of GLOBAL_G (step 1 over range 0..20).
    const edited = { ...next, GLOBAL_G: next.GLOBAL_G + 2 };
    const proj = projectWorldEasy(edited, 'motion');
    expect(proj.customized).toBe(true);
    expect(proj.members.find((m) => m.target === 'GLOBAL_G').delta).toBeGreaterThan(0.008);
  });

  it('flags an out-of-span Advanced value as customized', () => {
    const state = createWorldParams();
    const { next } = applyWorldEasy(state, 'environment', 0.5);
    // Advanced pushed LIGHT_LEVEL (recipe span caps at 0.75 normalized) higher.
    const def = worldParamDef('LIGHT_LEVEL');
    const edited = { ...next, LIGHT_LEVEL: def.min + 0.95 * (def.max - def.min) };
    const proj = projectWorldEasy(edited, 'environment');
    expect(proj.customized).toBe(true);
    expect(proj.members.find((m) => m.target === 'LIGHT_LEVEL').outOfSpan).toBe(true);
  });

  it('edits to non-member parameters never flag a recipe', () => {
    const state = createWorldParams();
    const { next } = applyWorldEasy(state, 'motion', 0.5);
    const edited = { ...next, SPAWN_RATE: 87 }; // SPAWN_RATE belongs to `life`
    expect(projectWorldEasy(edited, 'motion').customized).toBe(false);
  });
});

describe('Species recipes — preview / apply / project', () => {
  it('default genome projects every recipe to t≈0, not customized', () => {
    const dna = defaultDnaBuffer();
    for (const g of SPECIES_EASY_GROUPS) {
      const proj = projectSpeciesEasy(dna, 0, g.id);
      expect(proj.t, g.id).toBeCloseTo(0, 3);
      expect(proj.customized, g.id).toBe(false);
    }
  });

  it('apply writes only member DNA params', () => {
    const dna = defaultDnaBuffer();
    const before = Uint16Array.from(dna);
    const { affected } = applySpeciesEasy(dna, 0, 'reproduction', 0.6);
    const members = new Set(getEasyGroup('species', 'reproduction').members.map((m) => DNA_INDEXES[m.target]));
    expect(affected.slice().sort()).toEqual([...members].sort());
    for (let i = 0; i < dna.length; i++) {
      const otherSpecies = Math.floor(i / DNA_COUNT) !== 0;
      const isMember = members.has(i % DNA_COUNT);
      if (otherSpecies || !isMember) expect(dna[i], `idx ${i}`).toBe(before[i]);
      else expect(dna[i], `idx ${i}`).not.toBe(before[i]);
    }
  });

  it('apply → project round-trips within DNA quantization error', () => {
    const dna = defaultDnaBuffer();
    for (const g of SPECIES_EASY_GROUPS) {
      for (const t of [0.2, 0.55, 0.9]) {
        applySpeciesEasy(dna, 3, g.id, t);
        const proj = projectSpeciesEasy(dna, 3, g.id);
        expect(proj.t, `${g.id}@${t}`).toBeCloseTo(t, 3);
        expect(proj.customized, `${g.id}@${t}`).toBe(false);
      }
    }
  });

  it('recipes are per-species — other species genomes never move', () => {
    const dna = defaultDnaBuffer();
    const snapshot = Uint16Array.from(dna);
    applySpeciesEasy(dna, 2, 'motion', 0.8);
    const stride = DNA_COUNT;
    for (let s = 0; s < MAX_SPECIES; s++) {
      if (s === 2) continue;
      for (let i = 0; i < stride; i++) {
        expect(dna[s * stride + i], `species ${s}`).toBe(snapshot[s * stride + i]);
      }
    }
  });

  it('flags an Advanced trait edit as customized', () => {
    const dna = defaultDnaBuffer();
    applySpeciesEasy(dna, 1, 'motion', 0.5);
    expect(projectSpeciesEasy(dna, 1, 'motion').customized).toBe(false);
    // Advanced slider edit on FORCE only (several slider steps worth).
    const range = DNA_RANGES[DNA_INDEXES.FORCE];
    const currentNorm = dna[1 * DNA_COUNT + DNA_INDEXES.FORCE] / 65535;
    const advancedNorm = Math.min(1, currentNorm + 0.05);
    setDNAFloat(
      dna, 1, DNA_INDEXES.FORCE,
      range.min + advancedNorm * (range.max - range.min),
      range.min, range.max
    );
    const proj = projectSpeciesEasy(dna, 1, 'motion');
    expect(proj.customized).toBe(true);
  });

  it('previewSpeciesEasy does not write DNA', () => {
    const dna = defaultDnaBuffer();
    const snapshot = Uint16Array.from(dna);
    previewSpeciesEasy(dna, 0, 'signaling', 0.7);
    expect(dna).toEqual(snapshot);
  });
});

describe('Control mode store', () => {
  it('normalizeControlMode coerces everything unknown to easy', () => {
    expect(normalizeControlMode('easy')).toBe('easy');
    expect(normalizeControlMode('advanced')).toBe('advanced');
    expect(normalizeControlMode('EASY')).toBe('easy');
    expect(normalizeControlMode(undefined)).toBe('easy');
    expect(normalizeControlMode('yes')).toBe('easy');
  });

  it('defaults both surfaces to easy on first run', () => {
    expect(readControlModes(fakeStorage())).toEqual({ world: 'easy', species: 'easy' });
  });

  it('persists one surface independently of the other', () => {
    const store = fakeStorage();
    writeControlMode('world', 'advanced', store);
    expect(readControlModes(store)).toEqual({ world: 'advanced', species: 'easy' });
    writeControlMode('species', 'advanced', store);
    expect(readControlModes(store)).toEqual({ world: 'advanced', species: 'advanced' });
    writeControlMode('world', 'easy', store);
    expect(readControlModes(store)).toEqual({ world: 'easy', species: 'advanced' });
    expect(store._map.get(CONTROL_MODE_STORAGE_KEY)).toBeTruthy();
  });

  it('survives corrupt or hostile stored values', () => {
    expect(readControlModes(fakeStorage({ [CONTROL_MODE_STORAGE_KEY]: '{not json' }))).toEqual({ world: 'easy', species: 'easy' });
    expect(readControlModes(fakeStorage({ [CONTROL_MODE_STORAGE_KEY]: JSON.stringify({ world: 'banana' }) }))).toEqual({ world: 'easy', species: 'easy' });
    expect(readControlModes(fakeStorage({ [CONTROL_MODE_STORAGE_KEY]: '42' }))).toEqual({ world: 'easy', species: 'easy' });
  });

  it('ignores unknown surfaces without corrupting stored state', () => {
    const store = fakeStorage();
    writeControlMode('world', 'advanced', store);
    const result = writeControlMode('laws', 'advanced', store);
    expect(result).toEqual({ world: 'advanced', species: 'easy' });
    expect(readControlModes(store)).toEqual({ world: 'advanced', species: 'easy' });
  });

  it('storage that throws degrades to easy defaults', () => {
    const throwing = {
      getItem() { throw new Error('denied'); },
      setItem() { throw new Error('denied'); },
    };
    expect(readControlModes(throwing)).toEqual({ world: 'easy', species: 'easy' });
    expect(writeControlMode('world', 'advanced', throwing)).toEqual({ world: 'advanced', species: 'easy' });
  });
});
