# Browser QA matrix (RB decision D6)

**Status:** living document. Environments, coverage and tolerances are defined
here; every run appends a dated result block at the bottom — including skips
and limitations. Real-browser verification is required because DOM-stub tests
do not establish browser parity (`docs/spec/rb/00-current-program-baseline.md`).

## Environments

| Tier | Environment | When | Status |
|------|-------------|------|--------|
| P0 | Playwright Chromium, headless, desktop 1280×800, against the **managed Freebuff preview** (COOP/COEP headers → `crossOriginIsolated`) | Every feature pass | Automated |
| P1 | Playwright Firefox + WebKit (same specs) | Before release | Not yet run — requires browser binaries on this host |
| P2 | Device emulation (`pointer: coarse`, touch) + manual exploratory pass | Before release | Partly covered statically by `tests/unit/touchSupport.test.js`; device run pending |
| P3 | Hardware-WebGPU machine | Fidelity/parity work | Not available here — GPU e2e self-skips (annotation `webgpu: unavailable`) |

Command (managed preview — never spawn a dev server by hand):

```bash
freebuff-preview start          # platform-managed server
VEPA_E2E_BASE_URL=<preview-url> npx playwright test
```

Without `VEPA_E2E_BASE_URL` the config falls back to its local dev-server
webServer block (developer laptop flow).

## Coverage areas

| Area | Spec | Tier | Notes |
|------|------|------|-------|
| Shell boot, no module errors, worker ticks, GPU↔CPU parity, WebGPU fallback | `tests/e2e/physics-worker.spec.js` | P0 | GPU case self-skips without hardware WebGPU |
| Easy Mode world surface: first-run Easy, 5 recipes, Advanced completeness (≥140 rows) | `tests/e2e/control-profile.spec.js` | P0 | Decision D1 |
| Recipe preview → atomic apply into canonical sliders | `tests/e2e/control-profile.spec.js` | P0 | Decision D1 |
| Per-surface mode persistence across reload | `tests/e2e/control-profile.spec.js` | P0 | Decision D1 |
| Species surface: 6 recipes → genome → Advanced reflects writes | `tests/e2e/control-profile.spec.js` | P0 | Decision D1 |
| Law grid interaction, category filter, search | — | P1 | Static contracts only today (`lawCategories` unit tests) |
| Saves / undo / world compare round-trip in-browser | — | P1 | Unit-covered (`worldSave`); browser run pending |
| Drawer resize/hide/keyboard tabs/touch targets | — | P2 | Static: `touchSupport.test.js`, `typeScale.test.js` |
| Screenshot/visual parity | — | P1 (proposed) | **Tolerances proposed, not approved:** fixed viewport, `prefers-reduced-motion`, ≤0.1% differing pixels with per-channel Δ > 10% vs golden; needs owner sign-off before gating |

## Exit criteria (P0)

1. Zero page errors / console errors during each spec.
2. All assertions green against the managed preview; skips annotated with a
   reason (never silent).
3. Results recorded below with date, HEAD, command and counts.

## Run results

<!-- RUN_RESULTS_BEGIN -->

### 2026-10-08 — P4 decomposition verification (managed workspace preview)

- **HEAD:** `01b34c7` + current working-tree changes.
- **Environment:** Playwright 1.60 / Chromium headless-shell 149 (Linux),
  workspace-managed Vite preview on port 5180 with COOP/COEP.
- **Commands:** `VEPA_E2E_BASE_URL=http://127.0.0.1:5180/ npx playwright test
  <spec> --workers=1`, run in bounded per-spec/test batches to fit command limits.
- **Results: 11/11 passed:** runtime acceptance 3/3; physics-worker 4/4,
  including advancing worker tick and safe GPU fallback; ControlProfile 4/4,
  including Easy default, preview/apply, per-surface persistence, and species
  recipes flowing into Advanced controls. Hardware WebGPU unavailable; GPU
  force parity test reports the documented self-skip. Browser coverage had no
  assertion or page-error failures.
- A combined full-suite invocation exceeded the host's 180-second command cap
  after 2 ControlProfile passes; the remaining tests passed in separate bounded
  runs. An exploratory run against `https://v5.freebuff.app/` hit an older
  deployed snapshot (stalled tick + unavailable `/src/physics/gpuCompute.js`);
  reruns against this managed working-tree preview passed. Firefox/WebKit,
  touch-device testing, and screenshot gating remain unverified.

### 2026-10-08 — first matrix run (managed preview)

- **HEAD:** `01b34c7` + working-tree changes (Easy Mode ControlProfile pass)
- **Environment:** Playwright 1.60 / Chromium headless-shell 149 (Linux),
  against the managed Freebuff preview (`freebuff-preview start`, vite dev on
  port 5180, https). Browser system deps via `npx playwright install-deps
  chromium`; Firefox/WebKit binaries not installed (P1 pending).
- **Command:** `VEPA_E2E_BASE_URL=<preview-url> npx playwright test --workers=1`
  run per-spec batched (remote-host latency makes the full file exceed a
  single 180s command window; P0 exit criteria unaffected).
- **Results: 8/8 passed.**
  - `physics-worker.spec.js` 4/4 — including the strengthened tick test
    (launch modal dismissed; tick counter must *advance* over 1.2s; static
    HUD placeholder no longer satisfies it). GPU fixture annotated
    `webgpu: unavailable` (headless) and self-skips; fallback test passes.
  - `control-profile.spec.js` 4/4 — first-run Easy default + 5 recipes +
    Advanced completeness (≥140 rows); preview → atomic apply verified
    against the canonical `GLOBAL_G` advanced slider; per-surface mode
    persistence across reload; species 6 recipes → genome → Advanced.
  - Zero page errors / console errors asserted in world + species specs.
- **Limitations recorded (never implied as passes):** headless Chromium only
  (no Firefox/WebKit, no real device); hardware WebGPU unavailable so GPU
  parity runs in self-skip mode; screenshot/visual parity not gated
  (tolerances above remain proposed); remote preview latency required
  batched runs and a 150s per-test timeout.

<!-- RUN_RESULTS_END -->
