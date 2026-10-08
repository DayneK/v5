/**
 * VEPA4 — control mode store (Easy ⇄ Advanced per surface)
 *
 * Independent per-surface preference: the WORLD controls and the SPECIES
 * controls each remember their own mode. First run (no stored value) defaults
 * to **Easy** for both surfaces, per the approved RB decision.
 *
 * Safe in Node/tests: pass an explicit storage object, or none — missing or
 * corrupt storage degrades to the Easy defaults instead of throwing.
 */

export const CONTROL_SURFACES = ['world', 'species'];
export const CONTROL_MODE_STORAGE_KEY = 'vepa.controlModes.v1';

/** Coerce anything to a known mode — unknown values become 'easy'. */
export function normalizeControlMode(value) {
  return value === 'advanced' ? 'advanced' : 'easy';
}

function defaultModes() {
  return { world: 'easy', species: 'easy' };
}

/**
 * Read the stored modes.
 * @param {Storage} [storage] explicit storage (tests); defaults to localStorage
 * @returns {{world: 'easy'|'advanced', species: 'easy'|'advanced'}}
 */
export function readControlModes(storage) {
  const out = defaultModes();
  try {
    const store = storage !== undefined ? storage : globalThis.localStorage;
    const raw = store ? store.getItem(CONTROL_MODE_STORAGE_KEY) : null;
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        for (const surface of CONTROL_SURFACES) {
          out[surface] = normalizeControlMode(parsed[surface]);
        }
      }
    }
  } catch {
    // Storage unavailable or corrupt JSON — fall back to Easy defaults.
  }
  return out;
}

/**
 * Persist one surface's mode.
 * @returns the full modes object after the write
 */
export function writeControlMode(surface, mode, storage) {
  const current = readControlModes(storage);
  if (!CONTROL_SURFACES.includes(surface)) return current;
  const next = { ...current, [surface]: normalizeControlMode(mode) };
  try {
    const store = storage !== undefined ? storage : globalThis.localStorage;
    if (store) store.setItem(CONTROL_MODE_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Storage unavailable — in-memory value still returned to the caller.
  }
  return next;
}
