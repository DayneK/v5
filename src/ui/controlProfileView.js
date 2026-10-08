/**
 * VEPA4 — Easy Mode control surfaces (DOM layer)
 *
 * Mounts the per-surface EASY | ADVANCED toggle and, in Easy mode, the
 * composite recipe sliders built from the ControlProfile schema. Advanced
 * mode shows the existing full panels untouched — every current setting stays
 * reachable (RB acceptance: nothing is hidden from saves or Advanced).
 *
 * Interaction contract per recipe slider:
 *  - `input`  → live before/after preview of every target it would write
 *  - `change` → one atomic `world:paramsPatch` (world) or one `dna:changed`
 *    after writing the whole recipe (species) — one gesture, one sync
 *
 * The view never writes simulation state itself; it only previews and emits.
 */
import { runtimeConfig } from '../state/runtimeConfig.js';
import {
  WORLD_EASY_GROUPS,
  SPECIES_EASY_GROUPS,
  previewWorldEasy,
  previewSpeciesEasy,
  applySpeciesEasy,
  projectWorldEasy,
  projectSpeciesEasy,
} from '../state/controlProfile.js';
import { readControlModes, writeControlMode } from '../state/controlMode.js';

/* ── Formatting ─────────────────────────────────────────────────────────── */

function decimalsOf(step) {
  if (!Number.isFinite(step) || step <= 0) return 2;
  const s = String(step);
  const i = s.indexOf('.');
  if (s.includes('e')) {
    const [m, e] = s.split('e');
    return Math.max(0, decimalsOf(m) - parseInt(e, 10));
  }
  return i === -1 ? 0 : Math.min(4, s.length - i - 1);
}

function fmt(v, step) {
  if (!Number.isFinite(v)) return '—';
  const d = decimalsOf(step);
  return String(Number(v.toFixed(d)));
}

function valuesText(summary) {
  return summary.map((s) => `${s.label} ${fmt(s.before, s.step)}`).join(' · ');
}

function previewText(summary, t) {
  return summary
    .map((s) => `${s.label} ${fmt(s.before, s.step)} → ${fmt(s.after, s.step)}`)
    .join(' · ');
}

/* ── Mode toggle bar ────────────────────────────────────────────────────── */

function buildModeBar(id, surface, mode, onChange) {
  const bar = document.createElement('div');
  bar.id = id;
  bar.className = 'control-mode-bar';
  const group = document.createElement('div');
  group.className = 'view-mode-group control-mode-toggle';
  group.setAttribute('role', 'group');
  group.setAttribute('aria-label', `${surface} control mode`);
  for (const m of ['easy', 'advanced']) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'view-mode-toggle' + (mode === m ? ' active' : '');
    btn.dataset.mode = m;
    btn.dataset.testid = `${surface}-mode-${m}`;
    btn.textContent = m === 'easy' ? 'EASY' : 'ADVANCED';
    btn.setAttribute('aria-pressed', String(mode === m));
    btn.addEventListener('click', () => onChange(m));
    group.appendChild(btn);
  }
  bar.appendChild(group);
  const hint = document.createElement('span');
  hint.className = 'control-mode-hint';
  hint.textContent = 'grouped recipes — Advanced exposes every parameter';
  bar.appendChild(hint);
  return bar;
}

function syncModeBar(bar, mode) {
  bar.querySelectorAll('[data-mode]').forEach((btn) => {
    const active = btn.dataset.mode === mode;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-pressed', String(active));
  });
}

/* ── Easy group row ─────────────────────────────────────────────────────── */

