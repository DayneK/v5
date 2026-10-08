# Remote compute provider options — survey only (decision D3)

**Status:** survey for the future ADR. **No provider is chosen here.** D3 in
`docs/spec/rb/DECISIONS.md` fixes this pass: a provider-neutral
`ComputeSession` contract (`src/compute/computeSession.js`,
`vepa-compute-session/1.0.0`) with local adapters as default and an unwired
remote port. Anything below becomes actionable only through a new decision row
approving provider, region, identity/auth, tenancy, billing, residency,
latency targets and offline/reconnect semantics.

**Context:** VEPA4 is a vanilla-ESM Vite browser app (Web Worker +
SharedArrayBuffer solver, npm package, Node tooling, **no backend today**).
The remote port expects HTTP/JSON `POST /tick` (or WebSocket upgrade later)
against an ordered-tick contract; the browser stays authoritative until an ADR
says otherwise.

## Candidate shapes (surveyed 2026-10-08)

| Option | Shape | Fits the port? | Trade-offs to decide in the ADR |
|--------|-------|----------------|----------------------------------|
| **Fly.io** | Stateful containers, Anycast, WebSocket-friendly, per-machine pricing | Yes — long-lived Node process, p2p latency decent | Cost floor per app; region choice; ops ownership |
| **Cloudflare Durable Objects** | Edge actor with state + WebSocket hibernation | Yes — per-room ordered actor matches tick ordering | Worker runtime limits (CPU/ms caps) vs solver payload; vendor lock-in depth |
| **Google Cloud Run** | Serverless containers, scale-to-zero, HTTP + WebSocket (recent) | Yes for HTTP tick; WS needs newer features | Cold starts vs tick cadence; always-on tier costs |
| **Railway / Render** | PaaS containers, simple Node deploys, WS support | Yes — simplest ops path | Region count; per-instance cost; less edge presence |
| **AWS Fargate / AppRunner** | Managed containers behind API Gateway/WebSocket | Yes — widest region set | Heaviest operational surface; billing complexity |
| **Vercel Functions** | Serverless HTTP functions | Poor fit | Stateless + execution-time limits conflict with an authoritative tick loop (catalog review agreed) |

None of the above is approved. The Gravity service catalog surfaced no
general-purpose compute host for this use case in two searches (2026-10-08),
so this table is a web survey, deliberately not a recommendation.

## ADR checklist before any adapter gets wired

1. **Latency budget** — measured RTT budget for `step()` at target populations
   vs local worker (baseline: local ticks, no network).
2. **Cost model** — per-tick and idle cost ceilings; who pays for a world left
   running.
3. **Identity/tenancy/auth** — who may drive a world; isolation between users.
4. **Data residency & retention** — particle/save payloads leave the browser
   only under a declared retention policy.
5. **Offline/reconnect semantics** — local adapter remains authoritative; the
   session queue already back-pressures (`ComputeBackpressureError`) and the
   UI must keep rendering on loss (contract tests cover ordering + loss
   handling at the session layer).
6. **Max population / determinism class** — remote ticks must publish their
   approximation registry gates (see `src/physics/approximations.js`, D4).

## Evidence

- Contract: `src/compute/computeSession.js` (local default, remote port,
  injected transport only — no network in tests).
- Tests: `tests/unit/computeSession.test.js` (ordering, backpressure,
  capabilities, contract-tagged payloads, fetch never touched by local path).
