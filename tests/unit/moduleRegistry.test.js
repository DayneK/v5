import { describe, expect, it, vi } from 'vitest';
import { createCompositionPlan, ModuleCompositionError, startComposition } from '../../src/core/moduleRegistry.js';

const moduleDef = (id, overrides = {}) => ({
  id,
  version: '1.0.0',
  entrypoints: { main: `src/${id}.js` },
  dependencies: [],
  owns: [],
  capabilities: [],
  requiredCapabilities: [],
  tests: [`tests/${id}.test.js`],
  migrations: [],
  provides: {},
  requires: {},
  ...overrides,
});

describe('module composition contracts', () => {
  it('returns deterministic dependency-first order independent of input order', () => {
    const plan = createCompositionPlan([
      moduleDef('view', { dependencies: ['session'] }),
      moduleDef('session', { dependencies: ['state'] }),
      moduleDef('state'),
      moduleDef('telemetry'),
    ]);

    expect(plan.map(({ id }) => id)).toEqual(['state', 'session', 'telemetry', 'view']);
  });

  it('rejects duplicate IDs, missing dependencies, duplicate owners, and missing capabilities', () => {
    expect(() => createCompositionPlan([moduleDef('same'), moduleDef('same')])).toThrow(/duplicate module id/);
    expect(() => createCompositionPlan([
      moduleDef('world', { owns: ['worldState'], requiredCapabilities: ['worker'] }),
      moduleDef('world', { owns: ['worldState'] }),
      moduleDef('view', { dependencies: ['missing'] }),
    ])).toThrowError(ModuleCompositionError);

    try {
      createCompositionPlan([
        moduleDef('world', { owns: ['worldState'], requiredCapabilities: ['worker'] }),
        moduleDef('world-copy', { owns: ['worldState'] }),
        moduleDef('view', { dependencies: ['missing'] }),
      ]);
    } catch (error) {
      expect(error.issues).toEqual(expect.arrayContaining([
        'state "worldState" is owned by both "world" and "world-copy"',
        'module "world" requires unavailable capability "worker"',
        'module "view" depends on missing module "missing"',
      ]));
    }
  });

  it('validates entrypoints, test and migration declarations in module manifests', () => {
    const plan = createCompositionPlan([moduleDef('world', {
      entrypoints: { main: 'src/state/world.js', schema: 'src/state/schema.js' },
      tests: ['tests/unit/world.test.js'],
      migrations: ['migrations/world-v1-to-v2.js'],
    })]);
    expect(plan[0]).toMatchObject({
      entrypoints: { main: 'src/state/world.js', schema: 'src/state/schema.js' },
      tests: ['tests/unit/world.test.js'],
      migrations: ['migrations/world-v1-to-v2.js'],
    });

    for (const entrypoint of ['/outside.js', '../private.js', 'C:\\\\private.js']) {
      expect(() => createCompositionPlan([
        moduleDef('unsafe', { entrypoints: { main: entrypoint } }),
      ])).toThrow(/invalid entrypoint/);
    }
    expect(() => createCompositionPlan([
      moduleDef('missing-entrypoint', { entrypoints: null }),
    ])).toThrow(/entrypoints must be an object/);
  });

  it('orders port consumers after providers even without explicit module dependencies', () => {
    const plan = createCompositionPlan([
      moduleDef('view', { requires: { 'world.read': '1.0.0' } }),
      moduleDef('world', { provides: { 'world.read': '1.0.0' } }),
    ]);
    expect(plan.map(({ id }) => id)).toEqual(['world', 'view']);
  });

  it('rejects cycles and incompatible port contracts', () => {
    expect(() => createCompositionPlan([
      moduleDef('alpha', { dependencies: ['beta'] }),
      moduleDef('beta', { dependencies: ['alpha'] }),
    ])).toThrow(/dependency cycle/);

    expect(() => createCompositionPlan([
      moduleDef('state', { provides: { 'world.read': '1' } }),
      moduleDef('view', { requires: { 'world.read': '2' } }),
    ])).toThrow(/requires world.read@2/);

    expect(() => createCompositionPlan([
      moduleDef('world', { dependencies: ['view'], provides: { 'world.read': '1' } }),
      moduleDef('view', { requires: { 'world.read': '1' } }),
    ])).toThrow(/dependency cycle/);
  });

  it('starts in plan order, disposes once in reverse order, and cleans up after startup failure', async () => {
    const events = [];
    const plan = createCompositionPlan([
      moduleDef('state', { start: () => events.push('start:state'), dispose: () => events.push('dispose:state') }),
      moduleDef('view', { dependencies: ['state'], start: () => events.push('start:view'), mountUI: () => events.push('mount:view'), dispose: () => events.push('dispose:view') }),
    ]);
    const dispose = await startComposition(plan, {});
    await Promise.all([dispose(), dispose()]);
    expect(events).toEqual(['start:state', 'start:view', 'mount:view', 'dispose:view', 'dispose:state']);

    const failedEvents = [];
    const startError = new Error('startup failed');
    await expect(startComposition([
      moduleDef('first', { start: () => failedEvents.push('start:first'), dispose: () => failedEvents.push('dispose:first') }),
      moduleDef('second', { start: () => { throw startError; } }),
    ], {})).rejects.toBe(startError);
    expect(failedEvents).toEqual(['start:first', 'dispose:first']);
  });

  it('aggregates disposal errors while still disposing every module', async () => {
    const disposeA = vi.fn(() => { throw new Error('A'); });
    const disposeB = vi.fn(() => { throw new Error('B'); });
    const dispose = await startComposition([
      moduleDef('a', { dispose: disposeA }),
      moduleDef('b', { dispose: disposeB }),
    ], {});

    await expect(dispose()).rejects.toMatchObject({
      name: 'AggregateError',
      errors: [expect.objectContaining({ message: 'B' }), expect.objectContaining({ message: 'A' })],
    });
    expect(disposeA).toHaveBeenCalledOnce();
    expect(disposeB).toHaveBeenCalledOnce();
  });
});
