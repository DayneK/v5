/**
 * VEPA4 — Easy Mode ControlProfile (schema `vepa-control-profile/v1`)
 *
 * An Easy Mode control is a *composite recipe*: one 0..1 slider that drives a
 * declared set of canonical targets (world params or species DNA traits)
 * through fixed anchors inside each target's canonical range.
 *
 * Every recipe declares, in code, exactly what the RB spec demands:
 *  - affected targets (`members[].target` — WORLD_PARAM_DEFS key / DNA name)
 *  - formula: `value(t) = range.min + (from + t·(to − from)) · (range.max − range.min)`
 *  - bounds: `from`/`to` anchors are normalized inside the canonical range and
 *    are validated by `validateControlProfile()`
 *  - units/labels: resolved from WORLD_PARAM_DEFS / DNA_META at render time
 *  - constraints: `t` and every value are clamped; nothing outside the
 *    declared members is ever written
 *  - reset/reseed behavior: `effect` is the human note surfaced in the UI
 *  - provenance: `CONTROL_PROFILE.schema` + group ids (stable, versioned)
 *  - reverse projection: `projectWorldEasy` / `projectSpeciesEasy` recover the
 *    slider position from current state and flag `customized` when Advanced
 *    edits (or out-of-span values) make the composite inconsistent
 *
 * Pure state module — no DOM, no events, no mutation of caller state
 * (species apply writes into the passed DNA buffer by design, mirroring
 * `setDNAFloat` semantics).
 */
import { DNA_RANGES, DNA_INDEXES, DNA_META } from '../constants.js';
import { worldParamDef, applyWorldParam } from './worldParams.js';
import { getDNAFloat, setDNAFloat } from '../dna/dnaBuffer.js';

export const CONTROL_PROFILE_SCHEMA = 'vepa-control-profile/v1';

/** Spread (in normalized t units) above which a group is flagged customized. */
export const CUSTOMIZED_SPREAD = { world: 0.008, species: 0.0008 };
/** Out-of-span slack (normalized) before a value counts as an Advanced push. */
export const SPAN_SLACK = 0.001;
/** Max allowed spread of default-projected t inside one group (validator). */
export const DEFAULT_CONSISTENCY = 1e-3;

const W = (target, from, to) => ({ target, from, to });
const D = (target, from, to) => ({ target, from, to });

/* ── World recipes (surface: world) ─────────────────────────────────────── */

// Anchors are normalized into each target's canonical range. Every recipe
// passes exactly through the canonical default (uniform default-projected t
// per group, enforced by validateControlProfile) so a first-run world always
// projects a clean slider position — never a false “customized” flag.
// `population` anchors defaults at t=1 (the stock world runs at its caps);
// every other recipe anchors defaults at t=0 and raises from there.
export const WORLD_EASY_GROUPS = [
  {
    id: 'scale',
    label: 'World scale',
    description: 'How big the dish is and how many particles it starts with.',
    effect: 'WORLD SIZE applies live; INITIAL POPULATION applies on the next restart.',
    members: [W('WORLD_SIZE', 0.09774436090225564, 0.42), W('INITIAL_POP', 0, 0.5)],
  },
  {
    id: 'population',
    label: 'Population caps',
    description: 'How many particles may live here (defaults sit at the cap).',
    effect: 'Live — caps apply to future spawns; restart to restock instantly.',
    members: [W('PARTICLE_COUNT', 0.1, 1), W('MAX_POP', 0.1, 1)],
  },
  {
    id: 'motion',
    label: 'Motion & forces',
    description: 'Raise gravity, wind and damping together from the defaults.',
    effect: 'Live — forces apply on the next tick.',
    members: [W('GLOBAL_G', 0.05, 0.3), W('WIND', 0, 0.6), W('DAMPING', 0, 0.6)],
  },
  {
    id: 'environment',
    label: 'Environment',
    description: 'Light, radiation and ambient entropy of the medium.',
    effect: 'Live — environment terms apply on the next tick.',
    members: [W('LIGHT_LEVEL', 0.25, 0.75), W('RADIATION_LEVEL', 0.2, 0.6), W('ENTROPY', 0.5, 0.9)],
  },
  {
    id: 'life',
    label: 'Life & flow',
    description: 'Mutation pressure, energy transfer, decay and ambient spawn flow.',
    effect: 'Live — affects reproduction, decay and spawn passes on the next tick.',
    members: [W('MUTATION_RATE', 0.2, 0.6), W('ENERGY_TRANSFER', 0.5, 0.75), W('DECAY_RATE', 0.5, 0.75), W('SPAWN_RATE', 0.05, 0.45)],
  },
];

