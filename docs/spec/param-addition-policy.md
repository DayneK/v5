# Evidence-gated parameter addition policy (decision D2)

**Decision of record:** `docs/spec/rb/DECISIONS.md` → D2 — *no new world
parameter or DNA trait without evidence and approval.* This document defines
what "evidence" means; `tests/unit/paramAdditionPolicy.test.js` enforces it on
every run, so a parameter cannot land in `WORLD_PARAM_DEFS` or the DNA
genome silently.

## Why a gate

`WORLD_PARAM_DEFS` (149 entries) and the 64-trait genome are the SSOT every
panel, save, audit and — since decision D1 — every Easy Mode recipe projects
against. Each addition multiplies surface area across serialization, help
text, audits, and the Easy/Advanced mapping. Existing counts are a snapshot,
not a target: additions must pay for themselves with evidence.

## What an addition requires

For **each** proposed world parameter or DNA trait, an entry in
`docs/spec/param-additions.json → additions[]` with all of:

| Field | Meaning |
|-------|---------|
| `target` | `world` (WORLD_PARAM_DEFS) or `dna` (species genome trait) |
| `key` | canonical key: world param key, or DNA trait name in `DNA_INDEXES` |
| `consumer` | the named solver/law/engine site that reads it — an addition with no consumer is rejected |
| `semanticContract` | units, range, default, and what changes in the simulation when the value moves |
| `migration` | save-format impact and backward/forward compatibility behavior |
| `tests` | repo-relative paths of tests that exist and cover the new parameter (stability + fidelity) |
| `approvedBy` | who approved it (the project owner) |
| `approvedOn` | ISO date of approval |

Plus, in the same change:

1. **Help** — a parameter help entry (`attachParamHelp` data) or
   `LAW_HELP_DB`-tier documentation where the parameter belongs to a law.
2. **Audit** — an `audit-suite/` note if the parameter changes law behavior.
3. **Easy mapping** — decide explicitly whether a ControlProfile recipe
   (`src/state/controlProfile.js`) should expose it; recipes must keep
   passing through canonical defaults (`validateControlProfile()` enforces
   this). "Not exposed" is a valid, explicit outcome.
4. **Docs** — changelog entry per §10.4 with the release that carries it.

## How the gate is enforced

`tests/unit/paramAdditionPolicy.test.js` asserts:

- the policy document and record exist with schema `vepa-param-additions/v1`;
- `baseline` equals the frozen starting counts (**149** world params,
  **64** DNA traits) — raising the baseline is a deliberate test edit, not a
  side effect;
- `WORLD_PARAM_DEFS.length === baseline.worldParams + approved world additions`
  and `DNA_COUNT === baseline.dnaTraits + approved dna additions` — an
  ungated addition fails the count equation;
- every addition carries every required field with non-empty values, its
  `tests` paths exist on disk, and no key is approved twice.

Empty `additions[]` (today's state) passes trivially — the gate only bites
when someone changes the counts.
