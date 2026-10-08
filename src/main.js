/**
 * VEPA v3 — Main Bootstrap
 * SharedArrayBuffer optional — falls back to ArrayBuffer + main-thread tick.
 */
import { initDebug, logDebug, isDebugVisible, updateLiveStats } from './debug.js';
import { EventBus } from './core/eventBus.js';
import { createWorkerBridge } from './workerBridge.js';
import { createPopulationManager } from './spawn/population.js';
import { createIntelligenceCadence, METRICS_CADENCE, LINEAGE_CADENCE } from './intelligenceCadence.js';
import { SplitMix32 as PRNG } from './core/prng.js';
import { WORLD_SIZE, PARTICLE_STRIDE, MAX_PARTICLES, MAX_SPECIES, DEFAULT_PARTICLES_PER_SPECIES, STRIDE_INDEXES, DNA_INDEXES, DNA_RANGES, LAW_INDEXES, LAW_COUNT, LAW_CATEGORIES } from './constants.js';
import { createParticleBuffer, setX, setY, setVelocity, setMass, setSpeciesId, setEnergy } from './state/particleBuffer.js';
import { createLawState, set as lawSet, clear as lawClear, getActiveCount as getLawCount } from './state/lawState.js';
import { runtimeConfig } from './state/runtimeConfig.js';
import { createWorldParams, applyWorldParam, spawnCaps, syncWrapLaw, syncToroidalParam } from './state/worldParams.js';
import { sampleSpawnPosition, buildSpawnCentres, initialPopulationTarget, perSpeciesAllocation } from './spawn/distribution.js';
import { createDNABuffer, loadDefaults, getDNAFloat } from './dna/dnaBuffer.js';
import { quantizeDNA } from './dna/codec.js';
import { createRendererAsync, resize as resizeRenderer, paintBackground } from './render/renderer.js';
import { syncSprites } from './render/spriteSync.js';
import { initUI } from './ui/ui.js';
import { initCamera, resetCamera, setWorldSize } from './ui/camera.js';
import { resetOffspringRing } from './physics/solver.js';
import { createInsightEngine, updateInsight } from './engines/insightEngine.js';
import { createSpeciationEngine, updateSpeciation } from './engines/speciation.js';
import { createEcoEngine } from './engines/ecoEngine.js';
import { createWorldEventEngine } from './engines/worldEvents.js';
import { createEpochEngine, updateEpoch, getEpochs, getEpochSnapshot, resetEpoch } from './engines/epochEngine.js';
import { createNarrativeEngine, updateNarrative, resetNarrativeEngine } from './engines/narrativeEngine.js';
import { createLineageTracker, trackBirth } from './engines/lineageTracker.js';
import { createGoalEngine, setGoalValue, updateGoal } from './engines/goalEngine.js';
import { createTimelineEngine, snapshot as timelineSnapshot, getTimeline as getTimelineList, clearTimeline as clearTimelineEngine, scrub as timelineScrub } from './engines/timelineEngine.js';
import { createGroupRegistry, updateGroups, groupCount, declareGroup } from './state/groupRegistry.js';
import { PRIME_DEFAULT, DEFAULT_PRESET } from './state/defaultPresets.js';
import { showLaunchModal } from './ui/launchModal.js';
import {
    readLaunchSettings,
    writeLaunchSettings,
    normaliseLaunchSettings,
    presetFor,
    defaultLaunchSettings,
    LAUNCH_FIELDS,
} from './state/launchSettings.js';
import { createMemoryBuffers, speciesMemory, groupMemory, blendMemory, decayMemory, pruneGroupMemory, resetMemoryBuffers, MEM } from './state/memoryBuffers.js';
import { createAgencyEngine, updateAgency, detectMilestones, resetAgency } from './engines/agencyEngine.js';
import { computeSpeciesGoals, applyGoalNudges } from './engines/goalBehavior.js';
import { applyConstructions } from './state/construction.js';
import { runEconomy } from './state/economy.js';
import { runArtifacts } from './state/artifacts.js';
import { runGovernance } from './state/governance.js';
import { runInfrastructure } from './state/infrastructure.js';
import {
  createCivilizationRegistry,
  createFederation,
  foundCulture,
  addFederationMember,
  transmitBetweenGroups,
  stepCivilization,
  civilizationReport,
  serializeCivilization,
  restoreCivilization,
} from './state/civilization.js';
import {
  createStructureRegistry,
  foundStructure,
  structureForGroup,
  runMaintenance,
  structureReport,
} from './state/structures.js';
import {
  createContinuityCatalog,
  recordEraContinuity,
  latestRegime,
  regimeHistogram,
} from './state/continuity.js';
import {
  createCodex,
  recordCodexEntry,
  codexReport,
  serializeCodex,
  restoreCodex,
} from './state/codex.js';
import { createExoticState, stepExoticMatter } from './state/exoticMatter.js';
import { stepRelativity } from './state/relativity.js';
import { createQuantumState, stepQuantumMacro } from './state/quantumMacro.js';
import { createStellarState, stepStellar } from './state/stellar.js';
import { createSyntheticState, stepSynthetic } from './state/synthetic.js';
import { getFields, writeField } from './physics/fields.js';
import { createMultiplexController } from './multiplex/multiplexUI.js';
import { copyShardToWorld, summarizeMultiplex } from './multiplex/multiplex.js';
import {
  captureWorldState,
  restoreWorldState,
  exportWorldSave,
  parseWorldSave,
  createWorldSaveStore,
  compareWorldSaves,
  createUndoRing,
  WORLD_SAVE_FORMAT,
  WORLD_SAVE_VERSION,
} from './state/worldSave.js';
initDebug();
logDebug('main module loaded');



const SUBSTEPS = 4;
const DT = 0.25;
let WORKER_SEED = 0x51f15e;
let launchSettings = null;

let bus, prng, particleBuffer, particleView, lawState, dnaBuffer, renderer;
let insightEngine, narrativeEngine, lineageEngine, goalEngine, timelineEngine;
let groupRegistry = null; // Set F.1 — social groups (declared + detected)
let speciationEngine = null, ecoEngine = null, worldEventEngine = null; // Set A.1/A.2/A.3
let epochEngine = null; // Set D.1 — eras, snapshots, extinction/recovery
let memoryBuffers = null; // Set G.1 — persistent species/group memory
let exoticState = null; // Set L.1 — exotic matter zones + per-particle states
let quantumState = null; // Set N.1 — macroscale superposition + entanglement
let stellarState = null; // Set O.1 — stars, black holes, supernovae
let syntheticState = null;
// Civilization ontology (culture / kin / federation / polity). This is the
// first runtime consumer of src/state/systemLifecycle.js, which until now was
// exercised only by tests and never ran inside the app.
let civilization = null; // Set P.1 — synthetic organisms, uploaded consciousness, machine groups
// Durable structures: each detected group founds a nest, which needs upkeep
// out of the group treasury and can depend on another structure standing.
let structures = null;
// Multi-epoch continuity + the observer's regime catalog. Filled at each
// epoch:boundary by comparing the social world either side of the boundary.
let continuity = null;
// The codex speaks only from continuity evidence, never from law state.
let codex = null;
// Physics worker bridge state moved to src/workerBridge.js (DECOMPOSITION_PLAN
// P4 step 1); main.js keeps the facade wrappers declared above boot().
let agencyEngine = null; // Set H.1 — narrative actor + world milestones
let speciesGoals = new Map(); // Set H.2 — per-species goal nudges
let seenMilestones = new Set(); // Set H.3 — once-only world milestones
let timelineRecording = false;
const TIMELINE_SNAPSHOT_INTERVAL = 150;
const SOCIAL_CADENCE = 4;    // economy/governance/infrastructure/artifacts
// Civilization ontology bounds — the lifecycle substrate caps records at 2048
// by default, but culture/federation/polity should never approach that.
const MAX_CIVILIZATION_CULTURES = 64;
const CULTURE_SEED_SYMBOLS = Object.freeze(['ember', 'oath', 'mark', 'song', 'stone', 'thread', 'salt', 'bell']);
// Peers trade culture less faithfully than parents transmit it to children.
const CULTURE_ALLIANCE_FIDELITY = 0.45;
// Sequel Phase 4-6 bounds. Structure decay is per *maintenance pass*, not per
// tick: at DEFAULT_DECAY 0.004 an unfunded nest falls from 1.0 to the 0.15
// collapse threshold in ~213 passes, so at an 8-tick interval it takes ~28s at
// 60fps to be lost. Slow enough to watch a group neglect it, fast enough to
// read as neglect rather than as a glitch.
const MAX_STRUCTURES = 96;
const STRUCTURE_UPKEEP_RATIO = 0.35;  // share of groups that can afford upkeep
const STRUCTURE_MAINTENANCE_INTERVAL = 8;
let particleCount = 0, speciesCount = 5, tick = 0, paused = false;
let intelligenceCadence = null;
let multiplexController = null;
let worldSize = WORLD_SIZE;
let worldParams = createWorldParams();
runtimeConfig.worldParams = worldParams;
const saveStore = createWorldSaveStore();
const undoRing = createUndoRing();
let undoEnabled = true;
let lastParamSnapshotAt = 0;
const PARAM_SNAPSHOT_DEBOUNCE = 1200;
let spawnRate = worldParams.SPAWN_RATE;
let spawnAccumulator = 0;
let DEFAULT_LAWS = DEFAULT_PRESET.laws;
let ACTIVE_PRESET = DEFAULT_PRESET;

/**
 * Apply the active preset's world parameters at boot.
 *
 * The preset declares its own parameters so there is one place to read what a
 * world is made of. `WELL_COUNT` is layered on here rather than in the preset
 * because it belongs to the physics substrate every preset shares.
 *
 * The launch overrides come last so they win: a world size or an initial
 * population chosen at launch is a deliberate answer to the question the
 * preset's own defaults only guessed at.
 */
function applyDefaultWorldConfig() {
    const declared = { ...ACTIVE_PRESET.worldParams, WELL_COUNT: 3 };

    // Four preset keys predate WORLD_PARAM_DEF and need translating. `dt` is
    // not a world param at all — the timestep is a runtime tunable — so it is
    // routed to runtimeConfig instead of being dropped.
    const legacy = LEGACY_WORLD_PARAM_KEYS;
    for (const [key, value] of Object.entries(declared)) {
        if (key === legacy.dt) {
            if (Number.isFinite(value) && value > 0) runtimeConfig.simSpeed = value;
            continue;
        }
        const paramKey = legacy[key] || key;
        worldParams = applyWorldParam(worldParams, paramKey, value);
    }    for (const [key, value] of Object.entries(launchOverrides)) {
        if (value === null || value === undefined) continue;
        if (key === 'simSpeed') {
            runtimeConfig.simSpeed = value;
            continue;
        }
        const paramKey = legacy[key] || key;
        worldParams = applyWorldParam(worldParams, paramKey, value);
    }
    runtimeConfig.worldParams = worldParams;
    worldSize = worldParams.WORLD_SIZE;
    spawnRate = worldParams.SPAWN_RATE;
}