/* ── Species recipes (surface: species) ─────────────────────────────────── */

// Species recipes anchor the canonical default at t=0 and raise from there.
// `from` equals the trait's default position inside its DNA range
// ((default − min) / (max − min)); validateControlProfile enforces that every
// recipe passes through its defaults with a uniform projected t.
export const SPECIES_EASY_GROUPS = [
  {
    id: 'motion',
    label: 'Motion',
    description: 'How the species pushes through the medium.',
    effect: 'Applies to the selected species immediately.',
    members: [D('FORCE', 0.505, 0.95), D('INERTIA', 0.4736842105263158, 0.95), D('MAX_VELOCITY', 0.3877551020408163, 0.95)],
  },
  {
    id: 'resilience',
    label: 'Resilience',
    description: 'Structural toughness and repair.',
    effect: 'Applies to the selected species immediately.',
    members: [D('STIFFNESS', 0.1836734693877551, 0.95), D('ELASTICITY', 0.5, 0.95), D('REPAIR_EFFICIENCY', 0.5, 0.95), D('TELOMERE_LENGTH', 0.5, 0.95)],
  },
  {
    id: 'metabolism',
    label: 'Metabolism',
    description: 'Energy efficiency, heat and catalysis.',
    effect: 'Applies to the selected species immediately.',
    members: [D('ENERGY_EFFICIENCY', 0.08, 0.95), D('HEAT_OUTPUT', 0.1, 0.85), D('CATALYSIS', 0, 0.9)],
  },
  {
    id: 'signaling',
    label: 'Signaling',
    description: 'Pulse rate, strength and response.',
    effect: 'Applies to the selected species immediately.',
    members: [D('SIGNAL_RESP', 0.5, 0.95), D('PULSE_RATE', 0.2, 0.9), D('SIGNAL_STRENGTH', 0.5, 0.95)],
  },
  {
    id: 'reproduction',
    label: 'Reproduction',
    description: 'Birth, mating and mutation pressure.',
    effect: 'Applies to the selected species immediately.',
    members: [D('BIRTH_RATE', 0.05, 0.9), D('SEX_CHANCE', 0.005, 0.9), D('MUTATION', 0.05, 0.7)],
  },
  {
    id: 'appearance',
    label: 'Appearance',
    description: 'Size, transparency and symmetry.',
    effect: 'Applies to the selected species immediately.',
    members: [D('BASE_RADIUS', 0.05263157894736842, 0.8), D('ALPHA', 0.5, 1), D('SYMMETRY', 0.5, 0.9)],
  },
];

export const CONTROL_PROFILE = {
  schema: CONTROL_PROFILE_SCHEMA,
  surfaces: { world: WORLD_EASY_GROUPS, species: SPECIES_EASY_GROUPS },
};

/* ── Lookups ────────────────────────────────────────────────────────────── */

export function getEasyGroup(surface, groupId) {
  const groups = surface === 'species' ? SPECIES_EASY_GROUPS : WORLD_EASY_GROUPS;
  return groups.find((g) => g.id === groupId) || null;
}

function clamp01(t) {
  return Number.isFinite(t) ? Math.min(1, Math.max(0, t)) : 0;
}

/* ── World math (normalized anchors ⇄ canonical values) ─────────────────── */

