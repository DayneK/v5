/**
 * VEPA4 — gated approximation registry (RB decision D4).
 *
 * Approximations (Barnes–Hut/FMM gravity, GPU pre-passes, remote statal
 * integrators) may only run through a declared gate:
 *
 *   - a gate names ONE solver stage and ONE backend;
 *   - it lists, per law, a parity tolerance against the exact CPU reference;
 *   - laws it does not list run EXACTLY on that backend+stage (opt-in per law);
 *   - a backend+stage with no registered, accepted, enabled gate runs
 *     EXACTLY — the exact CPU pairwise solver
 *     (`backend: 'cpu-exact'`) is the authoritative reference and can never
 *     itself be declared approximate;
 *   - every gate carries a determinism class and evidence (test/bench path).
 *
 * Pure data + pure functions — no DOM, no mutation, no side effects.
 */

export const APPROXIMATION_REGISTRY_SCHEMA = 'vepa-approximations/v1';

/** Solver pipeline stages a gate may attach to. */
export const SOLVER_STAGES = Object.freeze([
  'neighborhood',
  'gravity',
  'pairwise',
  'integration',
  'lifecycle',
  'fields',
]);

/** Compute backends a gate may target. 'cpu-exact' is the reference. */
export const COMPUTE_BACKENDS = Object.freeze([
  'cpu-exact',
  'cpu-bh',
  'cpu-fmm',
  'gpu',
  'remote',
]);

/** Determinism classes an approximation may declare. */
export const DETERMINISM_CLASSES = Object.freeze([
  'bit-exact',      // same inputs ⇒ same outputs (e.g. fixed-order GPU float math)
  'deterministic',  // reproducible per seed, may differ from reference
  'statistical',    // distribution-preserving, sample-count bounded
  'chaotic',        // diverges over horizon; only distributional claims hold
]);

/**
 * The registry. Entries are data: adding one is a reviewed change with an
 * evidence path, exactly like a parameter addition (D2).
 */
export const APPROXIMATIONS = Object.freeze([
  {
    id: 'gravity-gpu-prepass',
    stage: 'gravity',
    backend: 'gpu',
    status: 'accepted',
    determinism: 'bit-exact',
    description: 'WebGPU gravity force pre-pass; CPU remains authoritative for every other stage.',
    // Relative force error vs the CPU pairwise reference, asserted in e2e.
    laws: { GRAV: 1e-4 },
    statistical: null,
    evidence: 'tests/e2e/physics-worker.spec.js',
  },
  {
    id: 'gravity-barnes-hut',
    stage: 'gravity',
    backend: 'cpu-bh',
    status: 'experimental',
    determinism: 'statistical',
    description: 'Barnes–Hut tree gravity — O(n log n) walk; per-law parity bounded against exact CPU.',
    laws: { GRAV: 0.02, PLANETARY: 0.03, ACCR: 0.05 },
    statistical: { seedRuns: 20, maxDivergence: 0.01 },
    evidence: 'bench/solver.bench.mjs',
  },
  {
    id: 'gravity-fmm',
    stage: 'gravity',
    backend: 'cpu-fmm',
    status: 'experimental',
    determinism: 'statistical',
    description: 'Fast multipole method — proposed only; retained as experimental (AGENTS FMM decision).',
    laws: { GRAV: 0.02 },
    statistical: { seedRuns: 30, maxDivergence: 0.01 },
    evidence: 'bench/solver.bench.mjs',
  },
]);

const STAGE_SET = new Set(SOLVER_STAGES);
const BACKEND_SET = new Set(COMPUTE_BACKENDS);
const DETERMINISM_SET = new Set(DETERMINISM_CLASSES);

/**
 * Validate a registry.
 * @returns {string[]} issues; empty = valid.
 */
