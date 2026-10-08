/**
 * Gated approximation registry (RB decision D4).
 *
 * Proves the three locks (registered + accepted + enabled), per-law opt-in,
 * exact-by-default fallback, the untouchable cpu-exact reference, and the
 * evidence/tolerance schema that every gate must carry.
 */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  APPROXIMATION_REGISTRY_SCHEMA,
  APPROXIMATIONS,
  SOLVER_STAGES,
  COMPUTE_BACKENDS,
  DETERMINISM_CLASSES,
  validateApproximationRegistry,
  stageGate,
  lawPlan,
  gateStatus,
  resolveGravityBackend,
} from '../../src/physics/approximations.js';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

const LAWS = ['GRAV', 'PLANETARY', 'ACCR', 'DRAG'];

describe('approximation registry — schema', () => {
  it('declares a versioned schema and stable enums', () => {
    expect(APPROXIMATION_REGISTRY_SCHEMA).toBe('vepa-approximations/v1');
    expect(SOLVER_STAGES).toContain('gravity');
    expect(COMPUTE_BACKENDS).toContain('cpu-exact');
    expect(DETERMINISM_CLASSES).toContain('statistical');
  });

  it('the shipped registry validates with zero issues', () => {
    expect(validateApproximationRegistry()).toEqual([]);
  });

  it('every gate names an existing evidence path', () => {
    for (const gate of APPROXIMATIONS) {
      expect(existsSync(join(ROOT, gate.evidence)), `${gate.id}: ${gate.evidence}`).toBe(true);
    }
  });

  it('rejects malformed gates: duplicate ids, unknown stage/backend, bad tolerances, missing evidence', () => {
    const base = {
      id: 'x', stage: 'gravity', backend: 'cpu-bh', status: 'accepted',
      determinism: 'deterministic', description: 'd', laws: { GRAV: 0.01 }, evidence: 'bench/solver.bench.mjs',
    };
    expect(validateApproximationRegistry([base, { ...base }])).toEqual([expect.stringContaining('duplicate id')]);
    expect(validateApproximationRegistry([{ ...base, stage: 'nonsense' }])).toEqual([expect.stringContaining('unknown stage')]);
    expect(validateApproximationRegistry([{ ...base, backend: 'cuda' }])).toEqual([expect.stringContaining('unknown backend')]);
    expect(validateApproximationRegistry([{ ...base, laws: { GRAV: 1.5 } }])).toEqual([expect.stringContaining('tolerance')]);
    expect(validateApproximationRegistry([{ ...base, laws: { GRAV: 0 } }])).toEqual([expect.stringContaining('tolerance')]);
    expect(validateApproximationRegistry([{ ...base, evidence: '  ' }])).toEqual([expect.stringContaining('missing evidence')]);
    expect(validateApproximationRegistry([{ ...base, determinism: 'vibes' }])).toEqual([expect.stringContaining('determinism')]);
    expect(validateApproximationRegistry([{ ...base, laws: {} }])).toEqual([expect.stringContaining('at least one law')]);
  });

  it('refuses to let the cpu-exact reference be declared approximate', () => {
    const entry = {
      id: 'sneaky', stage: 'gravity', backend: 'cpu-exact', status: 'accepted',
      determinism: 'deterministic', description: 'd', laws: { GRAV: 0.5 }, evidence: 'x',
    };
    const issues = validateApproximationRegistry([entry]);
    expect(issues.some((i) => i.includes('cpu-exact reference backend can never declare approximations'))).toBe(true);
  });

  it('statistical/chaotic gates must ship sample-count evidence', () => {
    const entry = {
      id: 'stat', stage: 'gravity', backend: 'cpu-bh', status: 'accepted',
      determinism: 'statistical', description: 'd', laws: { GRAV: 0.01 }, evidence: 'bench/solver.bench.mjs',
    };
    expect(validateApproximationRegistry([entry])).toEqual([
      expect.stringContaining('statistical evidence'),
    ]);
    expect(validateApproximationRegistry([
      { ...entry, statistical: { seedRuns: 20, maxDivergence: 0.01 } },
    ])).toEqual([]);
  });
});