function worldValueAt(def, member, t) {
  const norm = member.from + clamp01(t) * (member.to - member.from);
  return Math.min(def.max, Math.max(def.min, def.min + norm * (def.max - def.min)));
}

function worldTOf(def, member, value) {
  const span = def.max - def.min;
  if (!(span > 0)) return 0;
  const norm = (Math.min(def.max, Math.max(def.min, value)) - def.min) / span;
  const dir = member.to - member.from;
  if (!dir) return 0;
  return (norm - member.from) / dir;
}

/**
 * Preview one world recipe: every target it would write, with before/after.
 * Pure — returns the changes map but does not touch state.
 */
export function previewWorldEasy(worldParams, groupId, t) {
  const group = getEasyGroup('world', groupId);
  if (!group) return null;
  const params = worldParams || {};
  const changes = {};
  const summary = [];
  for (const m of group.members) {
    const def = worldParamDef(m.target);
    if (!def) continue;
    const before = Number.isFinite(params[m.target]) ? params[m.target] : def.default;
    const after = worldValueAt(def, m, t);
    changes[m.target] = after;
    summary.push({ target: m.target, label: def.label, before, after, step: def.step });
  }
  return {
    surface: 'world',
    group: group.id,
    label: group.label,
    t: clamp01(t),
    changes,
    affected: Object.keys(changes),
    summary,
    effect: group.effect,
  };
}

/**
 * Apply one world recipe against a params object (pure). Returns the preview
 * plus the resulting `next` state; nothing is mutated.
 */
export function applyWorldEasy(worldParams, groupId, t) {
  const preview = previewWorldEasy(worldParams, groupId, t);
  if (!preview) return null;
  let next = worldParams || {};
  for (const [key, value] of Object.entries(preview.changes)) {
    next = applyWorldParam(next, key, value);
  }
  return { ...preview, next };
}

/* ── Species math (normalized anchors ⇄ canonical DNA values) ───────────── */

function speciesValueAt(idx, member, t) {
  const range = DNA_RANGES[idx];
  const norm = Math.min(1, Math.max(0, member.from + clamp01(t) * (member.to - member.from)));
  return range.min + norm * (range.max - range.min);
}

function speciesTOf(idx, member, denormValue) {
  const range = DNA_RANGES[idx];
  const span = range.max - range.min;
  if (!(span > 0)) return 0;
  const norm = (Math.min(range.max, Math.max(range.min, denormValue)) - range.min) / span;
  const dir = member.to - member.from;
  if (!dir) return 0;
  return (norm - member.from) / dir;
}

/** Preview one species recipe for `species` (pure — no DNA written). */
export function previewSpeciesEasy(dnaBuffer, species, groupId, t) {
  const group = getEasyGroup('species', groupId);
  if (!group) return null;
  const changes = {};
  const summary = [];
  for (const m of group.members) {
    const idx = DNA_INDEXES[m.target];
    if (idx === undefined) continue;
    const range = DNA_RANGES[idx];
    const before = dnaBuffer
      ? getDNAFloat(dnaBuffer, species, idx, range.min, range.max)
      : range.default;
    const after = speciesValueAt(idx, m, t);
    changes[idx] = after;
    summary.push({ target: idx, name: DNA_META[idx] || m.target, label: DNA_META[idx] || m.target, before, after, step: range.step || (range.max - range.min) / 1000 });
  }
  return {
    surface: 'species',
    group: group.id,
    label: group.label,
    t: clamp01(t),
    changes,
    affected: Object.keys(changes).map(Number),
    summary,
    effect: group.effect,
  };
}

/**
 * Apply one species recipe: writes every member into the DNA buffer
 * (mirrors Advanced slider semantics) and returns the preview.
 */
