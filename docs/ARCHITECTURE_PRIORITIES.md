# Architecture priority checklist

**Source:** external architecture review of `DayneK/vepa` captured in
`GitHub repository found.mht` (ChatGPT conversation, 2026-10-07, stored in
`DayneK/v5`). Its 12-row priority table is mapped here onto the repo's own
`docs/DECOMPOSITION_PLAN.md` phases so there is one tracked place for status.

**How to update:** flip Status only when the phase's gates pass (§7 of the
plan: syntax · full vitest · repository:check · spec:check · build, plus the
per-phase oracles — solver steps also need the bench/parity gates). The
review is external opinion; this file records what the repo actually did.

| # | Review priority | Plan phase / decision | Status (2026-10-08) |
|---|-----------------|----------------------|---------------------|
| 🔴 1 | Extract `SimulationRuntime` from `main.js` | **P4** | **P4 steps 1–3 implemented and verified in the worktree** — worker transport (`src/workerBridge.js`), population lifecycle (`src/spawn/population.js`), and intelligence cadence (`src/intelligenceCadence.js`); syntax, full tests, repository/spec checks, build, and 11/11 managed-preview e2e pass. Cross-browser/device validation remains open. |
| 🔴 2 | Law registry/ontology → one authoritative schema | master spec §5; `lawgroups/SPEC.md` + 136-record ontology already enforced by `repository:check` | Partial — ontology is authoritative for *identity*; execution-plan generation not started (see 🟠 7) |
| 🔴 3 | Solver phases → explicit execution pipeline | **P2 step 3** (`phases.js`) | Pending — gated on the golden-parity oracle + ≤5 % bench budget from P2 step 1 |
| 🔴 4 | Canonicalize PRNG, eliminate simulation `Math.random()` | cross-cutting | **Source sweep clear** — no `Math.random()` calls found under `src/`; main, worker, and narrative use the shared `SplitMix32`. Replay-grade determinism remains partial: default launch seed can come from `Date.now()`, and full RNG/subsystem state is not in a continuation protocol. |
| 🟠 5 | Formalize save/replay state protocol | — (new work; `worldSave.js` split is P6) | Partial — version-1 world save capture/restore/import/export, undo and timeline snapshots exist; no full replay/continuation contract captures RNG state plus every mutable subsystem and cadence clock. |
| 🟠 6 | Make backend fidelity/capability explicit | **Decision D4** | Partial — BH/FMM gravity selection resolves through `stageGate()` + `lawPlan()` and falls back to exact CPU unless an accepted gate is enabled. **The GPU worker pre-pass is selected directly by `computeEngine === 'gpu'` and does not consult the approximation registry gate**, despite an accepted GPU registry entry; audit the intended D4 boundary and unify gating/actual-backend reporting. |
| 🟠 7 | Make `lawGraph` generate execution plans | master spec §5 (law dependency graph exists as data) | Pending — planner not started |
| 🟡 8 | Separate normative / derived / historical documentation | `docs/spec/` (generated = derived) vs `docs/spec/rb/` (normative) vs `exports/` (historical) | Partial — separation exists structurally; no explicit written policy yet |
| 🟡 9 | Reduce generated repository bulk | — | Pending — spec generation stays (gated by `spec:check`); bulk reduction is an open question, not started |
| 🟡 10 | Finish v3 → v4 terminology cleanup | legacy trees already archived | Pending — stale `VEPA v3` strings remain (e.g. `src/main.js` header, boot logs) |
| 🟡 11 | Further split law implementation modules | **P1** (`laws.js` → `laws/` category files + facade) | Pending — protected by the 32 audit batches; first in §7 order after approval |
| 🟡 12 | More UI refactoring | **P6 / P8** | Pending — opportunistic polish |

**Review items explicitly closed by recorded decisions (D1–D6):** the same session
that recorded this checklist also answered the master spec's §6 gates
(`docs/spec/rb/DECISIONS.md`) — Easy Mode ControlProfile, evidence-gated
parameters, provider-neutral compute contract, gated-approximation policy,
single package + versioned contracts, and the browser QA matrix. A decision
is not proof that every runtime path conforms: specifically, the current GPU
worker pre-pass bypasses the D4 approximation gate used by BH/FMM, so backend
fidelity/capability remains **partial** pending audit and correction.
