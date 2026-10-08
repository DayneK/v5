/**
 * Evidence-gated parameter additions (RB decision D2).
 *
 * A world parameter or DNA trait cannot appear in the SSOT without a matching,
 * fully-evidenced approval entry in docs/spec/param-additions.json. The count
 * equation below is the enforcement point: an ungated addition changes the
 * live counts while the record stays fixed, and this file fails.
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { WORLD_PARAM_DEFS } from '../../src/state/worldParams.js';
import { DNA_COUNT, DNA_INDEXES } from '../../src/constants.js';
import { WORLD_EASY_GROUPS, SPECIES_EASY_GROUPS } from '../../src/state/controlProfile.js';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const POLICY_PATH = join(ROOT, 'docs/spec/param-addition-policy.md');
const RECORD_PATH = join(ROOT, 'docs/spec/param-additions.json');

// Frozen starting counts. Raising a baseline is a deliberate test edit —
// exactly like the type-scale exception list — never a side effect of adding
// a parameter.
const BASELINE_WORLD_PARAMS = 149;
const BASELINE_DNA_TRAITS = 64;

const REQUIRED_FIELDS = [
  'target', 'key', 'consumer', 'semanticContract', 'migration',
  'tests', 'approvedBy', 'approvedOn',
];

function loadRecord() {
  expect(existsSync(POLICY_PATH), 'docs/spec/param-addition-policy.md must exist').toBe(true);
  expect(existsSync(RECORD_PATH), 'docs/spec/param-additions.json must exist').toBe(true);
  return JSON.parse(readFileSync(RECORD_PATH, 'utf8'));
}

describe('evidence-gated parameter additions (D2)', () => {
  it('the record exists with the versioned schema', () => {
    const record = loadRecord();
    expect(record.schema).toBe('vepa-param-additions/v1');
    expect(record.policy).toBe('docs/spec/param-addition-policy.md');
    expect(Array.isArray(record.additions)).toBe(true);
    expect(record.baseline).toBeTruthy();
  });

  it('baselines match the frozen starting snapshot', () => {
    const record = loadRecord();
    expect(record.baseline.worldParams).toBe(BASELINE_WORLD_PARAMS);
    expect(record.baseline.dnaTraits).toBe(BASELINE_DNA_TRAITS);
  });

  it('live parameter counts equal baseline + approved additions (the gate)', () => {
    const record = loadRecord();
    const worldAdds = record.additions.filter((a) => a.target === 'world').length;
    const dnaAdds = record.additions.filter((a) => a.target === 'dna').length;
    expect(WORLD_PARAM_DEFS.length, 'WORLD_PARAM_DEFS changed without an approved addition entry').toBe(
      record.baseline.worldParams + worldAdds
    );
    expect(DNA_COUNT, 'DNA_COUNT changed without an approved addition entry').toBe(
      record.baseline.dnaTraits + dnaAdds
    );
  });

  it('every approval carries complete evidence', () => {
    const record = loadRecord();
    const seen = new Set();
    for (const a of record.additions) {
      const where = `${a.target}:${a.key}`;
      for (const field of REQUIRED_FIELDS) {
        const value = a[field];
        const ok = Array.isArray(value) ? value.length > 0 : typeof value === 'string' && value.trim().length > 0;
        expect(ok, `${where} is missing evidence field "${field}"`).toBe(true);
      }
      expect(['world', 'dna'], `${where}: target`).toContain(a.target);
      const dup = `${a.target}:${a.key}`;
      expect(seen.has(dup), `${where} approved twice`).toBe(false);
      seen.add(dup);
      // The claimed key must actually exist in the SSOT it says it does.
      if (a.target === 'world') {
        expect(WORLD_PARAM_DEFS.some((d) => d.key === a.key), `${where}: no such WORLD_PARAM_DEFS key`).toBe(true);
      } else {
        expect(DNA_INDEXES[a.key], `${where}: no such DNA trait`).not.toBeUndefined();
      }
      // Evidence tests must exist on disk.
      for (const t of a.tests) {
        expect(existsSync(join(ROOT, t)), `${where}: evidence test missing: ${t}`).toBe(true);
      }
      expect(/^\d{4}-\d{2}-\d{2}$/.test(a.approvedOn), `${where}: approvedOn must be an ISO date`).toBe(true);
    }
  });

  it('Easy recipes never reference parameters that no longer exist', () => {
    for (const g of [...WORLD_EASY_GROUPS, ...SPECIES_EASY_GROUPS]) {
      for (const m of g.members) {
        if (WORLD_EASY_GROUPS.includes(g)) {
          expect(WORLD_PARAM_DEFS.some((d) => d.key === m.target), m.target).toBe(true);
        } else {
          expect(DNA_INDEXES[m.target], m.target).not.toBeUndefined();
        }
      }
    }
  });
});