export function applySpeciesEasy(dnaBuffer, species, groupId, t) {
  const preview = previewSpeciesEasy(dnaBuffer, species, groupId, t);
  if (!preview || !dnaBuffer) return preview;
  for (const [idxStr, value] of Object.entries(preview.changes)) {
    const idx = Number(idxStr);
    const range = DNA_RANGES[idx];
    setDNAFloat(dnaBuffer, species, idx, value, range.min, range.max);
  }
  return preview;
}

/* ── Reverse projection (shared) ────────────────────────────────────────── */

function projectGroup(group, surface, readT) {
  const parts = group.members.map((m) => ({ member: m, t: readT(m) }));
  if (!parts.length) return { group: group.id, t: 0, customized: false, members: [] };
  const clamped = parts.map((p) => clamp01(p.t));
  const t = clamped.reduce((a, b) => a + b, 0) / clamped.length;
  const min = Math.min(...parts.map((p) => p.t));
  const max = Math.max(...parts.map((p) => p.t));
  const outOfSpan = parts.some((p) => p.t < -SPAN_SLACK || p.t > 1 + SPAN_SLACK);
  const spread = Math.min(1, Math.max(0, max - min));
  const threshold = CUSTOMIZED_SPREAD[surface] ?? 0.008;
  return {
    surface,
    group: group.id,
    t,
    spread,
    customized: outOfSpan || spread > threshold,
    members: parts.map((p) => ({
      target: p.member.target,
      t: p.t,
      delta: p.t - t,
      outOfSpan: p.t < -SPAN_SLACK || p.t > 1 + SPAN_SLACK,
    })),
  };
}

/** Recover the slider position for a world recipe from current params. */
export function projectWorldEasy(worldParams, groupId) {
  const group = getEasyGroup('world', groupId);
  if (!group) return null;
  const params = worldParams || {};
  return projectGroup(group, 'world', (m) => {
    const def = worldParamDef(m.target);
    if (!def) return 0;
    const value = Number.isFinite(params[m.target]) ? params[m.target] : def.default;
    return worldTOf(def, m, value);
  });
}

/** Recover the slider position for a species recipe from current DNA. */
export function projectSpeciesEasy(dnaBuffer, species, groupId) {
  const group = getEasyGroup('species', groupId);
  if (!group) return null;
  return projectGroup(group, 'species', (m) => {
    const idx = DNA_INDEXES[m.target];
    if (idx === undefined) return 0;
    const range = DNA_RANGES[idx];
    if (!dnaBuffer) return clamp01((range.default - range.min) / (range.max - range.min));
    const value = getDNAFloat(dnaBuffer, species, idx, range.min, range.max);
    return speciesTOf(idx, m, value);
  });
}

/* ── Schema validation (enforced by tests) ──────────────────────────────── */

/**
 * Validate the whole ControlProfile declaration.
 * @returns {string[]} issues; empty array = valid.
 */