/** Launch-modal answers that override the preset. Empty until boot resolves. */
let launchOverrides = {};

/**
 * Resolve the launch configuration before anything is built.
 *
 * Runs first in boot() on purpose: a preset decides which laws are set, which
 * world parameters exist and which species spawn, so choosing one later would
 * mean tearing the world down and rebuilding it. Dismissal is a supported
 * answer, not a failure — `null` falls through to the defaults.
 */
async function resolveLaunchConfiguration() {
    const remembered = readLaunchSettings();
    const isFirstRun = remembered.presetId === defaultLaunchSettings().presetId
        && typeof localStorage !== 'undefined'
        && !localStorage.getItem('vepa-launch-settings');
    let choice = null;
    try {
        choice = await showLaunchModal({ settings: remembered, isFirstRun });
    } catch (error) {
        // The modal is the first thing that touches the DOM, so a failure here
        // is the one failure that has nothing behind it. Never let it be one.
        logDebug('launch modal unavailable, booting defaults: ' + (error && error.message), 'warn');
        choice = null;
    }
    const settings = normaliseLaunchSettings(choice || remembered);
    launchSettings = settings;
    WORKER_SEED = settings.launchSeed !== null ? settings.launchSeed : (Date.now() | 0);
    prng = new PRNG(WORKER_SEED);
    if (choice) writeLaunchSettings(settings);

    ACTIVE_PRESET = presetFor(settings);
    DEFAULT_LAWS = ACTIVE_PRESET.laws || [];
    SPECIES_PROFILES.length = 0;
    SPECIES_PROFILES.push(...(ACTIVE_PRESET.species || []).map((s) => ({ ...s, ...s.dna })));

    launchOverrides = {};
    launchOverrides.simSpeed = settings.simSpeed;
    for (const field of LAUNCH_FIELDS) {
        if (field.kind !== 'range' || !field.worldParamKey) continue;
        const value = settings[field.key];
        if (value !== null && value !== undefined) launchOverrides[field.worldParamKey] = value;
    }
    for (const [key, value] of Object.entries(settings.parameterOverrides || {})) launchOverrides[key] = value;

    runtimeConfig.renderBackend = settings.renderBackend;
    runtimeConfig.computeEngine = settings.computeEngine;
    runtimeConfig.simSpeed = settings.simSpeed;
    try {
        localStorage.setItem('vepa-render-backend', settings.renderBackend);
    } catch { /* private mode: the backend simply will not be remembered */ }

    return settings;
}

const LEGACY_WORLD_PARAM_KEYS = Object.freeze({
    worldSize: 'WORLD_SIZE',
    entropy: 'ENTROPY',
    gravity: 'GLOBAL_G',
    dt: '__RUNTIME_DT__',
});

function rng() { return prng.next(); }

/**
 * Physics worker bridge facade (DECOMPOSITION_PLAN P4, step 1).
 *
 * The transport — worker lifecycle, CONFIG/TICK queueing and the serialized
 * in-flight tick — lives in `src/workerBridge.js`. main.js keeps thin
 * wrappers with the exact names every call site already uses, plus the
 * main-thread consequences of a completed tick (population, intelligence,
 * HUD).
 */
const workerBridge = createWorkerBridge({
    dt: DT,
    get particleBuffer() { return particleBuffer; },
    get particleCount() { return particleCount; },
    get worldSize() { return worldSize; },
    get lawState() { return lawState; },
    get dnaBuffer() { return dnaBuffer; },
    get seed() { return WORKER_SEED; },
    onStopped() {
        if (intelligenceCadence) intelligenceCadence.invalidateMetrics();
    },
    onTickComplete(tickStart, message) {
        handleWorkerTick(tickStart, message);
    },
    emit(type, payload) {
        bus.emit(type, payload);
    },
});

function stopPhysicsWorker() {
    workerBridge.stop();
}

function syncPhysicsWorker(payload) {
    workerBridge.sync(payload);
}

function finishPhysicsTick(tickStart, offspring = null) {
    // Population and intelligence remain on the main thread, but run once per
    // completed worker tick rather than once per animation frame. This keeps
    // reproduction, analytics, and HUD state coherent while
    // the render loop remains free to paint between worker responses.
    advancePopulation(offspring);
    updateIntelligence();
    perfTickMs = emaPerf(perfTickMs, performance.now() - tickStart);
    updateLiveStats({
        fps,
        tick,
        particles: particleCount,
        species: speciesCount,
        laws: getLawCount(lawState),
        frameMs: perfFrameMs,
        tickMs: perfTickMs,
        renderMs: perfRenderMs,
    });
    bus.emit('physics:tick', { tick, buffer: particleBuffer, particleCount, speciesCount });
}

function handleWorkerTick(tickStart, message) {
    const offspring = Array.isArray(message.offspring) ? message.offspring : [];
    // The worker owns the authoritative tick counter while it drives the
    // solver — adopt its tickCount so the HUD does not show a frozen TICK 0.
    if (typeof message.tickCount === 'number') tick = message.tickCount;
    finishPhysicsTick(tickStart, offspring);
}

function solve(...args) {
    return workerBridge.solve(...args);
}

function drainOffspring() {
    return workerBridge.drain();
}

function startPhysicsWorker() {
    return workerBridge.start();
}

async function boot() {
    console.log('[VEPA v3] Booting...');
    logDebug('boot: starting');
    const t0 = performance.now();

    bus = new EventBus();
    prng = new PRNG(Date.now());

    const buf = createParticleBuffer(MAX_PARTICLES, PARTICLE_STRIDE);
    particleBuffer = buf.buffer;
    particleView = buf.view;
    const isShared = buf.isShared;
    console.log(`[VEPA v3] SharedArrayBuffer: ${isShared}`);
    logDebug('SharedArrayBuffer: ' + isShared);

    lawState = createLawState();
    dnaBuffer = createDNABuffer();
    loadDefaults(dnaBuffer, DNA_RANGES);

    // Before the laws, the world parameters and the spawn: the launch choice
    // decides all three, and re-deciding any of them afterwards means tearing
    // the world down first.
    await resolveLaunchConfiguration();

    for (const name of DEFAULT_LAWS) {
        if (LAW_INDEXES[name] !== undefined) lawSet(lawState, LAW_INDEXES[name]);
    }

    applyDefaultWorldConfig();

    // WRAP is seeded from TOROIDAL EDGES rather than from the preset's law
    // list, so a preset that predates the law still boots with the topology its
    // world params ask for. Runs after `applyDefaultWorldConfig` because that
    // is what resolves the preset's world params.
    syncWrapLaw(worldParams, lawState);

    spawnDefaultPopulation();

    const canvas = document.getElementById('sim-canvas');
    // Renderer selection is async only for PixiJS; the Canvas2D reference
    // path remains the immediate fallback if GPU initialization fails.
    renderer = await createRendererAsync(canvas, MAX_PARTICLES, {
        backend: runtimeConfig.renderBackend,
    });
    resizeRenderer(renderer);
    if (renderer.requestedBackend === 'pixi' && renderer.mode !== 'pixi') {
        logDebug('PixiJS renderer unavailable; using Canvas2D fallback: ' + renderer.backendError, 'warn');
    } else {
        logDebug('render backend: ' + renderer.mode);
    }
    // Small debug hook: lets e2e acceptance tests (and the browser console)
    // inspect which presentation backend actually engaged.
    window.__VEPA_RENDERER__ = renderer;
    refreshBackground();
    window.addEventListener('resize', () => {
        if (renderer) resizeRenderer(renderer);
        refreshBackground();
    });
    if (window.ResizeObserver) {
        const ro = new ResizeObserver(() => {
            if (renderer) resizeRenderer(renderer);
        });
        ro.observe(canvas);
    }
    initCamera(canvas, worldSize);

    initUI(bus, lawState, dnaBuffer);
    wireEvents();

    multiplexController = createMultiplexController(bus, () => ({
        view: particleView,
        count: particleCount,
        dna: dnaBuffer,
        laws: lawState,
        speciesCount,
    }), (shard) => {
        // Import the selected multiplex shard into the main world.
        const imported = copyShardToWorld(shard, { view: particleView, dna: dnaBuffer, laws: lawState });
        particleCount = imported.count;
        speciesCount = imported.speciesCount;
        resetOffspringRing();
        resetIntelligence();
        bus.emit('species:sync', { count: speciesCount });
        bus.emit('dna:sync');
        bus.emit('law:sync');
        logDebug(`multiplex import: ${imported.count} particles / ${imported.speciesCount} species`);
    });
    window.openChaosMultiplex = () => { if (multiplexController) multiplexController.openModal(); };
    bus.on('multiplex:started', () => {
        paused = true;
        bus.emit('sim:paused', { paused: true });
    });
    bus.on('multiplex:exited', () => {
        paused = false;
        bus.emit('sim:paused', { paused: false });
    });

        insightEngine = createInsightEngine(bus, { scanInterval: 90, clusterRadius: 60, minClusterSize: 5 });
    narrativeEngine = createNarrativeEngine(bus, { seed: WORKER_SEED });
    lineageEngine = createLineageTracker(bus);
    goalEngine = createGoalEngine(bus);
    timelineEngine = createTimelineEngine(bus, { autoSnapshotInterval: 0, maxSnapshots: 20 });
    groupRegistry = createGroupRegistry();
        speciationEngine = createSpeciationEngine(bus, { prng: () => prng.next() });
    ecoEngine = createEcoEngine(bus);
    worldEventEngine = createWorldEventEngine(bus);
    epochEngine = createEpochEngine(bus);
    memoryBuffers = createMemoryBuffers();
    exoticState = createExoticState();
    quantumState = createQuantumState();
    stellarState = createStellarState();
    syntheticState = createSyntheticState();
    civilization = createCivilizationRegistry();
    // Sequel Phases 4-6: structures are hosted by the civilization lifecycle,
    // and the continuity catalog + codex are the observer's per-world memory.
    structures = createStructureRegistry(civilization.lifecycle);
    continuity = createContinuityCatalog();
    codex = createCodex();
    agencyEngine = createAgencyEngine(bus);
    setGoalValue(goalEngine, 'scanInterval', insightEngine.cfg.scanInterval);
    setGoalValue(goalEngine, 'clusterRadius', insightEngine.cfg.clusterRadius);
    setGoalValue(goalEngine, 'maxForce', runtimeConfig.maxForce);
    setGoalValue(goalEngine, 'drag', runtimeConfig.dragMultiplier);
    setGoalValue(goalEngine, 'birthRate', runtimeConfig.birthRate);
    setGoalValue(goalEngine, 'deathRate', runtimeConfig.deathRate);
    wireGoalEvents();
    intelligenceCadence = createIntelligenceCadence({
        get particleView() { return particleView; },
        get particleCount() { return particleCount; },
        get tick() { return tick; },
        get fps() { return fps; },
        get insightEngine() { return insightEngine; },
        get groupRegistry() { return groupRegistry; },
        get lineageEngine() { return lineageEngine; },
        get worldParams() { return worldParams; },
        get epochEngine() { return epochEngine; },
        tickInFlight: () => workerBridge.tickInFlight(),
        onError: (error) => {
            console.error('intelligence pass error:', error);
            logDebug('INTELLIGENCE ERROR: ' + (error && (error.stack || error.message) || error), 'error');
        },
        getLawCount: () => getLawCount(lawState),
    });
    intelligenceCadence.reset();

    // Keep UI work on the main thread, but move the deterministic solver and
    // its spatial-grid/pairwise hot path off-thread whenever SAB is available.
    // The worker is intentionally started after all initial writes are done.
    startPhysicsWorker();
    requestAnimationFrame(renderLoop);

    const dt = (performance.now() - t0).toFixed(1);
    console.log(`[VEPA v3] Booted in ${dt}ms — ${particleCount} particles, ${speciesCount} species`);
    logDebug(`booted in ${dt}ms — ${particleCount} particles, ${speciesCount} species`);
    bus.emit('boot:complete', { particleCount, speciesCount, dt });
}

