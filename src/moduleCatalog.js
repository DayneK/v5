/**
 * VEPA4 — single-package module catalog (RB decision D5).
 *
 * Decision: ONE npm package (the root manifest). Module boundaries are
 * enforced by *contracts* instead of a workspace split: every `src/` module
 * declares its entrypoints, owned state, capabilities and versioned ports
 * here, and `tests/unit/moduleCatalog.test.js` validates the catalog through
 * `createCompositionPlan()` (`src/core/moduleRegistry.js`) plus on-disk
 * existence for every declared path.
 *
 * The catalog is data — it does not replace `src/main.js` boot (that wiring
 * would be its own ADR). Contract versions are SemVer and change under the
 * repo changelog, per D5.
 *
 * Invariants (test-enforced):
 *  - every entrypoint/test path exists; every `src/` directory is covered;
 *  - unique ids, unique owned state, unique provided ports;
 *  - ports match exactly (provider version === consumer requirement);
 *  - the plan is a dependency-first DAG with `app` last.
 */
import { createCompositionPlan } from './core/moduleRegistry.js';

export const MODULE_CATALOG_CONTRACT = 'vepa-module-catalog/1.0.0';

const CORE_BUS = { 'core.bus': '1.0.0' };
const CONST_SSOT = { 'constants.ssot': '1.0.0' };

