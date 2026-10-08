const ID_PATTERN = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;
const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

export class ModuleCompositionError extends Error {
  constructor(issues) {
    super(`Module composition failed:\n${issues.map((issue) => `- ${issue}`).join('\n')}`);
    this.name = 'ModuleCompositionError';
    this.issues = Object.freeze([...issues]);
  }
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validateStringList(value, label, issues, { pattern } = {}) {
  if (!Array.isArray(value)) {
    issues.push(`${label} must be an array`);
    return [];
  }

  const seen = new Set();
  for (const item of value) {
    if (typeof item !== 'string' || item.length === 0 || (pattern && !pattern.test(item))) {
      issues.push(`${label} contains an invalid value`);
      continue;
    }
    if (seen.has(item)) issues.push(`${label} contains duplicate "${item}"`);
    seen.add(item);
  }
  return [...seen];
}

function validateEntrypoints(value, label, issues) {
  if (!isRecord(value)) {
    issues.push(`${label} must be an object mapping entrypoint names to relative paths`);
    return {};
  }

  const entrypoints = {};
  for (const [name, path] of Object.entries(value)) {
    const segments = typeof path === 'string' ? path.split(/[\\/]+/) : [];
    if (!ID_PATTERN.test(name) || typeof path !== 'string' || !path.trim() || path.startsWith('/') || /^[a-z]:/i.test(path) || segments.includes('..')) {
      issues.push(`${label} has an invalid entrypoint name or relative path`);
      continue;
    }
    entrypoints[name] = path;
  }
  return entrypoints;
}

function validatePorts(value, label, issues) {
  if (!isRecord(value)) {
    issues.push(`${label} must be an object mapping port names to contract versions`);
    return {};
  }

  const ports = {};
  for (const [name, version] of Object.entries(value)) {
    if (!ID_PATTERN.test(name) || typeof version !== 'string' || !version.trim()) {
      issues.push(`${label} has an invalid port or contract version`);
      continue;
    }
    ports[name] = version;
  }
  return ports;
}

function normalizeManifest(manifest, index, issues) {
  const label = `manifest[${index}]`;
  if (!isRecord(manifest)) {
    issues.push(`${label} must be an object`);
    return null;
  }

  const { id, version } = manifest;
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) issues.push(`${label}.id is invalid`);
  if (typeof version !== 'string' || !SEMVER_PATTERN.test(version)) issues.push(`${label}.version must be semantic versioning`);

  const entrypoints = validateEntrypoints(manifest.entrypoints, `${label}.entrypoints`, issues);
  const dependencies = validateStringList(manifest.dependencies, `${label}.dependencies`, issues, { pattern: ID_PATTERN });
  const owns = validateStringList(manifest.owns, `${label}.owns`, issues);
  const capabilities = validateStringList(manifest.capabilities, `${label}.capabilities`, issues);
  const requiredCapabilities = validateStringList(manifest.requiredCapabilities, `${label}.requiredCapabilities`, issues);
  const tests = validateStringList(manifest.tests, `${label}.tests`, issues);
  const migrations = validateStringList(manifest.migrations, `${label}.migrations`, issues);
  const provides = validatePorts(manifest.provides, `${label}.provides`, issues);
  const requires = validatePorts(manifest.requires, `${label}.requires`, issues);

  for (const hook of ['start', 'dispose', 'mountUI']) {
    if (manifest[hook] !== undefined && typeof manifest[hook] !== 'function') {
      issues.push(`${label}.${hook} must be a function when supplied`);
    }
  }

  return { ...manifest, id, version, entrypoints, dependencies, owns, capabilities, requiredCapabilities, tests, migrations, provides, requires };
}

/**
 * Validate manifests and return a stable dependency-first module order.
 * Port contract compatibility is exact by design until a version policy is approved.
 */