function buildGroupRow({ surface, groupId, label, t, customized, summary, effect, onInput, onApply }) {
  const row = document.createElement('div');
  row.className = 'easy-group' + (customized ? ' customized' : '');
  row.dataset.group = groupId;

  const head = document.createElement('div');
  head.className = 'easy-head';
  const title = document.createElement('span');
  title.className = 'easy-title';
  title.textContent = label || groupId;
  const flag = document.createElement('span');
  flag.className = 'easy-flag';
  flag.dataset.testid = `${surface}-customized-${groupId}`;
  flag.textContent = customized ? 'CUSTOMIZED · ADVANCED' : '';
  head.appendChild(title);
  head.appendChild(flag);

  const slider = document.createElement('input');
  slider.type = 'range';
  slider.className = 'easy-slider';
  slider.min = '0';
  slider.max = '1';
  slider.step = '0.001';
  slider.value = String(Math.min(1, Math.max(0, t)));
  slider.dataset.testid = `${surface}-easy-${groupId}`;
  slider.setAttribute('aria-label', `${groupId} recipe`);

  const values = document.createElement('div');
  values.className = 'easy-values';
  values.textContent = valuesText(summary);

  const preview = document.createElement('div');
  preview.className = 'easy-preview';
  preview.dataset.testid = `${surface}-preview-${groupId}`;

  const note = document.createElement('div');
  note.className = 'easy-note';
  note.textContent = effect || '';

  slider.addEventListener('input', () => onInput(parseFloat(slider.value), preview, summary));
  slider.addEventListener('change', () => onApply(parseFloat(slider.value), preview));

  row.appendChild(head);
  row.appendChild(slider);
  row.appendChild(values);
  row.appendChild(preview);
  row.appendChild(note);
  return { row, title, preview };
}

/* ── World surface ──────────────────────────────────────────────────────── */

function renderWorldRows(host, bus) {
  host.innerHTML = '';
  const params = runtimeConfig.worldParams || {};
  const header = document.createElement('div');
  header.className = 'easy-surface-title';
  header.textContent = 'EASY MODE — drag a recipe; every target it writes is listed before it applies';
  host.appendChild(header);

  for (const group of WORLD_EASY_GROUPS) {
    const projection = projectWorldEasy(params, group.id);
    if (!projection) continue;
    const base = previewWorldEasy(params, group.id, projection.t);
    const { row, title, preview } = buildGroupRow({
      surface: 'world',
      groupId: group.id,
      label: group.label,
      t: projection.t,
      customized: projection.customized,
      summary: base.summary,
      effect: group.effect,
      onInput: (t, previewEl) => {
        const p = previewWorldEasy(runtimeConfig.worldParams || {}, group.id, t);
        if (!p) return;
        previewEl.textContent = previewText(p.summary, t);
        previewEl.classList.add('active');
      },
      onApply: (t, previewEl) => {
        const p = previewWorldEasy(runtimeConfig.worldParams || {}, group.id, t);
        previewEl.classList.remove('active');
        previewEl.textContent = '';
        if (!p) return;
        bus.emit('world:paramsPatch', {
          changes: p.changes,
          affected: p.affected,
          source: 'controlProfile',
          group: group.id,
          t: p.t,
        });
      },
    });
    title.textContent = group.label;
    row.dataset.testid = `world-group-${group.id}`;
    host.appendChild(row);
  }
}

/**
 * Mount the WORLD control-mode bar + Easy surface.
 * @param bus event bus
 * @param {() => void} [refreshAdvanced] re-render the full slider panel
 *        (called when switching back to Advanced so rows aren't stale)
 */
export function mountWorldControlProfile(bus, refreshAdvanced) {
  const params = document.getElementById('world-params');
  if (!params || document.getElementById('world-mode-bar')) return null;
  const parent = params.parentElement;
  if (!parent) return null;

  const state = { mode: readControlModes().world };
  const easyHost = document.createElement('div');
  easyHost.id = 'world-easy-view';
  easyHost.className = 'easy-surface';

  const bar = buildModeBar('world-mode-bar', 'world', state.mode, (mode) => {
    state.mode = writeControlMode('world', mode).world;
    apply();
  });

  parent.insertBefore(bar, params);
  parent.insertBefore(easyHost, params);

  function apply() {
    syncModeBar(bar, state.mode);
    document.body.dataset.worldMode = state.mode;
    if (state.mode === 'easy') {
      easyHost.style.display = '';
      params.style.display = 'none';
      renderWorldRows(easyHost, bus);
    } else {
      easyHost.style.display = 'none';
      easyHost.innerHTML = '';
      params.style.display = '';
      if (typeof refreshAdvanced === 'function') refreshAdvanced();
    }
  }

  // Rebuild only after committed changes — never mid-drag (input is preview).
  bus.on('world:paramsApplied', () => {
    if (state.mode === 'easy') renderWorldRows(easyHost, bus);
  });
  bus.on('world:paramsRestored', () => {
    if (state.mode === 'easy') renderWorldRows(easyHost, bus);
  });

  apply();
  return { get mode() { return state.mode; }, apply };
}