export const MODULE_CATALOG = Object.freeze([
  {
    id: 'constants',
    version: '1.0.0',
    entrypoints: {
      facade: 'src/constants.js',
      laws: 'src/constants/laws.js',
      world: 'src/constants/world.js',
      dna: 'src/constants/dna.js',
      stride: 'src/constants/stride.js',
      help: 'src/constants/help.js',
    },
    dependencies: [],
    owns: ['constants'],
    capabilities: ['ssot-constants'],
    requiredCapabilities: [],
    tests: ['tests/unit/laws.test.js'],
    migrations: [],
    provides: { 'constants.ssot': '1.0.0' },
    requires: {},
  },
  {
    id: 'core',
    version: '1.0.0',
    entrypoints: {
      'event-bus': 'src/core/eventBus.js',
      prng: 'src/core/prng.js',
      'module-registry': 'src/core/moduleRegistry.js',
    },
    dependencies: [],
    owns: ['eventBus', 'prng'],
    capabilities: ['event-bus', 'deterministic-prng'],
    requiredCapabilities: [],
    tests: ['tests/unit/prng.test.js', 'tests/unit/moduleRegistry.test.js'],
    migrations: [],
    provides: { 'core.bus': '1.0.0' },
    requires: {},
  },
  {
    id: 'state',
    version: '1.0.0',
    entrypoints: {
      'world-params': 'src/state/worldParams.js',
      'law-state': 'src/state/lawState.js',
      'runtime-config': 'src/state/runtimeConfig.js',
      'control-profile': 'src/state/controlProfile.js',
      'control-mode': 'src/state/controlMode.js',
    },
    dependencies: ['constants', 'core'],
    owns: ['worldParams', 'lawState', 'runtimeConfig', 'controlModes'],
    capabilities: ['world-state', 'law-state', 'control-profile'],
    requiredCapabilities: ['ssot-constants'],
    tests: ['tests/unit/controlProfile.test.js', 'tests/unit/paramAdditionPolicy.test.js'],
    migrations: [],
    provides: { 'world.params': '1.0.0', 'law.state': '1.0.0', 'runtime.config': '1.0.0' },
    requires: { ...CONST_SSOT, ...CORE_BUS },
  },
  {
    id: 'dna',
    version: '1.0.0',
    entrypoints: {
      'dna-buffer': 'src/dna/dnaBuffer.js',
      expression: 'src/dna/expression.js',
    },
    dependencies: ['constants'],
    owns: ['speciesGenome'],
    capabilities: ['genome'],
    requiredCapabilities: ['ssot-constants'],
    tests: ['tests/unit/dna.test.js'],
    migrations: [],
    provides: { 'genome': '1.0.0' },
    requires: { ...CONST_SSOT },
  },
  {
    id: 'compute',
    version: '1.0.0',
    entrypoints: {
      session: 'src/compute/computeSession.js',
      worker: 'src/worker/physics.worker.js',
    },
    dependencies: ['core', 'state'],
    owns: ['computeSession'],
    capabilities: ['local-compute'],
    requiredCapabilities: ['world-state', 'law-state'],
    tests: ['tests/unit/computeSession.test.js'],
    migrations: [],
    provides: { 'compute.session': '1.0.0' },
    requires: { 'world.params': '1.0.0', 'law.state': '1.0.0', 'runtime.config': '1.0.0' },
  },
  {
    id: 'physics',
    version: '1.0.0',
    entrypoints: {
      solver: 'src/physics/solver.js',
      laws: 'src/physics/laws.js',
      approximations: 'src/physics/approximations.js',
      grid: 'src/physics/spatialGrid.js',
      synergy: 'src/physics/synergy.js',
      fields: 'src/physics/fields.js',
    },
    dependencies: ['constants', 'state', 'dna'],
    owns: ['solver'],
    capabilities: ['exact-reference'],
    requiredCapabilities: ['ssot-constants', 'world-state', 'law-state', 'genome'],
    tests: ['tests/unit/approximationRegistry.test.js', 'tests/unit/physics.test.js'],
    migrations: [],
    provides: { 'physics.solver': '1.0.0' },
    requires: { ...CONST_SSOT, 'world.params': '1.0.0', 'law.state': '1.0.0', 'genome': '1.0.0' },
  },
  {
    id: 'render',
    version: '1.0.0',
    entrypoints: {
      renderer: 'src/render/renderer.js',
      'sprite-sync': 'src/render/spriteSync.js',
    },
    dependencies: ['constants'],
    owns: ['renderer'],
    capabilities: ['canvas-renderer'],
    requiredCapabilities: ['ssot-constants'],
    tests: ['tests/unit/renderer.test.js'],
    migrations: [],
    provides: {},
    requires: { ...CONST_SSOT },
  },
  {
    id: 'ui',
    version: '1.0.0',
    entrypoints: {
      ui: 'src/ui/ui.js',
      'world-panel': 'src/ui/worldPanel.js',
      'species-panel': 'src/ui/speciesPanel.js',
      'control-profile-view': 'src/ui/controlProfileView.js',
      debug: 'src/debug.js',
    },
    dependencies: ['constants', 'state', 'dna', 'render'],
    owns: ['panels', 'controlProfileViews'],
    capabilities: ['setup-panels'],
    requiredCapabilities: ['ssot-constants', 'world-state', 'genome'],
    tests: ['tests/unit/typeScale.test.js', 'tests/unit/touchSupport.test.js'],
    migrations: [],
    provides: { 'ui.panels': '1.0.0' },
    requires: { ...CONST_SSOT, 'world.params': '1.0.0', 'genome': '1.0.0' },
  },
  {
    id: 'engines',
    version: '1.0.0',
    entrypoints: {
      goal: 'src/engines/goalEngine.js',
      narrative: 'src/engines/narrativeEngine.js',
      epoch: 'src/engines/epochEngine.js',
      eco: 'src/engines/ecoEngine.js',
      agency: 'src/engines/agencyEngine.js',
    },
    dependencies: ['core', 'state'],
    owns: ['engines'],
    capabilities: ['insight-engines'],
    requiredCapabilities: ['world-state'],
    tests: ['tests/unit/engines.test.js', 'tests/unit/intelligenceCadence.test.js'],
    migrations: [],
    provides: {},
    requires: { 'world.params': '1.0.0' },
  },
  {
    id: 'saves',
    version: '1.0.0',
    entrypoints: {
      'world-save': 'src/state/worldSave.js',
      'preset-manager': 'src/state/presetManager.js',
      'default-presets': 'src/state/defaultPresets.js',
    },
    dependencies: ['state', 'dna'],
    owns: ['worldSaves'],
    capabilities: ['world-saves'],
    requiredCapabilities: ['world-state', 'genome'],
    tests: [],
    migrations: [],
    provides: { 'saves.world': '1.0.0' },
    requires: { 'world.params': '1.0.0', 'genome': '1.0.0' },
  },
  {
    id: 'population',
    version: '1.0.0',
    entrypoints: {
      distribution: 'src/spawn/distribution.js',
      population: 'src/spawn/population.js',
    },
    dependencies: ['state', 'dna'],
    owns: ['spawn'],
    capabilities: ['population-spawn'],
    requiredCapabilities: ['world-state', 'genome'],
    tests: ['tests/unit/populationManager.test.js'],
    migrations: [],
    provides: {},
    requires: { 'world.params': '1.0.0', 'genome': '1.0.0' },
  },
  {
    id: 'multiplex',
    version: '1.0.0',
    entrypoints: {
      multiplex: 'src/multiplex/multiplex.js',
      'multiplex-ui': 'src/multiplex/multiplexUI.js',
      'multiplex-help': 'src/multiplex/multiplexHelp.js',
    },
    dependencies: ['core', 'state'],
    owns: ['multiplex'],
    capabilities: ['chaos-multiplex'],
    requiredCapabilities: ['world-state'],
    tests: ['tests/unit/multiplex.test.js'],
    migrations: [],
    provides: {},
    requires: { 'world.params': '1.0.0' },
  },
  {
    id: 'app',
    version: '1.0.0',
    entrypoints: {
      main: 'src/main.js',
      'worker-bridge': 'src/workerBridge.js',
      'intelligence-cadence': 'src/intelligenceCadence.js',
      shell: 'index.html',
      'react-entry': 'src/react-entry.js',
      catalog: 'src/moduleCatalog.js',
    },
    dependencies: ['constants', 'core', 'state', 'dna', 'compute', 'physics', 'render', 'ui', 'engines', 'saves', 'population', 'multiplex'],
    owns: ['appShell'],
    capabilities: [],
    requiredCapabilities: ['local-compute', 'exact-reference', 'setup-panels'],
    tests: [],
    migrations: [],
    provides: {},
    requires: { 'compute.session': '1.0.0', 'physics.solver': '1.0.0', 'ui.panels': '1.0.0', 'saves.world': '1.0.0' },
  },
]);

/** Validate the catalog and return the dependency-first composition plan. */
export function moduleCatalogPlan(options = {}) {
  return createCompositionPlan(MODULE_CATALOG, options);
}