describe('approximation registry — gating rules', () => {
  it('cpu-exact reference always runs exact, even with gates enabled', () => {
    expect(stageGate('gravity', 'cpu-exact', { enabled: ['gravity-barnes-hut'] })).toBeNull();
    const plan = lawPlan('gravity', 'cpu-exact', LAWS, { enabled: ['gravity-barnes-hut'] });
    for (const law of LAWS) expect(plan[law]).toEqual({ mode: 'exact', tolerance: null, gate: null });
  });

  it('unregistered stage+backend pairs run exact (no gate ⇒ no approximation)', () => {
    expect(stageGate('pairwise', 'gpu')).toBeNull();
    expect(stageGate('integration', 'remote')).toBeNull();
    expect(stageGate('nope', 'gpu')).toBeNull();
    const plan = lawPlan('pairwise', 'gpu', LAWS);
    for (const law of LAWS) expect(plan[law].mode).toBe('exact');
  });

  it('requires all three locks: registered + accepted + explicitly enabled', () => {
    // registered but experimental ⇒ inert
    expect(stageGate('gravity', 'cpu-bh', { enabled: ['gravity-barnes-hut'] })).toBeNull();
    // registered, accepted, but not enabled ⇒ inert
    expect(stageGate('gravity', 'gpu')).toBeNull();
    // accepted + enabled ⇒ active
    const gate = stageGate('gravity', 'gpu', { enabled: ['gravity-gpu-prepass'] });
    expect(gate?.id).toBe('gravity-gpu-prepass');
    // enabling an id that does not match the stage/backend does nothing
    expect(stageGate('gravity', 'gpu', { enabled: ['gravity-fmm'] })).toBeNull();
  });

  it('applies per-law opt-in: listed laws approximate within tolerance, the rest stay exact', () => {
    const plan = lawPlan('gravity', 'cpu-bh', LAWS, { enabled: ['gravity-bh-never'] }); // not accepted
    expect(plan.GRAV.mode).toBe('exact');

    // Use a locally accepted copy to exercise the plan logic itself.
    const accepted = APPROXIMATIONS.map((e) => (e.id === 'gravity-barnes-hut' ? { ...e, status: 'accepted' } : e));
    const active = lawPlan('gravity', 'cpu-bh', LAWS, { enabled: ['gravity-barnes-hut'], entries: accepted });
    expect(active.GRAV).toEqual({ mode: 'approx', tolerance: 0.02, gate: 'gravity-barnes-hut' });
    expect(active.PLANETARY).toEqual({ mode: 'approx', tolerance: 0.03, gate: 'gravity-barnes-hut' });
    expect(active.ACCR).toEqual({ mode: 'approx', tolerance: 0.05, gate: 'gravity-barnes-hut' });
    expect(active.DRAG, 'laws outside the gate stay exact').toEqual({ mode: 'exact', tolerance: null, gate: null });
  });

  it('gateStatus reports the lock state without activating anything', () => {
    expect(gateStatus('gravity', 'cpu-bh', { enabled: ['gravity-barnes-hut'] })).toEqual({
      registered: true, status: 'experimental', enabled: true, active: false, gate: 'gravity-barnes-hut',
    });
    expect(gateStatus('gravity', 'gpu')).toEqual({
      registered: true, status: 'accepted', enabled: false, active: false, gate: 'gravity-gpu-prepass',
    });
    expect(gateStatus('fields', 'gpu')).toEqual({
      registered: false, status: null, enabled: false, active: false, gate: null,
    });
  });

  it('resolves requested Barnes–Hut/FMM engines only through active gravity gates and law plans', () => {
    const accepted = APPROXIMATIONS.map((entry) => ({ ...entry, status: 'accepted' }));
    for (const [engine, backend, gate] of [
      ['bh', 'cpu-bh', 'gravity-barnes-hut'],
      ['fmm', 'cpu-fmm', 'gravity-fmm'],
    ]) {
      const resolution = resolveGravityBackend(engine, { entries: accepted, enabled: [gate] });
      expect(resolution).toMatchObject({ requestedBackend: backend, backend, gate });
      expect(resolution.plan.GRAV).toMatchObject({ mode: 'approx', gate });
    }
  });

  it('resolves any unaccepted, disabled, or unlisted requested gravity law to exact CPU', () => {
    const bhGate = APPROXIMATIONS.find((entry) => entry.id === 'gravity-barnes-hut');
    const acceptedButUnlisted = { ...bhGate, status: 'accepted', laws: { PLANETARY: 0.03 } };
    for (const options of [
      { enabled: ['gravity-barnes-hut'] },
      { entries: [{ ...bhGate, status: 'accepted' }] },
      { entries: [acceptedButUnlisted], enabled: ['gravity-barnes-hut'] },
    ]) {
      expect(resolveGravityBackend('bh', options).backend).toBe('cpu-exact');
      expect(resolveGravityBackend('bh', options).plan.GRAV.mode).toBe('exact');
    }
  });

  it('is pure: the shipped registry is frozen and never mutated by queries', () => {
    expect(Object.isFrozen(APPROXIMATIONS)).toBe(true);
    const before = JSON.stringify(APPROXIMATIONS);
    stageGate('gravity', 'gpu', { enabled: ['gravity-gpu-prepass'] });
    lawPlan('gravity', 'gpu', LAWS, { enabled: ['gravity-gpu-prepass'] });
    resolveGravityBackend('bh', { enabled: ['gravity-barnes-hut'] });
    expect(JSON.stringify(APPROXIMATIONS)).toBe(before);
  });
});