export function validateControlProfile() {
  const issues = [];
  const surfaces = [
    ['world', WORLD_EASY_GROUPS, (t) => (worldParamDef(t) ? null : `unknown WORLD_PARAM_DEFS key "${t}"`)],
    ['species', SPECIES_EASY_GROUPS, (t) => (DNA_INDEXES[t] === undefined ? `unknown DNA trait "${t}"` : null)],
  ];
  for (const [surface, groups, checkTarget] of surfaces) {
    const seen = new Set();
    const used = new Map(); // target -> group id (disjointness)
    if (!groups.length) issues.push(`${surface}: no Easy groups`);
    for (const g of groups) {
      const where = `${surface}:${g.id}`;
      if (!g.id || typeof g.id !== 'string') issues.push(`${surface}: group with empty id`);
      else if (seen.has(g.id)) issues.push(`${where}: duplicate group id`);
      seen.add(g.id);
      if (!g.label) issues.push(`${where}: missing label`);
      if (!g.effect) issues.push(`${where}: missing effect note (reset/reseed disclosure)`);
      if (!Array.isArray(g.members) || g.members.length < 2) {
        issues.push(`${where}: composite recipe needs at least 2 members`);
        continue;
      }
      for (const m of g.members) {
        const targetErr = checkTarget(m.target);
        if (targetErr) issues.push(`${where}: ${targetErr}`);
        if (used.has(m.target)) issues.push(`${where}: target "${m.target}" already used by group "${used.get(m.target)}" (members must be disjoint)`);
        else used.set(m.target, g.id);
        if (!Number.isFinite(m.from) || !Number.isFinite(m.to)) issues.push(`${where}: non-finite anchors for "${m.target}"`);
        else {
          if (m.from < 0 || m.from > 1 || m.to < 0 || m.to > 1) issues.push(`${where}: anchors for "${m.target}" must be normalized into [0, 1]`);
          if (m.from === m.to) issues.push(`${where}: anchors for "${m.target}" are degenerate (from === to)`);
        }
      }
      // Recipes must pass through the canonical default, and every member of
      // a group must project the SAME t at default — otherwise a first-run
      // state would show a false “customized” flag.
      const defaultTs = [];
      for (const m of g.members) {
        if (surface === 'world') {
          const def = worldParamDef(m.target);
          if (!def || !(def.max > def.min)) continue;
          const d = (def.default - def.min) / (def.max - def.min);
          const lo = Math.min(m.from, m.to);
          const hi = Math.max(m.from, m.to);
          if (d < lo - 1e-6 || d > hi + 1e-6) issues.push(`${where}: recipe for "${m.target}" does not pass through its default (default normalized ${d.toFixed(4)} outside [${lo.toFixed(4)}, ${hi.toFixed(4)}])`);
          defaultTs.push((d - m.from) / (m.to - m.from));
        } else {
          const idx = DNA_INDEXES[m.target];
          const range = idx === undefined ? null : DNA_RANGES[idx];
          if (!range || !(range.max > range.min)) continue;
          const d = (range.default - range.min) / (range.max - range.min);
          const lo = Math.min(m.from, m.to);
          const hi = Math.max(m.from, m.to);
          if (d < lo - 1e-6 || d > hi + 1e-6) issues.push(`${where}: recipe for "${m.target}" does not pass through its default (default normalized ${d.toFixed(4)} outside [${lo.toFixed(4)}, ${hi.toFixed(4)}])`);
          defaultTs.push((d - m.from) / (m.to - m.from));
        }
      }
      if (defaultTs.length > 1) {
        const spread = Math.max(...defaultTs) - Math.min(...defaultTs);
        if (!(spread <= DEFAULT_CONSISTENCY)) issues.push(`${where}: defaults project inconsistent t (spread ${spread.toExponential(2)} > ${DEFAULT_CONSISTENCY}) — first-run state would look customized`);
      }
    }
  }
  // Every world member must also live inside WORLD_PARAM_DEFS bounds.
  for (const g of WORLD_EASY_GROUPS) {
    for (const m of g.members) {
      const def = worldParamDef(m.target);
      if (!def) continue;
      const lo = def.min + Math.min(m.from, m.to) * (def.max - def.min);
      const hi = def.min + Math.max(m.from, m.to) * (def.max - def.min);
      if (lo < def.min - 1e-9 || hi > def.max + 1e-9) issues.push(`world:${g.id}: span for "${m.target}" leaves the canonical range`);
      if (!(def.max > def.min)) issues.push(`world:${g.id}: target "${m.target}" has no range`);
    }
  }
  if (CONTROL_PROFILE.schema !== CONTROL_PROFILE_SCHEMA) issues.push('schema token mismatch');
  return issues;
}

/** Canonical WORLD_PARAM_DEFS keys exposed for docs/tests. */
export function worldEasyTargets() {
  return WORLD_EASY_GROUPS.flatMap((g) => g.members.map((m) => m.target));
}

/** Canonical DNA trait names exposed for docs/tests. */
export function speciesEasyTargets() {
  return SPECIES_EASY_GROUPS.flatMap((g) => g.members.map((m) => m.target));
}
