/**
 * Single-package module contracts (RB decision D5).
 *
 * The catalog is only worth something if it is true: this file validates it
 * through the real composition planner (ports, capabilities, DAG order) and
 * checks every declared path against the working tree, including automatic
 * coverage of every `src/` directory — a new module directory cannot appear
 * without a catalog entry.
 */
import { readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  MODULE_CATALOG,
  MODULE_CATALOG_CONTRACT,
  moduleCatalogPlan,
} from '../../src/moduleCatalog.js';
import { createCompositionPlan, ModuleCompositionError } from '../../src/core/moduleRegistry.js';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

describe('module catalog — single package, versioned contracts (D5)', () => {
  it('declares the catalog contract token', () => {
    expect(MODULE_CATALOG_CONTRACT).toBe('vepa-module-catalog/1.0.0');
    expect(MODULE_CATALOG.length).toBeGreaterThan(8);
  });

  it('composes into a valid dependency-first plan with app last', () => {
    const plan = moduleCatalogPlan();
    expect(plan).toHaveLength(MODULE_CATALOG.length);
    const ids = plan.map((m) => m.id);
    expect(ids[ids.length - 1]).toBe('app');
    expect(ids.indexOf('constants')).toBeLessThan(ids.indexOf('state'));
    expect(ids.indexOf('state')).toBeLessThan(ids.indexOf('compute'));
    expect(ids.indexOf('ui')).toBeLessThan(ids.indexOf('app'));
    // Deterministic: same plan on every call.
    expect(moduleCatalogPlan().map((m) => m.id)).toEqual(ids);
  });

  it('every declared entrypoint and test path exists on disk', () => {
    for (const manifest of MODULE_CATALOG) {
      for (const [name, path] of Object.entries(manifest.entrypoints)) {
        expect(existsSync(join(ROOT, path)), `${manifest.id}.${name}: ${path}`).toBe(true);
      }
      for (const t of manifest.tests) {
        expect(existsSync(join(ROOT, t)), `${manifest.id} test: ${t}`).toBe(true);
      }
    }
  });

  it('covers every src/ directory automatically', () => {
    const entries = readdirSync(join(ROOT, 'src'), { withFileTypes: true });
    const dirs = entries.filter((e) => e.isDirectory()).map((e) => `src/${e.name}/`);
    const rootFiles = entries.filter((e) => e.isFile() && e.name.endsWith('.js')).map((e) => `src/${e.name}`);
    const declared = MODULE_CATALOG.flatMap((m) => Object.values(m.entrypoints));
    for (const dir of dirs) {
      expect(declared.some((p) => p.startsWith(dir)), `no catalog entry covers ${dir}`).toBe(true);
    }
    for (const file of rootFiles) {
      expect(declared, `no catalog entry covers ${file}`).toContain(file);
    }
    expect(declared).toContain('index.html');
  });

  it('ports are versioned and every requirement is satisfied by a provider', () => {
    const providers = new Map();
    for (const m of MODULE_CATALOG) {
      for (const [port, version] of Object.entries(m.provides)) {
        expect(port).toMatch(/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/);
        expect(version).toMatch(/^\d+\.\d+\.\d+$/);
        providers.set(port, version);
      }
    }
    for (const m of MODULE_CATALOG) {
      for (const [port, version] of Object.entries(m.requires)) {
        expect(providers.has(port), `${m.id} requires unprovided ${port}`).toBe(true);
        expect(providers.get(port), `${m.id} requires ${port}@${version} but provider has ${providers.get(port)}`).toBe(version);
      }
    }
  });

  it('owned state is unique — no two modules claim the same slice', () => {
    const owners = new Map();
    for (const m of MODULE_CATALOG) {
      for (const key of m.owns) {
        expect(owners.has(key), `state "${key}" owned by "${owners.get(key)}" and "${m.id}"`).toBe(false);
        owners.set(key, m.id);
      }
    }
  });

  it('a catalog mutation with a broken contract is rejected by the planner', () => {
    expect(() => createCompositionPlan([
      ...MODULE_CATALOG,
      { ...MODULE_CATALOG[0], id: 'constants' },
    ])).toThrow(ModuleCompositionError);
    expect(() => createCompositionPlan([
      ...MODULE_CATALOG,
      { ...MODULE_CATALOG[3], requires: { 'no.such.port': '1.0.0' } },
    ])).toThrow(/unprovided port/);
  });
});