// Boot species are derived from the active preset. The population manager
// reads this same mutable list after resolveLaunchConfiguration refills it.
const SPECIES_PROFILES = DEFAULT_PRESET.species.map((s) => ({ ...s, ...s.dna }));
const populationManager = createPopulationManager({
    get particleBuffer() { return particleBuffer; },
    get particleView() { return particleView; },
    get particleCount() { return particleCount; },
    setParticleCount(value) { particleCount = value; },
    get speciesCount() { return speciesCount; },
    set speciesCount(value) { speciesCount = value; },
    get speciesProfiles() { return SPECIES_PROFILES; },
    get dnaBuffer() { return dnaBuffer; },
    get worldParams() { return worldParams; },
    get worldSize() { return worldSize; },
    get launchSettings() { return launchSettings; },
    get prng() { return prng; },
    get spawnRate() { return spawnRate; },
    get spawnAccumulator() { return spawnAccumulator; },
    setSpawnAccumulator(value) { spawnAccumulator = value; },
    get simSpeed() { return runtimeConfig.simSpeed; },
    dt: DT,
    workerTickInFlight: () => workerBridge.tickInFlight(),
    drainOffspring,
    get lineageEngine() { return lineageEngine; },
});

function profileColor(species) { return populationManager.profileColor(species); }
function setDNAFromProfile(species, profile) { return populationManager.setDNAFromProfile(species, profile); }
function spawnSingleParticle(species, pos) { return populationManager.spawnSingleParticle(species, pos); }
function spawnDefaultPopulation(preserveDNA = false, keepSpecies = false) {
    return populationManager.spawnDefaultPopulation(preserveDNA, keepSpecies);
}
function spawnOffspring(offspring = null) { return populationManager.spawnOffspring(offspring); }
function advancePopulation(offspring = null) { return populationManager.advancePopulation(offspring); }