/* ── Species surface ────────────────────────────────────────────────────── */

function renderSpeciesRows(host, bus, species) {
  host.innerHTML = '';
  const dnaBuffer = window.__dnaBuffer || null;
  const header = document.createElement('div');
  header.className = 'easy-surface-title';
  header.textContent = `EASY MODE — recipe sliders for species ${species + 1}; Advanced shows all 64 traits`;
  host.appendChild(header);

  for (const group of SPECIES_EASY_GROUPS) {
    const projection = projectSpeciesEasy(dnaBuffer, species, group.id);
    if (!projection) continue;
    const base = previewSpeciesEasy(dnaBuffer, species, group.id, projection.t);
    const { row, title, preview } = buildGroupRow({
      surface: 'species',
      groupId: group.id,
      label: group.label,
      t: projection.t,
      customized: projection.customized,
      summary: base.summary,
      effect: group.effect,
      onInput: (t, previewEl) => {
        const p = previewSpeciesEasy(window.__dnaBuffer || dnaBuffer, species, group.id, t);
        if (!p) return;
        previewEl.textContent = previewText(p.summary, t);
        previewEl.classList.add('active');
      },
      onApply: (t, previewEl) => {
        const buf = window.__dnaBuffer || dnaBuffer;
        previewEl.classList.remove('active');
        previewEl.textContent = '';
        const p = applySpeciesEasy(buf, species, group.id, t);
        if (!p || !buf) return;
        bus.emit('dna:changed', {
          species,
          source: 'controlProfile',
          group: group.id,
          indices: p.affected,
        });
        renderSpeciesRows(host, bus, species);
      },
    });
    title.textContent = group.label;
    row.dataset.testid = `species-group-${group.id}`;
    host.appendChild(row);
  }
}

/**
 * Mount the SPECIES control-mode bar + Easy surface.
 * @param bus event bus
 * @param {() => void} [refreshAdvanced] re-render the DNA accordion when the
 *        user returns to Advanced (rows would otherwise be stale)
 */
export function mountSpeciesControlProfile(bus, refreshAdvanced) {
  const accordion = document.getElementById('dna-accordion');
  if (!accordion || document.getElementById('species-mode-bar')) return null;
  const parent = accordion.parentElement;
  if (!parent) return null;

  const state = { mode: readControlModes().species, species: 0 };
  const easyHost = document.createElement('div');
  easyHost.id = 'species-easy-view';
  easyHost.className = 'easy-surface';

  const bar = buildModeBar('species-mode-bar', 'species', state.mode, (mode) => {
    state.mode = writeControlMode('species', mode).species;
    apply();
  });

  parent.insertBefore(bar, accordion);
  parent.insertBefore(easyHost, accordion);

  function apply() {
    syncModeBar(bar, state.mode);
    document.body.dataset.speciesMode = state.mode;
    if (state.mode === 'easy') {
      easyHost.style.display = '';
      accordion.style.display = 'none';
      renderSpeciesRows(easyHost, bus, state.species);
    } else {
      easyHost.style.display = 'none';
      easyHost.innerHTML = '';
      accordion.style.display = '';
      if (typeof refreshAdvanced === 'function') refreshAdvanced();
    }
  }

  bus.on('species:selected', ({ species } = {}) => {
    if (Number.isFinite(species)) state.species = species;
    if (state.mode === 'easy') renderSpeciesRows(easyHost, bus, state.species);
  });
  bus.on('dna:sync', () => {
    if (state.mode === 'easy') renderSpeciesRows(easyHost, bus, state.species);
  });

  apply();
  return { get mode() { return state.mode; }, apply };
}