export function validateApproximationRegistry(entries = APPROXIMATIONS) {
  const issues = [];
  if (!Array.isArray(entries)) return ['registry must be an array'];
  const seen = new Set();
  for (const e of entries) {
    const where = e && e.id ? e.id : '<entry>';
    if (!e || typeof e !== 'object') { issues.push(`${where}: must be an object`); continue; }
    if (typeof e.id !== 'string' || !e.id) issues.push(`${where}: missing id`);
    else if (seen.has(e.id)) issues.push(`${where}: duplicate id`);
    else seen.add(e.id);
    if (!STAGE_SET.has(e.stage)) issues.push(`${where}: unknown stage "${e.stage}"`);
    if (!BACKEND_SET.has(e.backend)) issues.push(`${where}: unknown backend "${e.backend}"`);
    if (e.backend === 'cpu-exact') issues.push(`${where}: the cpu-exact reference backend can never declare approximations`);
    if (!['accepted', 'experimental'].includes(e.status)) issues.push(`${where}: status must be accepted|experimental`);
    if (!DETERMINISM_SET.has(e.determinism)) issues.push(`${where}: unknown determinism class "${e.determinism}"`);
    if (typeof e.description !== 'string' || !e.description.trim()) issues.push(`${where}: missing description`);
    if (typeof e.evidence !== 'string' || !e.evidence.trim()) issues.push(`${where}: missing evidence path`);
    if (!e.laws || typeof e.laws !== 'object' || Array.isArray(e.laws)) {
      issues.push(`${where}: laws must be an object of lawKey → tolerance`);
    } else {
      const lawKeys = Object.keys(e.laws);
      if (!lawKeys.length) issues.push(`${where}: gates must list at least one law (opt-in per law)`);
      for (const [law, tol] of Object.entries(e.laws)) {
        if (typeof law !== 'string' || !/^[A-Z][A-Z0-9_]*$/.test(law)) issues.push(`${where}: invalid law key "${law}"`);
        if (typeof tol !== 'number' || !(tol > 0) || !(tol <= 1)) issues.push(`${where}: tolerance for ${law} must be in (0, 1]`);
      }
    }
    if (e.statistical != null) {
      const s = e.statistical;
      if (typeof s !== 'object' || !Number.isInteger(s.seedRuns) || s.seedRuns < 2 ||
          typeof s.maxDivergence !== 'number' || !(s.maxDivergence > 0) || !(s.maxDivergence <= 1)) {
        issues.push(`${where}: statistical evidence must declare seedRuns ≥ 2 and maxDivergence in (0, 1]`);
      }
    } else if (e.determinism === 'statistical' || e.determinism === 'chaotic') {
      issues.push(`${where}: ${e.determinism} gates must ship statistical evidence (seedRuns, maxDivergence)`);
    }
  }
  return issues;
}

/**
 * Resolve the gate for one stage+backend, or null (⇒ exact execution).
 * A gate applies only when it is registered, `accepted`, and explicitly
 * enabled by the caller — three independent locks.
 *
 * @param {string} stage
 * @param {string} backend
 * @param {{ enabled?: string[], entries?: object[] }} [options]
 */
export function stageGate(stage, backend, { enabled = [], entries = APPROXIMATIONS } = {}) {
  if (!STAGE_SET.has(stage) || !BACKEND_SET.has(backend)) return null;
  if (backend === 'cpu-exact') return null;
  const entry = entries.find((e) => e.stage === stage && e.backend === backend);
  if (!entry || entry.status !== 'accepted') return null;
  if (!enabled.includes(entry.id)) return null;
  return entry;
}

/**
 * Per-law execution plan for a stage on a backend.
 *
 * @param {string} stage
 * @param {string} backend
 * @param {string[]} lawKeys laws the stage will evaluate
 * @param {{ enabled?: string[], entries?: object[] }} [options]
 * @returns {Record<string, { mode: 'exact'|'approx', tolerance: number|null, gate: string|null }>}
 */
export function lawPlan(stage, backend, lawKeys, options = {}) {
  const plan = {};
  const gate = stageGate(stage, backend, options);
  for (const law of lawKeys) {
    if (gate && Object.prototype.hasOwnProperty.call(gate.laws, law)) {
      plan[law] = { mode: 'approx', tolerance: gate.laws[law], gate: gate.id };
    } else {
      plan[law] = { mode: 'exact', tolerance: null, gate: null };
    }
  }
  return plan;
}

/**
 * Resolve the requested gravity engine through both the stage gate and its
 * per-law plan. Unapproved, unregistered, disabled, or unlisted gravity
 * approximations always resolve to the authoritative exact CPU backend.
 *
 * @param {'exact'|'bh'|'fmm'|string} engine
 * @param {{ enabled?: string[], entries?: object[] }} [options]
 * @returns {{ requestedBackend: string, backend: string, gate: string|null, plan: object }}
 */
export function resolveGravityBackend(engine, options = {}) {
  const requestedBackend = ({
    bh: 'cpu-bh',
    fmm: 'cpu-fmm',
  })[engine] || 'cpu-exact';
  const gate = stageGate('gravity', requestedBackend, options);
  const plan = lawPlan('gravity', requestedBackend, ['GRAV'], options);
  const enabled = gate !== null && plan.GRAV.mode === 'approx';
  return {
    requestedBackend,
    backend: enabled ? requestedBackend : 'cpu-exact',
    gate: enabled ? gate.id : null,
    plan,
  };
}

/** Summary of the three locks for diagnostics/UI. */
export function gateStatus(stage, backend, options = {}) {
  const { entries = APPROXIMATIONS, enabled = [] } = options;
  const entry = entries.find((e) => e.stage === stage && e.backend === backend) || null;
  return {
    registered: !!entry,
    status: entry ? entry.status : null,
    enabled: !!(entry && enabled.includes(entry.id)),
    active: !!stageGate(stage, backend, options),
    gate: entry ? entry.id : null,
  };
}