/* Legacy inline population block replaced by the injected manager.
function spawnDefaultPopulation(preserveDNA = false, keepSpecies = false) {
    const profiles = SPECIES_PROFILES;

    if (!keepSpecies) speciesCount = Math.min(profiles.length, MAX_SPECIES);
    let idx = 0;
    const caps = spawnCaps(worldParams);
    const totalTarget = initialPopulationTarget(worldParams, caps);
    const perSpecies = perSpeciesAllocation(totalTarget, speciesCount);
    const groundH = Math.max(0, Math.min(1, worldParams.GROUND_HEIGHT));

    for (let s = 0; s < speciesCount; s++) {
        const p = profiles[s] || null;
        if (p && !preserveDNA) setDNAFromProfile(s, p);

        const gridDim = Math.max(2, Math.ceil(Math.cbrt(perSpecies)));
        const cellSize = (worldSize - 10) / gridDim;

        const centres = buildSpawnCentres(
            Math.max(1, Math.min(64, Math.round(worldParams.SPAWN_CENTRES) || 1)),
            worldParams.SPAWN_CENTRE_RANDOM,
            worldSize,
            prng,
        );

        for (let i = 0; i < perSpecies && idx < caps.hardCap; i++) {
            const ptr = idx * PARTICLE_STRIDE;
            const gx = i % gridDim;
            const gy = Math.floor(i / gridDim) % gridDim;
            const gz = Math.floor(i / (gridDim * gridDim));
            let px = 5 + gx * cellSize + cellSize * 0.5 + (prng.nextFloat(0, 1) - 0.5) * cellSize * 0.4;
            let py = 5 + gy * cellSize + cellSize * 0.5 + (prng.nextFloat(0, 1) - 0.5) * cellSize * 0.4;
            let pz = 5 + gz * cellSize + cellSize * 0.5 + (prng.nextFloat(0, 1) - 0.5) * cellSize * 0.4;
            if (worldParams.SHAPE > 0) {
                px = px + (prng.nextFloat(0, worldSize) - px) * worldParams.SHAPE;
                py = py + (prng.nextFloat(0, worldSize) - py) * worldParams.SHAPE;
                pz = pz + (prng.nextFloat(0, worldSize) - pz) * worldParams.SHAPE;
            }
            if (worldParams.SPAWN_CENTRE_BIAS > 0 && centres.length > 0) {
                const c = centres[Math.floor(prng.nextFloat(0, centres.length))];
                px = px + (c.x - px) * worldParams.SPAWN_CENTRE_BIAS;
                py = py + (c.y - py) * worldParams.SPAWN_CENTRE_BIAS;
                pz = pz + (c.z - pz) * worldParams.SPAWN_CENTRE_BIAS;
            }
            if (groundH < 1) pz = Math.min(pz, Math.max(0, worldSize * groundH));
            setX(particleBuffer, idx, PARTICLE_STRIDE, px);
            setY(particleBuffer, idx, PARTICLE_STRIDE, py);
            particleView[ptr + STRIDE_INDEXES.POS_Z] = pz;
            setVelocity(particleBuffer, idx, PARTICLE_STRIDE, 0, 0, 0);
            setMass(particleBuffer, idx, PARTICLE_STRIDE, 1.0 + prng.nextFloat(0, 1.0));
            setSpeciesId(particleBuffer, idx, PARTICLE_STRIDE, s);
            const founderEra = launchSettings?.founderEra || 'newborn';
            const age = founderEra === 'ancient' ? 420 + prng.nextFloat(0, 180)
                : founderEra === 'established' ? prng.nextFloat(80, 420) : 0;
            const energy = founderEra === 'ancient' ? 25 + prng.nextFloat(0, 55)
                : founderEra === 'established' ? 40 + prng.nextFloat(0, 70) : 50 + prng.nextFloat(0, 50);
            setEnergy(particleBuffer, idx, PARTICLE_STRIDE, energy);
            particleView[ptr + STRIDE_INDEXES.AGE] = age;
            // Copy species DNA to particle DNA cache (stride 8-49)
            const dnaBase = s * 64;
            for (let d = 0; d < 42; d++) {
                const raw = dnaBuffer[dnaBase + d] || 0;
                const norm = raw / 65535;
                const r = DNA_RANGES[d] || { min: -1, max: 1 };
                particleView[ptr + STRIDE_INDEXES.DNA_CACHE_START + d] = norm * (r.max - r.min) + r.min;
            }
            particleView[ptr + STRIDE_INDEXES.DEAD] = 0;
            particleView[ptr + STRIDE_INDEXES.AGE] = age;
            particleView[ptr + STRIDE_INDEXES.SIGNAL] = 0;
            particleView[ptr + STRIDE_INDEXES.BOND_COUNT] = 0;
            particleView[ptr + STRIDE_INDEXES.BOND_PARTNER_1] = -1;
            particleView[ptr + STRIDE_INDEXES.BOND_PARTNER_2] = -1;
        particleView[ptr + STRIDE_INDEXES.BOND_PARTNER_3] = -1;
        particleView[ptr + STRIDE_INDEXES.BOND_PARTNER_4] = -1;
        particleView[ptr + STRIDE_INDEXES.BOND_PARTNER_5] = -1;
        particleView[ptr + STRIDE_INDEXES.BOND_PARTNER_6] = -1;
        particleView[ptr + STRIDE_INDEXES.ACCR_LINK_MASK] = 0;
            particleView[ptr + STRIDE_INDEXES.MEMORY] = 0;
            particleView[ptr + STRIDE_INDEXES.HUNGER] = 0;
            particleView[ptr + STRIDE_INDEXES.ARMOR] = prng.nextFloat(0, 0.5);
            particleView[ptr + STRIDE_INDEXES.MITOSIS_TIMER] = 0;
            particleView[ptr + STRIDE_INDEXES.PARTNER_ID] = -1;
            particleView[ptr + STRIDE_INDEXES.TEMPERATURE] = 0.5;
            particleView[ptr + STRIDE_INDEXES.CHARGE] = 0;
            particleView[ptr + STRIDE_INDEXES.ELECTRIC_ENERGY] = 0;
            particleView[ptr + STRIDE_INDEXES.STORED_ENERGY] = 0;
            particleView[ptr + STRIDE_INDEXES.REPRO_DRIVE] = 0;
            particleView[ptr + STRIDE_INDEXES.RADIATION_EXPOSURE] = 0;
            particleView[ptr + STRIDE_INDEXES.PHASE_1] = 0;
            particleView[ptr + STRIDE_INDEXES.PHASE_2] = 0;
            particleView[ptr + STRIDE_INDEXES.SOUL] = 0;
            particleView[ptr + STRIDE_INDEXES.TRAIL_X] = 0;
            particleView[ptr + STRIDE_INDEXES.TRAIL_Y] = 0;
            particleView[ptr + STRIDE_INDEXES.TRAIL_Z] = 0;
            particleView[ptr + STRIDE_INDEXES.ENTANGLE_ID] = -1;
            particleView[ptr + STRIDE_INDEXES.ENTANGLE_PHASE] = 0;

            for (let d = 0; d < 42; d++) {
                particleView[ptr + STRIDE_INDEXES.DNA_CACHE_START + d] = getDNAFloat(dnaBuffer, s, d, DNA_RANGES[d].min, DNA_RANGES[d].max);
            }

            const col = profileColor(s);
            particleView[ptr + STRIDE_INDEXES.COLOR_R] = col[0];
            particleView[ptr + STRIDE_INDEXES.COLOR_G] = col[1];
            particleView[ptr + STRIDE_INDEXES.COLOR_B] = col[2];
            particleView[ptr + STRIDE_INDEXES.ALPHA] = 0.8;
            particleView[ptr + STRIDE_INDEXES.RADIUS] = 0.6;
            idx++;
        }
    }
    particleCount = idx;
}

// Repaint the atmospheric backdrop canvas (sized to the viewport).
function refreshBackground() {
    const bg = document.getElementById('bg-canvas');
    if (bg) paintBackground(bg);
}

// Spawn offspring produced by REPRO law into the particle buffer.
function spawnOffspring(offspring = null) {
    const list = offspring || drainOffspring();
    if (!list.length) return;
    for (const off of list) {
        if (particleCount >= MAX_PARTICLES) break;
        const ptr = particleCount * PARTICLE_STRIDE;
        setX(particleBuffer, particleCount, PARTICLE_STRIDE, off.x);
        setY(particleBuffer, particleCount, PARTICLE_STRIDE, off.y);
        particleView[ptr + STRIDE_INDEXES.POS_Z] = off.z || 0;
        setVelocity(particleBuffer, particleCount, PARTICLE_STRIDE, off.vx || 0, off.vy || 0, off.vz || 0);
        setMass(particleBuffer, particleCount, PARTICLE_STRIDE, off.mass || 1.0);
        setSpeciesId(particleBuffer, particleCount, PARTICLE_STRIDE, off.speciesId);
        setEnergy(particleBuffer, particleCount, PARTICLE_STRIDE, off.energy || 60);
        if (off.dna && off.dna.length) {
            for (let d = 0; d < 42 && d < off.dna.length; d++) {
                particleView[ptr + STRIDE_INDEXES.DNA_CACHE_START + d] = off.dna[d];
            }
        }
        particleView[ptr + STRIDE_INDEXES.DEAD] = 0;
        particleView[ptr + STRIDE_INDEXES.AGE] = 0;
        particleView[ptr + STRIDE_INDEXES.SIGNAL] = 0;
        particleView[ptr + STRIDE_INDEXES.BOND_COUNT] = 0;
        particleView[ptr + STRIDE_INDEXES.BOND_PARTNER_1] = -1;
        particleView[ptr + STRIDE_INDEXES.BOND_PARTNER_2] = -1;
        particleView[ptr + STRIDE_INDEXES.BOND_PARTNER_3] = -1;
        particleView[ptr + STRIDE_INDEXES.BOND_PARTNER_4] = -1;
        particleView[ptr + STRIDE_INDEXES.BOND_PARTNER_5] = -1;
        particleView[ptr + STRIDE_INDEXES.BOND_PARTNER_6] = -1;
        particleView[ptr + STRIDE_INDEXES.ACCR_LINK_MASK] = 0;
        particleView[ptr + STRIDE_INDEXES.MEMORY] = 0;
        particleView[ptr + STRIDE_INDEXES.HUNGER] = 0;
        particleView[ptr + STRIDE_INDEXES.ARMOR] = 0.2;
        particleView[ptr + STRIDE_INDEXES.MITOSIS_TIMER] = 0;
        particleView[ptr + STRIDE_INDEXES.PARTNER_ID] = -1;
        particleView[ptr + STRIDE_INDEXES.TEMPERATURE] = 0.5;
        particleView[ptr + STRIDE_INDEXES.CHARGE] = 0;
        particleView[ptr + STRIDE_INDEXES.SOUL] = 0;
        particleView[ptr + STRIDE_INDEXES.ENTANGLE_ID] = -1;
        particleView[ptr + STRIDE_INDEXES.ENTANGLE_PHASE] = 0;
        const sp = SPECIES_PROFILES[off.speciesId] || SPECIES_PROFILES[0];
        const defR = sp ? sp.color[0] : 200;
        const defG = sp ? sp.color[1] : 200;
        const defB = sp ? sp.color[2] : 200;
        particleView[ptr + STRIDE_INDEXES.COLOR_R] = off.colorR != null ? Math.max(0, Math.min(255, off.colorR)) : defR;
        particleView[ptr + STRIDE_INDEXES.COLOR_G] = off.colorG != null ? Math.max(0, Math.min(255, off.colorG)) : defG;
        particleView[ptr + STRIDE_INDEXES.COLOR_B] = off.colorB != null ? Math.max(0, Math.min(255, off.colorB)) : defB;
        particleView[ptr + STRIDE_INDEXES.ALPHA] = 0.8;
        particleView[ptr + STRIDE_INDEXES.RADIUS] = 0.6;
        particleCount++;
        if (lineageEngine) {
            trackBirth(lineageEngine, off.parentId != null ? off.parentId : -1, particleCount - 1, off.speciesId, 0);
        }
    }
}

function advancePopulation(offspring = null) {
    spawnOffspring(offspring);
    const caps = spawnCaps(worldParams);
    if (spawnRate > 0 && particleCount < caps.softCap) {
        spawnAccumulator += spawnRate * (DT * runtimeConfig.simSpeed);
        while (spawnAccumulator >= 1 && particleCount < caps.softCap) {
            spawnAccumulator -= 1;
            spawnSingleParticle(
                Math.floor(prng.nextFloat(0, speciesCount)),
                sampleSpawnPosition(worldParams, worldSize, prng),
            );
        }
    }
}

function setDNAFromProfile(species, profile) {
    for (const [key, value] of Object.entries(profile)) {
        // Canonical form: the profile keys ARE DNA_INDEXES names, so any of the
        // 64 traits can be set without touching this function. Previously a
        // hand-maintained MAP listed ten camelCase aliases, and every other
        // trait a preset tried to set was silently discarded.
        const dnaKey = DNA_INDEXES[key] !== undefined ? key : LEGACY_PROFILE_KEYS[key];
        if (!dnaKey) continue;
        const paramIdx = DNA_INDEXES[dnaKey];
        if (paramIdx === undefined) continue;
        const r = DNA_RANGES[paramIdx];
        dnaBuffer[species * 64 + paramIdx] = quantizeDNA(value, r.min, r.max);
    }
}
*/

function refreshBackground() {
    const bg = document.getElementById('bg-canvas');
    if (bg) paintBackground(bg);
}

