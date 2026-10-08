# RB decision record — approval gates from `MASTER_SPEC.md` §6

**Status:** the six open decisions in §6 have been answered by the project
owner and recorded here, as §6 requires ("Capture decision, owner, rationale,
reversibility and acceptance evidence before implementation"). Any future
change to one of these answers requires a new row here — never a silent code
change.

**Recorded:** 2026-10-08 · **Version baseline:** v9.3.1 · **Branch:** `main`

| # | Gate (MASTER_SPEC §6) | Decision |
|---|------------------------|----------|
| D1 | Easy Mode composite values, names, units, formulas, save scope, customized-mixed behavior | **Implement the ControlProfile now** (schema `vepa-control-profile/v1`) |
| D2 | Whether any new world or species parameters are justified | **Evidence-gated additions only** — none without evidence + approval |
| D3 | Remote provider, region, identity/auth, tenancy, billing, residency, latency, offline semantics | **Provider-neutral contract only** — no provider chosen in this pass |
| D4 | Which solver stages may be approximate / accelerated, per-law parity tolerances, determinism | **Gated approximations allowed** — registry-enforced, CPU reference stays authoritative |
| D5 | Module packaging/workspace tooling and public contract version policy | **Single package + versioned contracts** — no workspace split |
| D6 | Browser test matrix and screenshot acceptance tolerances | **Define the matrix and run it** against the managed preview |

---

## D1 — Easy Mode ControlProfile: implement now

- **Decision:** ship ControlProfile v1. Each surface (WORLD, SPECIES) gets an
  independent persisted `EASY | ADVANCED` toggle (localStorage
  `vepa.controlModes.v1`, first run defaults to **Easy**). Easy exposes
  composite recipe sliders declared in `src/state/controlProfile.js`; Advanced
  keeps the complete existing panels untouched — nothing is hidden from
  saves or from Advanced. Recipe math: normalized anchors
  `value(t) = range.min + (from + t·(to − from))·(range.max − range.min)`,
  clamped, deterministic. Every recipe passes exactly through the canonical
  defaults with a uniform default-projected t (validator-enforced), so a
  first-run world on canonical defaults never reads as customized; a preset
  launch whose values sit off-recipe may read as customized — that is the
  truthful answer for mixed values, and moving the slider re-aligns every
  member. Preview on `input`, one atomic
  apply on `change` (`world:paramsPatch` → per-key canonical path + one
  `world:paramsApplied`; species = one DNA write pass + one `dna:changed`).
  `customized` flag = member spread beyond threshold
  (world 0.008 / species 0.0008) or out-of-span value; it is informational —
  moving the slider re-aligns all members. Exact recipe values/names are code
  (validated by `tests/unit/controlProfile.test.js`); UI copy is derived from
  `WORLD_PARAM_DEFS`/`DNA_META` labels.
- **Owner:** project owner (approved 2026-10-08); implemented by the agent.
- **Rationale:** the full 149-parameter / 64-trait surface is the expert path;
  a predictable recipe layer must exist for first-run users without forking
  state or duplicating save data (Easy writes the same canonical params/DNA).
- **Reversibility:** high — toggles default back to Advanced by flipping the
  stored mode; recipes are additive UI over existing params; removing the
  three new modules + two mount calls restores prior behavior. No save-format
  change.
- **Acceptance evidence:** `tests/unit/controlProfile.test.js` (schema
  validity, purity, clamping, round-trip, first-run-not-customized,
  Advanced-edit detection, per-species isolation, mode-store durability);
  Playwright spec `tests/e2e/control-profile.spec.js` (real browser); QA
  matrix row in `docs/spec/testing/browser-qa-matrix.md`.

## D2 — Parameter additions: evidence-gated

- **Decision:** no new world parameter or DNA trait may be added without
  written evidence (a named consumer that needs it, semantic contract,
  migration/serialization impact, stability + fidelity tests, help/audit
  entries) and explicit approval recorded here. Existing parameter counts are
  a snapshot, not a target.
- **Owner:** project owner approves; any agent may propose evidence.
- **Rationale:** parameter sprawl is the main complexity tax on the Easy
  layer; each addition must pay for itself.
- **Reversibility:** high — this is a process gate; it can be amended by a
  new decision row without code changes.
- **Acceptance evidence:** `docs/spec/param-addition-policy.md` (the gate)
  enforced by `tests/unit/paramAdditionPolicy.test.js`, which fails if the
  evidence record does not exist and validate clean for every declared
  addition (empty additions list = gate passes trivially).

## D3 — Remote execution: provider-neutral contract only

- **Decision:** implement a provider-neutral `ComputeSession` contract with
  local adapters (main thread, worker) as the default and a remote adapter
  *port* only. No provider, region, auth, tenancy, billing, residency or
  latency target is chosen in this pass; those remain an ADR gate recorded
  here before any provider integration lands. Remote stays opt-in and never
  required to boot, simulate or restore.
- **Owner:** project owner (ADR for the eventual provider); agent owns the
  contract + adapters.
- **Rationale:** the browser app must work offline today; binding to a vendor
  before latency/cost requirements exist would be premature and hard to
  reverse.
- **Reversibility:** high — the contract is additive; local adapters are the
  shipped default; the remote port has no implementation behind it until an
  ADR fills it.
- **Acceptance evidence:** `tests/unit/computeSession.test.js` (session
  lifecycle, ordered ticks, local adapters, remote-port capability flags,
  no-network guarantee); provider survey recorded in
  `docs/spec/execution/provider-options.md` for the future ADR.

## D4 — Solver: gated approximations allowed

- **Decision:** approximations (Barnes–Hut/FMM-style gravity, GPU pre-pass,
  reduced-cadence law evaluation) may ship **only** through a declared
  approximation registry: per-stage + per-backend gates, per-law parity
  tolerances, determinism class, and an evidence field. The exact CPU
  pairwise solver remains the authoritative reference; a backend without a
  registered gate for a stage must run that stage exactly.
- **Owner:** project owner approves registry entries; agent maintains the
  registry.
- **Rationale:** performance work is inevitable at 10k particles; untracked
  approximations silently corrupt fidelity audits, while a registry makes
  every deviation testable and auditable.
- **Reversibility:** high — gates can be disabled per stage/backend, falling
  back to exact execution; registry is data, not call-site surgery.
- **Acceptance evidence:** `src/physics/approximations.js` +
  `tests/unit/approximationRegistry.test.js` (unregistered gate refused,
  tolerance bounds enforced, exact-fallback preserved, registry validation).

## D5 — Packaging: single package + versioned contracts

- **Decision:** keep one npm package (the current root manifest). Module
  boundaries are enforced by contracts — a module catalog listing each
  module's public surface, validated against `src/core/moduleRegistry.js`
  and imports — instead of a workspace/multi-package split. Contract version
  policy: contracts carry a version token and change under SemVer recorded
  in this repo's changelog.
- **Owner:** project owner; agent enforces via catalog + tests.
- **Rationale:** the team workflow (single Freebuff workspace, single deploy)
  gains nothing from workspaces today, while contracts give the same
  isolation guarantees testably.
- **Reversibility:** medium-high — contracts are additive metadata; a future
  workspace split can derive packages from the same catalog.
- **Acceptance evidence:** `src/moduleCatalog.js` +
  `tests/unit/moduleCatalog.test.js` (every catalog entry resolves, public
  surfaces match moduleRegistry entries, no dangling contracts).

## D6 — Browser QA: define matrix + run it

- **Decision:** a written browser matrix
  (`docs/spec/testing/browser-qa-matrix.md`) defines the environments,
  coverage areas, fixtures and screenshot-acceptance tolerances; Playwright
  e2e runs against the **managed Freebuff preview** (real browser, COOP/COEP
  headers) and results — including skips and limitations — are recorded in
  the matrix rather than implied by a green unit suite.
- **Owner:** project owner signs off on the matrix; agent runs and records.
- **Rationale:** §00 states DOM-stub tests do not establish browser parity;
  acceptance requires actual browser verification with limitations documented.
- **Reversibility:** high — documentation + tests; no runtime coupling.
- **Acceptance evidence:** the matrix doc itself (with a run-results section),
  `tests/e2e/*.spec.js` outputs pasted per run, and the changelog entry for
  the release carrying this record.