export function createCompositionPlan(manifests, { capabilities = [] } = {}) {
  const issues = [];
  if (!Array.isArray(manifests)) throw new ModuleCompositionError(['manifests must be an array']);
  const hostCapabilities = validateStringList(capabilities, 'host capabilities', issues);
  const normalized = manifests.map((manifest, index) => normalizeManifest(manifest, index, issues)).filter(Boolean);
  const byId = new Map();

  for (const module of normalized) {
    if (byId.has(module.id)) issues.push(`duplicate module id "${module.id}"`);
    else byId.set(module.id, module);
  }

  const owners = new Map();
  const providedPorts = new Map();
  const availableCapabilities = new Set(hostCapabilities);
  for (const module of normalized) {
    for (const stateKey of module.owns) {
      if (owners.has(stateKey)) issues.push(`state "${stateKey}" is owned by both "${owners.get(stateKey)}" and "${module.id}"`);
      else owners.set(stateKey, module.id);
    }
    for (const capability of module.capabilities) availableCapabilities.add(capability);
    for (const [port, contractVersion] of Object.entries(module.provides)) {
      if (providedPorts.has(port)) issues.push(`port "${port}" is provided by both "${providedPorts.get(port).id}" and "${module.id}"`);
      else providedPorts.set(port, { id: module.id, contractVersion });
    }
  }

  for (const module of normalized) {
    for (const dependency of module.dependencies) {
      if (!byId.has(dependency)) issues.push(`module "${module.id}" depends on missing module "${dependency}"`);
    }
    for (const capability of module.requiredCapabilities) {
      if (!availableCapabilities.has(capability)) issues.push(`module "${module.id}" requires unavailable capability "${capability}"`);
    }
    for (const [port, contractVersion] of Object.entries(module.requires)) {
      const provider = providedPorts.get(port);
      if (!provider) issues.push(`module "${module.id}" requires unprovided port "${port}"`);
      else if (provider.contractVersion !== contractVersion) {
        issues.push(`module "${module.id}" requires ${port}@${contractVersion}, but "${provider.id}" provides ${port}@${provider.contractVersion}`);
      }
    }
  }

  if (issues.length) throw new ModuleCompositionError(issues);

  const indegree = new Map(normalized.map(({ id }) => [id, 0]));
  const dependents = new Map(normalized.map(({ id }) => [id, []]));
  const effectiveDependencies = new Map(normalized.map(({ id, dependencies }) => [id, new Set(dependencies)]));
  for (const module of normalized) {
    for (const port of Object.keys(module.requires)) {
      effectiveDependencies.get(module.id).add(providedPorts.get(port).id);
    }
  }
  for (const module of normalized) {
    for (const dependency of effectiveDependencies.get(module.id)) {
      indegree.set(module.id, indegree.get(module.id) + 1);
      dependents.get(dependency).push(module.id);
    }
  }

  const ready = [...indegree].filter(([, degree]) => degree === 0).map(([id]) => id).sort();
  const ordered = [];
  while (ready.length) {
    const id = ready.shift();
    ordered.push(byId.get(id));
    for (const dependent of dependents.get(id).sort()) {
      const degree = indegree.get(dependent) - 1;
      indegree.set(dependent, degree);
      if (degree === 0) {
        ready.push(dependent);
        ready.sort();
      }
    }
  }

  if (ordered.length !== normalized.length) {
    const cycleMembers = [...indegree].filter(([, degree]) => degree > 0).map(([id]) => id).sort();
    throw new ModuleCompositionError([`dependency cycle involves: ${cycleMembers.join(', ')}`]);
  }

  return Object.freeze(ordered);
}

/** Start modules in plan order and return an idempotent reverse-order disposer. */
export async function startComposition(plan, context) {
  if (!Array.isArray(plan)) throw new TypeError('composition plan must be an array');
  const started = [];
  try {
    for (const module of plan) {
      // Include the module before awaiting startup so its dispose hook can
      // release partially acquired resources if startup itself rejects.
      started.push(module);
      if (module.start) await module.start(context);
      if (module.mountUI) await module.mountUI(context);
    }
  } catch (error) {
    const cleanupErrors = await disposeModules(started, context);
    if (cleanupErrors.length && error && typeof error === 'object') error.cleanupErrors = cleanupErrors;
    throw error;
  }

  let disposal;
  return () => {
    if (!disposal) disposal = disposeModules(started, context).then((errors) => {
      if (errors.length) throw new AggregateError(errors, 'One or more modules failed to dispose');
    });
    return disposal;
  };
}

async function disposeModules(started, context) {
  const errors = [];
  for (const module of [...started].reverse()) {
    try {
      if (module.dispose) await module.dispose(context);
    } catch (error) {
      errors.push(error);
    }
  }
  return errors;
}