function wireEvents() {
    const currentWorldState = (name = '') => captureWorldState({
        view: particleView,
        count: particleCount,
        speciesCount,
        dna: dnaBuffer,
        laws: lawState,
        worldParams,
        runtime: runtimeConfig,
        worldSize,
        tick,
        name,
        civilization: civilization ? serializeCivilization(civilization) : null,
        codex: codex ? serializeCodex(codex) : null,
    });
    const emitUndoState = () => {
        // The ring's contents ride along: the UNDO sub-tab renders the history,
        // not just whether a step is available.
        bus.emit('world:undoState', {
            canUndo: undoRing.canUndo(),
            canRedo: undoRing.canRedo(),
            enabled: undoEnabled,
            ...undoRing.describe(),
        });
    };
    const commitAutoSnapshot = () => {
        if (!undoEnabled) return;
        if (multiplexController && multiplexController.isActive()) return; // frozen main world
        if (particleCount <= 0) return; // skip empty boots
        undoRing.commit(currentWorldState());
        emitUndoState();
    };
    const applyWorldRestore = (state) => {
        const restoreWorker = workerBridge.isActive();
        stopPhysicsWorker();
        const out = restoreWorldState(state, {
            view: particleView,
            dna: dnaBuffer,
            laws: lawState,
            worldParams,
            runtime: runtimeConfig,
        });
        particleCount = out.particleCount;
        speciesCount = out.speciesCount;
        worldSize = out.worldSize;
        setWorldSize(out.worldSize);
        resetOffspringRing();
        resetIntelligence();
        // resetIntelligence() installs a fresh civilization registry; a save
        // that carries one replaces it. Saves predating the ontology simply
        // leave the fresh (empty) registry in place.
        if (out.civilization) {
            civilization = restoreCivilization(out.civilization);
            // Structures live in the civilization lifecycle, so a restored
            // lifecycle must be re-hosted by a fresh structure registry.
            structures = createStructureRegistry(civilization.lifecycle);
        }
        if (out.codex) codex = restoreCodex(out.codex);
        if (restoreWorker) startPhysicsWorker();
        bus.emit('species:sync', { count: speciesCount });
        bus.emit('dna:sync');
        bus.emit('law:sync');
        bus.emit('world:paramsRestored');
        bus.emit('world:restored', { particleCount, speciesCount, worldSize });
    };
    bus.on('sim:chaos', () => commitAutoSnapshot());
    bus.on('sim:restart', () => commitAutoSnapshot());
    bus.on('preset:load', () => commitAutoSnapshot());
    // ── Presets (WORLD sub-tab) ──
    // The preset panel asks the world for its current state rather than reading
    // the buffer itself: it has no access to the particle view, the law state
    // or the live world params, and duplicating that reach would be a second
    // source of truth for "what is this world right now".
    bus.on('preset:requestState', ({ presetName }) => {
        const name = String(presetName || '').trim();
        if (!name) return;
        bus.emit('preset:stateResponse', {
            presetName: name,
            savedAt: Date.now(),
            law: lawState.serialize(lawState),
            dna: dnaBuffer ? dnaBuffer.slice() : null,
            speciesCount,
            worldParams: { ...worldParams },
        });
    });
    bus.on('preset:load', ({ name, preset }) => {
        if (!preset) return;
        commitAutoSnapshot();
        // Restores laws, DNA and world parameters, and deliberately leaves the
        // particles alone: a preset is a configuration, not a world snapshot.
        // `particles` is absent, so restoreWorldState skips the buffer fill.
        applyWorldRestore({
            format: WORLD_SAVE_FORMAT,
            version: WORLD_SAVE_VERSION,
            particleCount,
            speciesCount: preset.speciesCount || speciesCount,
            worldSize,
            dna: preset.dna || null,
            laws: preset.law || null,
            worldParams: preset.worldParams || null,
        });
        bus.emit('preset:loaded', { name: String(name || '') });
    });
    bus.on('species:aboutToChange', () => commitAutoSnapshot());
    bus.on('world:paramChanged', () => {
        if (!undoEnabled) return;
        const now = Date.now();
        if (now - lastParamSnapshotAt < PARAM_SNAPSHOT_DEBOUNCE) return;
        if (multiplexController && multiplexController.isActive()) return;
        if (particleCount <= 0) return;
        lastParamSnapshotAt = now;
        undoRing.commit(currentWorldState());
        emitUndoState();
    });
    bus.on('sim:hardReset', () => {
        if (particleCount <= 0) return;
        const d = new Date();
        const hh = String(d.getHours()).padStart(2, '0');
        const mm = String(d.getMinutes()).padStart(2, '0');
        saveStore.save(currentWorldState(`AUTO pre-reset ${hh}:${mm}`)).then((res) => {
            if (res && res.ok) logDebug('pre-reset world saved for rollback');
        });
    });
    bus.on('world:save', async ({ name }) => {
        const n = String(name || '').trim();
        if (!n) return;
        const res = await saveStore.save(currentWorldState(n));
        bus.emit('world:list');
        bus.emit('world:saved', { name: n, ok: !!(res && res.ok), error: res && res.error });
    });
    bus.on('world:load', async ({ name }) => {
        const state = await saveStore.load(String(name || ''));
        if (!state) return;
        commitAutoSnapshot(); // the load itself is undoable
        applyWorldRestore(state);
        bus.emit('world:loaded', { name: state.name });
        emitUndoState();
    });
    bus.on('world:undo', () => {
        const target = undoRing.undo(currentWorldState());
        if (!target) return;
        applyWorldRestore(target);
        emitUndoState();
    });
    bus.on('world:redo', () => {
        const target = undoRing.redo(currentWorldState());
        if (!target) return;
        applyWorldRestore(target);
        emitUndoState();
    });
    bus.on('world:list', async () => {
        const saves = await saveStore.list();
        bus.emit('world:listResponse', { saves });
    });
    bus.on('world:remove', async ({ name }) => {
        await saveStore.remove(String(name || ''));
        bus.emit('world:list');
    });
    bus.on('world:export', async ({ name }) => {
        const key = String(name || '');
        // `LIVE` exports what is on screen right now without saving it first —
        // the IMPORT/EXPORT sub-tab's "export live world" button.
        const state = key === 'LIVE' ? currentWorldState('LIVE') : await saveStore.load(key);
        if (!state) return;
        bus.emit('world:exported', { name: state.name, json: exportWorldSave(state) });
    });
    bus.on('world:import', async ({ json }) => {
        try {
            const state = parseWorldSave(json);
            const res = await saveStore.save(state);
            bus.emit('world:list');
            bus.emit('world:imported', { ok: !!(res && res.ok), error: res && res.error });
        } catch (e) {
            bus.emit('world:imported', { ok: false, error: String((e && e.message) || e) });
        }
    });
    bus.on('world:compare', async ({ names }) => {
        const wanted = Array.isArray(names) ? names : [];
        const loaded = [];
        for (const n of wanted) {
            const state = await saveStore.load(String(n));
            if (state) loaded.push(state);
        }
        const matrix = compareWorldSaves(currentWorldState('LIVE'), loaded);
        bus.emit('world:compareResponse', { matrix });
    });
    bus.on('world:toggleAutoUndo', ({ enabled }) => {
        undoEnabled = enabled !== false;
        emitUndoState();
    });
    emitUndoState();

    bus.on('law:sync', () => {
        // A wholesale rebuild of the law state — preset applied, laws cleared,
        // chaos, external sync — is not a request to change the world's
        // topology. Re-assert WRAP from TOROIDAL EDGES so "clear all laws"
        // cannot silently turn a toroidal world into a walled one.
        //
        // The panels' own `law:sync` listeners may already have re-rendered by
        // the time this runs, so when the bit actually moved we broadcast once
        // more. The second pass changes nothing, so this cannot recurse.
        if (syncWrapLaw(worldParams, lawState)) bus.emit('law:sync');
        syncPhysicsWorker();
    });
    bus.on('law:toggled', (payload) => {
        // WRAP is the world's boundary rule, and TOROIDAL EDGES is its slider.
        // Flip one and the other follows, so the grid and the WORLD panel can
        // never show opposite answers about the same bit.
        if (payload && payload.lawIndex === LAW_INDEXES.WRAP) {
            worldParams = syncToroidalParam(worldParams, lawState);
            runtimeConfig.worldParams = worldParams;
            bus.emit('world:paramsRestored');
        }
        syncPhysicsWorker(payload);
    });
    bus.on('dna:sync', syncPhysicsWorker);
    bus.on('dna:changed', syncPhysicsWorker);
    bus.on('world:paramApplied', syncPhysicsWorker);
    bus.on('compute:changed', syncPhysicsWorker);
    bus.on('sim:pause', () => { paused = true; });
    bus.on('sim:resume', () => { paused = false; });
    bus.on('sim:restart', (opts = {}) => {
        const restartWorker = workerBridge.isActive();
        stopPhysicsWorker();
        WORKER_SEED = launchSettings?.launchSeed ?? (Date.now() | 0);
        prng = new PRNG(WORKER_SEED);
        particleView.fill(0);
        resetOffspringRing();
        spawnDefaultPopulation(true, true);
        if (restartWorker) startPhysicsWorker();
        tick = 0;
        paused = false;
        resetIntelligence();
        bus.emit('species:sync', { count: speciesCount });
        logDebug('simulation restarted');
        console.log('[VEPA v3] Simulation restarted');
        resetCamera();
        bus.emit('law:sync');
        bus.emit('sim:paused', { paused: false });
    });
    bus.on('species:changed', ({ count }) => {
        speciesCount = Math.max(1, Math.min(count || 1, MAX_SPECIES));
    });

    bus.on('sim:togglePause', () => { paused = !paused; bus.emit('sim:paused', { paused }); });
    bus.on('sim:hardReset', () => {
        console.log('[VEPA v3] Hard reset requested');
        logDebug('hard reset requested', 'warn');
        location.reload();
    });

    bus.on('sim:chaos', () => {
        const shuffled = [];
        for (let i = 0; i < LAW_COUNT; i++) shuffled.push(i);
        for (let i = shuffled.length - 1; i > 0; i--) {
            const j = Math.floor(rng() * (i + 1));
            [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
        }

        const groups = 3 + Math.floor(rng() * 3); // 3-5 groups
        const groupSize = Math.ceil(LAW_COUNT / groups);
        const intensity = 0.3 + rng() * 0.7;

        for (let i = 0; i < LAW_COUNT; i++) lawClear(lawState, i);

        for (let g = 0; g < groups; g++) {
            const start = g * groupSize;
            const end = Math.min(start + groupSize, LAW_COUNT);
            const actProb = 0.4 + rng() * 0.6;
            if (rng() > 0.3) { // 70% chance group activates
                for (let j = start; j < end; j++) {
                    if (rng() < actProb) {
                        lawSet(lawState, shuffled[j]);
                    }
                }
            }
        }

        for (let s = 0; s < speciesCount; s++) {
            for (let p = 0; p < 42; p++) {
                if (rng() > 0.85) {
                    const r = DNA_RANGES[p];
                    const val = r.min + rng() * (r.max - r.min);
                    dnaBuffer[s * 64 + p] = quantizeDNA(val, r.min, r.max);
                }
            }
        }

        const active = getLawCount(lawState);
        logDebug(`chaos multiplexed: ${groups} groups, ${active} laws, ${Math.round(intensity*100)}% intensity`, 'warn');
        bus.emit('law:sync');
        bus.emit('narrative:system', { text: `Chaos multiplexed: ${groups} groups, ${active} laws, ${Math.round(intensity*100)}% intensity` });
    });

    bus.on('sim:chaosClear', () => {
        for (let i = 0; i < LAW_COUNT; i++) {
            lawClear(lawState, i);
        }
        logDebug('all laws cleared', 'warn');
        bus.emit('law:sync');
        bus.emit('narrative:system', { text: 'All laws cleared.' });
    });

    bus.on('sim:chaosSelective', ({ categories }) => {
        const catMap = { physics: true, biology: true, chemistry: true, thermodynamics: true, metaphysics: true };
        const activeCats = {};
        for (const c of categories) { activeCats[c] = true; }
        for (const [catName, cat] of Object.entries(LAW_CATEGORIES)) {
            if (!activeCats[catName]) continue;
            for (const idx of cat.laws) {
                if (rng() > 0.3) {
                    if (rng() > 0.5) {
                        lawSet(lawState, idx);
                    } else {
                        lawClear(lawState, idx);
                    }
                }
            }
        }
        bus.emit('law:sync');
        bus.emit('narrative:system', { text: 'Selective chaos applied.' });
    });

    bus.on('group:declare', ({ name, speciesIds }) => {
        if (!groupRegistry) return;
        const g = declareGroup(groupRegistry, name, speciesIds);
        bus.emit('narrative:system', { text: `Declared group ${g.name}.` });
    });

    bus.on('speciation:split', ({ parent, child }) => {
        speciesCount = Math.max(speciesCount, child + 1);
        if (memoryBuffers) {
            blendMemory(speciesMemory(memoryBuffers, child), speciesMemory(memoryBuffers, parent), worldParams.CULTURAL_TRANSMISSION || 0.5);
        }
        bus.emit('species:sync', { count: speciesCount });
        bus.emit('narrative:system', { text: `Speciation burst: S${parent} diverged into S${child}.` });
    });
    bus.on('speciation:extinct', ({ species }) => {
        bus.emit('narrative:system', { text: `S${species} went extinct — its slot is freed.` });
    });

    bus.on('worldEvent:triggered', ({ type }) => {
        undoRing.commit(currentWorldState());
        const fs = getFields();
        let text = '';
        if (type === 'famine') {
            worldParams = applyWorldParam(worldParams, 'SPAWN_RATE', (worldParams.SPAWN_RATE || 0) + 2);
            if (fs) writeField(fs, 'INFO', worldSize * 0.25, worldSize * 0.25, worldSize * 0.5, -8);
            text = 'Famine confirmed — drought cells written, spawn rate raised.';
        } else if (type === 'bloom') {
            worldParams = applyWorldParam(worldParams, 'SPAWN_RATE', Math.max(0, (worldParams.SPAWN_RATE || 0) - 2));
            if (fs) writeField(fs, 'INFO', worldSize * 0.75, worldSize * 0.75, worldSize * 0.5, 8);
            text = 'Bloom confirmed — fertilization written, spawn rate eased.';
        } else if (type === 'collapse') {
            worldParams = applyWorldParam(worldParams, 'SPAWN_RATE', (worldParams.SPAWN_RATE || 0) + 5);
            worldParams = applyWorldParam(worldParams, 'MUTATION_RATE', (worldParams.MUTATION_RATE || 0) + 0.05);
            if (fs) writeField(fs, 'INFO', worldSize * 0.5, worldSize * 0.5, worldSize * 0.5, 12);
            text = 'Collapse confirmed — emergency spawn + mutation rescue.';
        }
        runtimeConfig.worldParams = worldParams;
        bus.emit('narrative:system', { text: text || `${type} event.` });
        bus.emit('world:paramApplied', { key: 'SPAWN_RATE', value: worldParams.SPAWN_RATE });
    });

    bus.on('epoch:extinction', () => {
        undoRing.commit(currentWorldState());
        const fs = getFields();
        if (fs) writeField(fs, 'INFO', worldSize * 0.25, worldSize * 0.25, worldSize * 0.5, -8);
        bus.emit('narrative:system', { text: 'An extinction epoch has begun — drought cells written.' });
    });
    bus.on('epoch:recovery', () => {
        const fs = getFields();
        if (fs) writeField(fs, 'INFO', worldSize * 0.75, worldSize * 0.75, worldSize * 0.5, 8);
        bus.emit('narrative:system', { text: 'The world recovers — fertilization written.' });
    });
    bus.on('epoch:boundary', ({ era, name }) => {
        bus.emit('narrative:system', { text: `Epoch ${era} begins: ${name}.` });
        // Sequel Phases 5-6: an era boundary is the only place the observer
        // is allowed to compare one world against another, so it is where the
        // continuity fingerprint is sampled and the codex is allowed to speak.
        if (!civilization || !continuity || !codex) return;
        const entry = recordEraContinuity(continuity, civilization, groupRegistry, { tick, era, name });
        const filed = recordCodexEntry(codex, entry);
        if (!filed.ok) {
            // The guard refused, so the observer is told it cannot say anything
            // rather than being allowed to invent a reason.
            bus.emit('codex:uncertain', { tick, reason: filed.reason, regime: null });
            return;
        }
        const c = filed.entry;
        // Well-evidenced regimes are stated; thin ones are announced as guesses.
        bus.emit(c.asserted ? 'codex:regime' : 'codex:uncertain', {
            tick,
            era,
            regime: c.regime,
            statement: c.statement,
            confidence: c.confidence,
            evidence: c.evidence,
        });
    });
    bus.on('epoch:list', () => {
        bus.emit('epoch:listResponse', { eras: epochEngine ? getEpochs(epochEngine) : [] });
    });
    bus.on('epoch:restore', ({ era }) => {
        if (!epochEngine) return;
        const snapshot = getEpochSnapshot(epochEngine, era);
        if (!snapshot) return;
        applyWorldRestore(snapshot);
        bus.emit('narrative:system', { text: `Restored epoch ${era}.` });
    });

    bus.on('agency:action', ({ action }) => {
        undoRing.commit(currentWorldState());
        let text = '';
        if (action.kind === 'param') {
            worldParams = applyWorldParam(worldParams, action.key, action.value);
            runtimeConfig.worldParams = worldParams;
            if (action.key === 'SPAWN_RATE') spawnRate = worldParams.SPAWN_RATE;
            text = `The narrative acts: ${action.key} → ${worldParams[action.key]} (${action.reason}).`;
            bus.emit('world:paramApplied', { key: action.key, value: worldParams[action.key] });
        } else if (action.kind === 'field') {
            const fs = getFields();
            if (fs) writeField(fs, action.name, action.x, action.y, action.z, action.delta);
            text = `The narrative acts: ${action.reason} — ${action.name} field written.`;
        }
        bus.emit('narrative:system', { text: text || 'The narrative acts.' });
    });

    bus.on('world:paramChanged', ({ key, value }) => {
        worldParams = applyWorldParam(worldParams, key, value);
        runtimeConfig.worldParams = worldParams;
        if (key === 'TOROIDAL' && syncWrapLaw(worldParams, lawState)) {
            bus.emit('law:sync');
        }
        switch (key) {
            case 'WORLD_SIZE':
                worldSize = worldParams.WORLD_SIZE;
                setWorldSize(worldSize);
                logDebug('world size set to ' + worldSize);
                break;
            case 'SPAWN_RATE':
                spawnRate = worldParams.SPAWN_RATE;
                break;
            case 'TIME_SPEED':
                runtimeConfig.simSpeed = worldParams.TIME_SPEED;
                break;
            case 'EPOCH_LENGTH':
                if (epochEngine) epochEngine.cfg.epochLength = worldParams.EPOCH_LENGTH;
                break;
            case 'EXTINCTION_THRESHOLD':
                if (epochEngine) epochEngine.cfg.extinctionThreshold = worldParams.EXTINCTION_THRESHOLD;
                break;
            case 'RECOVERY_THRESHOLD':
                if (epochEngine) epochEngine.cfg.recoveryThreshold = worldParams.RECOVERY_THRESHOLD;
                break;
            case 'PARTICLE_COUNT':
            case 'MAX_POP':
                        break;
        }
        bus.emit('world:paramApplied', { key, value });
    });

    // ── Easy Mode ControlProfile (RB) — atomic recipe patch ──
    // One composite slider gesture arrives here as a single changes map. Each
    // key runs through the canonical single-parameter path above (same side
    // effects, same debounced undo snapshot — the pre-change snapshot lands on
    // the first key, so the whole gesture undoes as one step), then one
    // summary event closes the gesture for the Easy surface to re-project.
    bus.on('world:paramsPatch', ({ changes, source, group, t } = {}) => {
        if (!changes || typeof changes !== 'object') return;
        const keys = Object.keys(changes);
        if (!keys.length) return;
        for (const key of keys) {
            bus.emit('world:paramChanged', {
                key,
                value: changes[key],
                source: source || 'controlProfile',
            });
        }
        bus.emit('world:paramsApplied', {
            changes,
            affected: keys,
            source: source || 'controlProfile',
            group,
            t,
        });
    });

}

let lastFrameTime = 0, frameCount = 0, fps = 0;
let perfFrameMs = 0, perfTickMs = 0, perfRenderMs = 0;
const PERF_EMA = 0.15;
function emaPerf(prev, next) { return prev + (next - prev) * PERF_EMA; }


function wireGoalEvents() {
    bus.on('goal:adjusted', (adj) => {
        switch (adj.parameter) {
            case 'scanInterval': if (insightEngine) insightEngine.cfg.scanInterval = adj.newValue; break;
            case 'clusterRadius': if (insightEngine) insightEngine.cfg.clusterRadius = adj.newValue; break;
            case 'maxForce': runtimeConfig.maxForce = adj.newValue; break;
            case 'drag': runtimeConfig.dragMultiplier = adj.newValue; break;
            case 'birthRate': runtimeConfig.birthRate = adj.newValue; break;
            case 'deathRate': runtimeConfig.deathRate = adj.newValue; break;
        }
        bus.emit('goal:applied', adj);
    });
    bus.on('timeline:scrubTo', (tickIndex) => {
        const entry = timelineScrub(timelineEngine, tickIndex);
        if (!entry || !entry.data) return;
        particleView.set(entry.data);
        if (entry.metadata && entry.metadata.particleCount) particleCount = entry.metadata.particleCount;
        intelligenceCadence.reset();
        tick = entry.tick;
        bus.emit('timeline:restored', { index: entry.index, tick: entry.tick });
    });
    bus.on('timeline:record', ({ enabled }) => {
        timelineRecording = !!enabled;
        bus.emit('timeline:recording', { enabled: timelineRecording, count: getTimelineList(timelineEngine).length });
    });
    bus.on('timeline:clear', () => {
        clearTimelineEngine(timelineEngine);
        bus.emit('timeline:cleared');
    });
}

function getMetrics() { return intelligenceCadence.getMetrics(); }
function adaptCultureFromMetrics(buffers, metrics) {
    return intelligenceCadence.adaptCultureFromMetrics(buffers, metrics);
}

/** Run insight, narrative, lineage, timeline, and goal engines each tick. */
function updateIntelligence() {
    // The cadence module protects the frame loop and avoids scanning while
    // the worker owns the live particle buffer.
    intelligenceCadence.run(updateIntelligenceCore);
}

function updateIntelligenceCore() {
    if (!particleView || !particleCount) return;

    // Insight — spatio-temporal cluster detection. v8.1.1: gated on active
    // laws + particle motion so a fresh lawless/static world stays silent.
    if (insightEngine) {
        updateInsight(insightEngine, particleView, particleCount, PARTICLE_STRIDE, worldSize, {
            lawActiveCount: getLawCount(lawState),
            motionGate: true,
        });
    }

    // Narrative — paced multi-voice commentary on engine events
    if (narrativeEngine) {
        updateNarrative(narrativeEngine, particleView, particleCount, PARTICLE_STRIDE);
    }

    // Lineage — death transitions (births are tracked in spawnOffspring).
    // Scanned on a cadence: deaths are rare events, and the O(N) pass is
    // pure per-frame overhead otherwise.
    intelligenceCadence.scanDeaths();

    // Timeline — recording snapshots on a fixed cadence
    if (timelineEngine && timelineRecording && tick % TIMELINE_SNAPSHOT_INTERVAL === 0) {
        const data = new Float32Array(particleView.buffer.slice(0));
        timelineSnapshot(timelineEngine, data, { tick, particleCount });
        bus.emit('timeline:snapshot', { count: getTimelineList(timelineEngine).length });
    }

    // Goal engine — evaluate and self-tune world constraints. v8.1.1: only
    // autotune while laws are active; on a lawless world the adjustments
    // were pure log noise.
    const metrics = getMetrics();
    if (goalEngine && metrics.lawActiveCount > 0) {
        updateGoal(goalEngine, metrics);
    }

    // Group registry (Set F.1) — declared + detected social groups. Same
    // law/motion gate as insight: a fresh lawless world forms nothing.
    if (groupRegistry && metrics.lawActiveCount > 0) {
        const groupEvents = updateGroups(groupRegistry, particleView, particleCount, PARTICLE_STRIDE, null, {
            lawActiveCount: metrics.lawActiveCount,
        });
        for (const ev of groupEvents) bus.emit(ev.type, ev);
        // Social/economic systems run on a cadence — they don't need 60 Hz and
        // their per-group/member scans are pure overhead on the hot path.
        if (tick % SOCIAL_CADENCE === 0) {
            // Construction (F.2) — nests/hives + roads into the field grid.
            applyConstructions(groupRegistry, getFields(), { tick });
            // Economy (F.3) — treasury, pairwise trade, market prices.
            const eco = runEconomy(groupRegistry, particleView, particleCount, getFields(), { tick });
            if (eco.trades > 0) bus.emit('economy:trade', eco);
            // Artifacts (Set I.1) — treasury-funded TOOL/WEAPON/BARRIER inventory:
            // tools pay an income dividend, weapons damp threat memory (H.2 flee),
            // barriers write impassable wall cells at the territory edge.
            const art = runArtifacts(groupRegistry, getFields(), { tick, worldParams, memoryBuffers });
            if (art.crafted > 0 || art.decayed > 0 || art.walls > 0) bus.emit('artifacts:pass', art);
            // Governance (Set J.1) — per-group policy vector (aggression/openness/
            // migration) from member memory + treasury; alliances pool treasuries,
            // conflicts write tension at the border and raise threat memory; policy
            // drives raids / commerce / dispersal.
            const gov = runGovernance(groupRegistry, particleView, PARTICLE_STRIDE, getFields(), { tick, worldParams, memoryBuffers });
            for (const ev of gov.events) {
                bus.emit(ev.type, ev);
                // Phase 3: alliances move culture between the two groups. This
                // is what makes the culture system react to the rest of the
                // social stack instead of sitting inert beside it.
                if (civilization && ev.type === 'governance:alliance') {
                    const sent = transmitBetweenGroups(civilization, ev.group, ev.other, {
                        fidelity: CULTURE_ALLIANCE_FIDELITY,
                    });
                    if (sent) {
                        bus.emit('culture:transmitted', {
                            from: ev.group, to: ev.other, tick,
                            retained: sent.retained.length,
                            mutated: sent.mutated.length,
                            lost: sent.lost.length,
                            invented: sent.invented.length,
                        });
                    }
                }
            }
            // Infrastructure (Set K.1) — extract ambient field energy into the
            // treasury (conserved), allied grids feed member ENERGY, and
            // era-progressed mega-structures (WALL/BRIDGE/HUB) execute on target.
            const inf = runInfrastructure(groupRegistry, particleView, PARTICLE_STRIDE, getFields(), {
                tick, worldParams, era: epochEngine ? epochEngine.era : 0,
            });
            for (const ev of inf.events) bus.emit(ev.type, ev);
            // Civilization ontology (culture / kin / federation / polity).
            // Each detected group is founded a culture exactly once, then the
            // registry ages its own cohesion and prunes dead members. This is
            // the runtime path for src/state/systemLifecycle.js.
            if (civilization) {
                for (const g of groupRegistry.groups.values()) {
                    if (civilization.cultures.size >= MAX_CIVILIZATION_CULTURES) break;
                    const key = `group:${g.id}`;
                    if (!civilization.lifecycle.records.has(`culture-memory:${key}`)) {
                        foundCulture(civilization, g.id, {
                            name: `culture-of-${g.name || g.id}`,
                            symbols: CULTURE_SEED_SYMBOLS.slice(0, 2 + (g.id % 3)),
                        });
                    }
                }
                // Federate the strongest groups so tribe/clan identity is
                // reachable without a separate authoring step.
                if (civilization.federations.size === 0 && groupRegistry.groups.size >= 2) {
                    const ids = [...groupRegistry.groups.keys()].slice(0, 6);
                    const fed = createFederation(civilization, { name: 'first-tribe', kind: 'tribe' });
                    for (const gid of ids) addFederationMember(civilization, fed.id, gid);
                }
                stepCivilization(civilization, { tick });
            }
            // Sequel Phase 4 — durable structures. Each group founds a nest
            // once, then upkeep is paid out of its treasury on a slower
            // cadence than the social pass. Upkeep is deliberately partial
            // (STRUCTURE_UPKEEP_RATIO of groups by treasury rank): a society
            // that cannot pay for all of its buildings should visibly lose
            // some of them, which is the whole point of modelling ownership.
            if (structures && tick % STRUCTURE_MAINTENANCE_INTERVAL === 0) {
                const live = [...groupRegistry.groups.values()].filter((g) => g.members.size > 0);
                for (const g of live) {
                    if (structures.byId.size >= MAX_STRUCTURES) break;
                    if (!structureForGroup(structures, g.id)) {
                        foundStructure(structures, g.id, {
                            kind: 'NEST',
                            x: g.cx, y: g.cy, z: g.cz,
                        });
                    }
                }
                const fundable = live
                    .slice()
                    .sort((a, b) => (b.treasury || 0) - (a.treasury || 0))
                    .slice(0, Math.max(1, Math.floor(live.length * STRUCTURE_UPKEEP_RATIO)));
                const maintain = new Set();
                for (const g of fundable) {
                    for (const id of structures.byId.keys()) {
                        const rec = structures.lifecycle.records.get(id);
                        if (rec && rec.attributes.ownerGroupId === g.id) maintain.add(id);
                    }
                }
                const up = runMaintenance(structures, groupRegistry, { tick, maintain });
                if (up.maintained || up.decayed || up.collapsed.length) {
                    bus.emit('structures:pass', { tick, ...up, report: structureReport(structures) });
                }
            }
        }
    }
    // Set L — Exotic Matter (L.1): EXOTIC field zones tag particles with
    // antimatter/dark/strange/negative states — annihilation bursts conserved
    // energy, dark matter dims and self-powers, strange matter converts
    // neighbours, negative mass repels from density. Ambient: runs whenever
    // laws are active, gated on its own cadence.
    if (exoticState && metrics.lawActiveCount > 0) {
        const exo = stepExoticMatter(exoticState, particleView, particleCount, PARTICLE_STRIDE, getFields(), {
            tick, worldParams,
        });
        if (exo.annihilated > 0 || exo.converted > 0) bus.emit('exotic:pass', exo);
    }
    // Set M — Relativity (M.1–M.4): mass-warped CURVATURE field, gravitational
    // lensing of the INFO medium toward curvature peaks, velocity time
    // dilation on AGE/HUNGER, and E=mc² energy↔mass conversion. Ambient:
    // runs whenever laws are active, gated on its own cadence.
    if (metrics.lawActiveCount > 0) {
        const rel = stepRelativity(particleView, particleCount, PARTICLE_STRIDE, getFields(), {
            tick, worldParams,
        });
        if (rel.condensed > 0 || rel.converted > 0) bus.emit('relativity:pass', rel);
    }
    // Set N — Quantum Macroscale (N.1–N.4): deterministic superposition with
    // collapse-on-interaction, macro entanglement (reuses stride 75–76),
    // ENERGY-gated wall tunneling, and DNA-gated observer collapse. Ambient:
    // runs whenever laws are active, gated on its own cadence.
    if (quantumState && metrics.lawActiveCount > 0) {
        const qm = stepQuantumMacro(quantumState, particleView, particleCount, PARTICLE_STRIDE, getFields(), {
            tick, worldParams, dnaBuffer,
        });
        if (qm.collapsed > 0 || qm.tunneled > 0 || qm.observed > 0) bus.emit('quantum:pass', qm);
    }
    // Set O — Stellar Physics (O.1–O.3): dense cells seed stars that fuse
    // accreted mass into radiant output, collapse to black holes past a
    // horizon, and detonate as supernovae past a mass cap. Ambient: runs
    // whenever laws are active, gated on its own cadence.
    if (stellarState && metrics.lawActiveCount > 0) {
        const st = stepStellar(stellarState, particleView, particleCount, PARTICLE_STRIDE, getFields(), {
            tick, worldParams,
        });
        if (st.formed > 0 || st.blackHoles > 0 || st.supernovae > 0) bus.emit('stellar:pass', st);
    }
    // Set P — Synthetic Life (P.1–P.3): synthetic organisms from HUBs, uploaded
    // consciousness at intelligence threshold, machine groups in the F.1 registry.
    if (syntheticState && metrics.lawActiveCount > 0) {
        const syn = stepSynthetic(syntheticState, particleView, particleCount, PARTICLE_STRIDE, getFields(), {
            tick, worldParams, groupRegistry, era: epochEngine ? epochEngine.era : 0,
            maxParticles: MAX_PARTICLES,
        });
        if (syn.spawned > 0 || syn.uploaded > 0 || syn.decayed > 0) bus.emit('synthetic:pass', syn);
    }
    // Speciation (Set A.1) — DNA-slot taxa split when SPECIATION_THRESHOLD ×
    // field isolation is exceeded; children claim extinct-freed slots.
    if (speciationEngine && metrics.lawActiveCount > 0) {
        const specEvents = updateSpeciation(speciationEngine, particleView, particleCount, PARTICLE_STRIDE, dnaBuffer, worldSize, {
            lawActiveCount: metrics.lawActiveCount,
            fieldSystem: getFields(),
        });
        for (const ev of specEvents) bus.emit(ev.type, ev);
    }
    // Epochs (Set D.1) — era boundaries, full-world snapshots, extinction/recovery.
    if (epochEngine) {
        const epochEvents = updateEpoch(epochEngine, particleView, particleCount, PARTICLE_STRIDE, {
            tick,
            captureFn: () => captureWorldState({
                view: particleView,
                count: particleCount,
                speciesCount,
                dna: dnaBuffer,
                laws: lawState,
                worldParams,
                runtime: runtimeConfig,
                worldSize,
                tick,
                name: `Epoch ${epochEngine.era}`,
                civilization: civilization ? serializeCivilization(civilization) : null,
                codex: codex ? serializeCodex(codex) : null,
            }),
        });
        for (const ev of epochEvents) bus.emit(ev.type, ev);
    }
    // Memory & Culture (Set G) — persistent species/group memory: cultural
    // transmission (group ← member species), behavioral adaptation from
    // energy/density/epoch conditions, then decay + group prune.
    if (memoryBuffers) {
        if (groupRegistry) {
            const liveGroups = new Set(groupRegistry.groups.keys());
            for (const g of groupRegistry.groups.values()) {
                const gmem = groupMemory(memoryBuffers, g.id);
                for (const sp of g.species || []) {
                    blendMemory(gmem, speciesMemory(memoryBuffers, sp), (worldParams.CULTURAL_TRANSMISSION || 0.5) * 0.2);
                }
            }
            pruneGroupMemory(memoryBuffers, liveGroups);
        }
        if (tick % 60 === 0) {
            adaptCultureFromMetrics(memoryBuffers, metrics);
            decayMemory(memoryBuffers);
            // Set H.2 — re-derive per-species goals from the updated memory.
            speciesGoals = computeSpeciesGoals(memoryBuffers, Object.keys(metrics.speciesPop || {}).map(Number));
        }
    }
    // Set H.2 — goal-driven velocity nudges (seek / flee from memory goals).
    if (speciesGoals.size > 0) {
        applyGoalNudges(particleView, particleCount, PARTICLE_STRIDE, speciesGoals, worldSize);
    }
    // Set H.1 — the narrative actor may take one bounded, reversible action.
    if (agencyEngine) {
        const agencyEvents = updateAgency(agencyEngine, {
            metrics,
            extinctionOpen: epochEngine ? epochEngine.extinctionOpen : false,
            spawnRate,
            worldSize,
        });
        for (const ev of agencyEvents) bus.emit(ev.type, ev);
    }
    if (tick % 30 === 0) {
        // Set H.3 — world milestones (once-only quests).
        for (const m of detectMilestones(metrics, seenMilestones)) {
            bus.emit('narrative:system', { text: m.text });
        }
        bus.emit('sim:metrics', metrics);
        if (groupRegistry) {
            bus.emit('groups:analytics', { registry: groupRegistry, metrics });
        }
        if (ecoEngine) {
            bus.emit('eco:analytics', { eco: ecoEngine });
        }
        if (civilization) {
            const report = civilizationReport(civilization);
            // Sequel Phases 4-6 ride along with the existing civilization
            // dashboard rather than claiming a new tab: structures, the
            // continuity regime and the codex are all the same story.
            report.structures = structures ? structureReport(structures) : null;
            report.continuity = continuity ? regimeHistogram(continuity) : null;
            report.codex = codex ? codexReport(codex) : null;
            report.latestRegime = continuity ? latestRegime(continuity) : null;
            bus.emit('civilization:analytics', { report });
        }
    }
}

/** Reset intelligence state on simulation restart. */
function resetIntelligence() {
    if (intelligenceCadence) intelligenceCadence.reset();
    if (narrativeEngine) resetNarrativeEngine(narrativeEngine, WORKER_SEED);
    if (insightEngine) { insightEngine.frame = 0; insightEngine.history = []; insightEngine.lastClusters = null; }
    if (goalEngine) { goalEngine.frame = 0; goalEngine.history = []; }
    if (timelineEngine) clearTimelineEngine(timelineEngine);
    if (groupRegistry) { groupRegistry.groups.clear(); groupRegistry.nextId = 1; groupRegistry.frame = 0; groupRegistry.events.length = 0; groupRegistry.tradeLog.length = 0; groupRegistry.craftLog.length = 0; }
    // Set A — reset speciation state (fresh slot census), eco ring and event
    // baseline on every restart so nothing carries across worlds.
    if (speciationEngine) {
        speciationEngine.pending.length = 0;
        speciationEngine.seenSpecies.clear();
        speciationEngine.splits.length = 0;
        speciationEngine.frame = 0;
    }
    if (ecoEngine) { ecoEngine.ring.length = 0; ecoEngine.foodWeb.clear(); ecoEngine.niches.clear(); ecoEngine.splits.length = 0; ecoEngine.extinct.length = 0; }
    // Civilization ontology is per-world: nothing carries across a restart.
    civilization = createCivilizationRegistry();
    // Structures and the observer's memory are scoped to that same world, so
    // a restart must not leave a nest standing in an empty registry.
    structures = createStructureRegistry(civilization.lifecycle);
    continuity = createContinuityCatalog();
    codex = createCodex();
    if (worldEventEngine) {
        worldEventEngine.baselineTotal = 0;
        worldEventEngine.baselineEnergy = 0;
        worldEventEngine.samples = 0;
        worldEventEngine.confirm = 0;
        worldEventEngine.cooldownUntil = 0;
        worldEventEngine.events.length = 0;
    }
    if (epochEngine) resetEpoch(epochEngine);
    if (memoryBuffers) resetMemoryBuffers(memoryBuffers);
    exoticState = createExoticState(particleCount);
    quantumState = createQuantumState(particleCount);
    stellarState = createStellarState();
    if (agencyEngine) resetAgency(agencyEngine);
    speciesGoals = new Map();
    seenMilestones.clear();
}

function renderLoop(now) {
    const loopStart = performance.now();
    requestAnimationFrame(renderLoop);
    frameCount++;
    if (now - lastFrameTime >= 1000) {
        fps = frameCount;
        frameCount = 0;
        lastFrameTime = now;
    }

    // Chaos Multiplex mode — step + render every shard, shared camera.
    if (multiplexController && multiplexController.isActive()) {
        const stepStart = loopStart;
        multiplexController.step(DT, runtimeConfig.simSpeed, worldSize);
        const stepEnd = performance.now();
        multiplexController.render(worldSize);
        const loopEnd = performance.now();
        perfTickMs = emaPerf(perfTickMs, stepEnd - stepStart);
        perfRenderMs = emaPerf(perfRenderMs, loopEnd - stepEnd);
        perfFrameMs = emaPerf(perfFrameMs, loopEnd - loopStart);
        const mx = multiplexController.mx || {};
        // summarizeMultiplex scans every shard particle — throttle to ~5 Hz.
        if (frameCount % 12 === 0) updateLiveStats({
            fps,
            tick: mx.tick || 0,
            particles: summarizeMultiplex(mx).alive,
            species: 0,
            laws: 0,
            frameMs: perfFrameMs,
            tickMs: perfTickMs,
            renderMs: perfRenderMs,
        });
        return;
    }

    // Always render (so paused state still shows particles)
    // Physics only runs when not paused
    if (!paused) {
    // Main-thread physics
    if (particleView) {
        const tickStart = performance.now();
        const solvedLocally = solve(particleView, particleCount, PARTICLE_STRIDE, lawState, dnaBuffer, worldSize, DT * runtimeConfig.simSpeed, rng);
        if (solvedLocally) {
            // Population mutation is part of the extracted manager; worker
            // ticks reach the same operation from finishPhysicsTick().
            advancePopulation();
            tick++;
            updateIntelligence();
            perfTickMs = emaPerf(perfTickMs, performance.now() - tickStart);
            updateLiveStats({ fps, tick, particles: particleCount, species: speciesCount, laws: getLawCount(lawState), frameMs: perfFrameMs, tickMs: perfTickMs, renderMs: perfRenderMs });
            // On-screen canvas debug overlay (first 2 seconds, debug overlay only)
            if (isDebugVisible() && tick <= 130) {
                const dbg = renderer.ctx;
                if (dbg) {
                    dbg.save();
                    dbg.font = '10px monospace';
                    dbg.fillStyle = 'rgba(0,0,0,0.7)';
                    dbg.fillRect(4, 38, 320, tick === 1 ? 120 : 70);
                    dbg.fillStyle = '#0f0';
                    dbg.textAlign = 'left';
                    dbg.textBaseline = 'top';
                    let ly = 40;
                    if (tick === 1) {
                        // Live particle count
                        let aliveCount = 0, deadCount = 0, nanPos = 0;
                        for (let di = 0; di < particleCount; di++) {
                            const dbb = di * PARTICLE_STRIDE;
                            const d = particleView[dbb + STRIDE_INDEXES.DEAD];
                            const px = particleView[dbb], py = particleView[dbb + 1];
                            if (d >= 0.5) deadCount++;
                            else if (px !== px || py !== py) nanPos++;
                            else aliveCount++;
                        }
                        dbg.fillStyle = '#ff0';
                        dbg.fillText('PARTICLES: ' + particleCount + ' | Alive: ' + aliveCount + ' Dead: ' + deadCount + ' NaN: ' + nanPos, 8, ly); ly += 14;
                        dbg.fillText('CANVAS: ' + renderer.width + 'x' + renderer.height + ' | Laws: ' + getLawCount(lawState), 8, ly); ly += 14;
                        const p0 = particleView[0], p1 = particleView[1], p2 = particleView[2];
                        const c0 = particleView[0 + STRIDE_INDEXES.COLOR_R], c1 = particleView[0 + STRIDE_INDEXES.COLOR_G], c2 = particleView[0 + STRIDE_INDEXES.COLOR_B];
                        const a = particleView[0 + STRIDE_INDEXES.ALPHA];
                        const d0 = particleView[0 + STRIDE_INDEXES.DEAD];
                        dbg.fillStyle = '#0ff';
                        dbg.fillText('POS: (' + p0.toFixed(1) + ',' + p1.toFixed(1) + ',' + p2.toFixed(1) + ') DEAD:' + d0.toFixed(2) + ' ALPHA:' + a.toFixed(2), 8, ly); ly += 14;
                        dbg.fillText('COLOR: rgb(' + c0 + ',' + c1 + ',' + c2 + ') | MASS:' + particleView[6].toFixed(2) + ' NRG:' + particleView[50].toFixed(1), 8, ly); ly += 14;
                        dbg.fillText('AGE:' + particleView[51].toFixed(0) + ' HUNGER:' + particleView[62].toFixed(2) + ' TEMP:' + particleView[66].toFixed(2), 8, ly); ly += 14;
                    }
                    // Always show FPS in debug
                    dbg.fillStyle = '#0f0';
                    dbg.fillText('FPS: ' + fps + ' TICK: ' + tick, 8, ly);
                    dbg.restore();
                }
            }
            bus.emit('physics:tick', { tick, buffer: particleBuffer, particleCount, speciesCount });
        }
    } // end solvedLocally (worker mode emits via finishPhysicsTick instead)

    } // end if (!paused)

    // Render (always, even when paused)
    if (renderer && particleBuffer) {
        const renderStart = performance.now();
        renderer.paused = paused;
        syncSprites(renderer, particleView, particleCount, PARTICLE_STRIDE, worldSize, lawState);
        perfRenderMs = emaPerf(perfRenderMs, performance.now() - renderStart);
        perfFrameMs = emaPerf(perfFrameMs, performance.now() - loopStart);
    }
}

// Global errors and unhandled rejections are captured by src/debug.js into
// the debug overlay (single message log for the whole page session).
boot().catch(e => {
    console.error('BOOT ERROR:', e);
    logDebug('BOOT ERROR: ' + (e.stack || e.message || e), 'error');
});
