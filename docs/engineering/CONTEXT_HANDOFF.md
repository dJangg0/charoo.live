# Charoo shared engineering handoff

Sanitized summary for the latest Cloudflare staging milestone. Root [SRS.md](../../SRS.md) remains canonical. Recheck repository and external state before continuing.

| Field | Current state |
|---|---|
| Updated | 2026-11-16 — quick-chat timeout deadline review and local verification |
| Repository / workspace | Charoo / `dhaka` |
| Branch / target | `dJangg0/cloudflare-durable-objects-blueprint` / `origin/main` |
| Starting commit | `39b3cc70ad840669207bbd71a82351683a00abd1` |
| Objective / state | Quick-chat timeout is implemented for both targets and deployed to staging Worker version `17f1ade6-612c-4112-b9da-579472019756`. Review fixed late reservation past the deadline and added local coverage. Production remains pending OAuth configuration and credential remediation. |

## Delivered

- Added `wrangler.staging.jsonc` for `charoo-live-staging`, with separate D1, R2, Queues, and Durable Object namespaces; added staging build, deploy, migration and secret scripts.
- Created staging D1 (`charoo-d1-staging`), R2 (`charoo-media-staging`), queue (`charoo-jobs-staging`) and dead-letter queue (`charoo-jobs-staging-dead-letter`) in the configured `project` account.
- Applied all five existing D1 migrations, generated a separate staging `MESSAGE_KEY`, and deployed Worker version `49b9f2a8-1367-4255-9a3a-52257ea21136`.
- Public staging URL: https://charoo-live-staging.shy-star-eff8.workers.dev
- The ignored local staging secret file contains the key; its value is not recorded here. Owner should retain a secure backup before relying on staging data.
- Added a shared 2-minute quick-chat search limit in the frontend and Matcher. The client cancels the server queue and offers retry; the server lease and candidate selection enforce the same deadline. Deployed the change to staging using Wrangler `--keep-vars`; matching behavior was not runtime tested after deployment.
- A code review found that presence and coordinator calls could outlast a candidate's deadline. Match reservation now carries the earlier queue deadline and rejects an expired reservation before writing match state; expired candidates are removed and the other user's still-live search can continue.
- Added deterministic Matcher expiry/retry and reservation-boundary tests plus a browser timeout/cancellation scenario. Local `pnpm check` passed (108 tests), and both `tests/browser/random-chat.spec.ts` cases passed. These checks do not verify Cloudflare runtime behavior.
- Production deployment history confirms user-managed dashboard updates for R2 binding, Google OAuth variables, and `WEB_ORIGIN`. The latest active version still binds `MEDIA` to `charoo-media`.
- Production configuration needs correction before deployment: active `WEB_ORIGIN` includes the OAuth callback path, and `GOOGLE_CLIENT_SECRET` is configured as a plaintext environment variable rather than a Secret. Staging's dashboard configuration also has `GOOGLE_CLIENT_SECRET` under ordinary variables. Rotate each affected credential and store replacements as Worker Secrets. Do not record values.

## Verification and limits

- PASS: `pnpm run deploy:cloudflare:staging:dry-run` — type checks, frontend build and Wrangler binding/config dry-run.
- PASS: `pnpm run db:migrate:cloudflare:staging` — migrations 0001–0005 applied; remote migration list reports none pending.
- PASS: `pnpm build:cloudflare:staging` and Wrangler deploy with staging secrets — deployed Worker and all configured bindings.
- PASS: `pnpm typecheck` after the quick-chat timeout change.
- PASS: `pnpm run deploy:cloudflare:staging:dry-run` and `pnpm run deploy:cloudflare:dry-run` after the original quick-chat timeout change. Both bundle/config checks succeeded; Vite reported existing third-party annotation and chunk-size warnings. These preceded the review's reservation deadline guard.
- PASS: review verification `pnpm check` (108 tests) and `pnpm exec playwright test tests/browser/random-chat.spec.ts` (2 tests). The browser suite used local Vite on port 55000. No Cloudflare deployment/build was run for the review fix.
- NOTE: `pnpm format:check` reports pre-existing formatting warnings in `tests/fr12.test.ts` and `tests/ports.test.ts`; neither file is part of this task's diff.
- PASS: staging build and `pnpm exec wrangler deploy --config wrangler.staging.jsonc --keep-vars`; deployed Worker version `17f1ade6-612c-4112-b9da-579472019756`. Wrangler reported dashboard/local config differences; `--keep-vars` was used to retain dashboard-managed OAuth variables. No application runtime check was run after this deployment.
- PASS: staging `/api/auth/providers` returned `{"google":true}` during OAuth troubleshooting. Production version metadata was inspected read-only; the sensitive value was not retained in this handoff.
- PASS: HTTP GET `/` returned 200; GET `/health` returned `{"status":"ok"}`.
- Not verified: guest/session creation, room writes, WebSocket reconnect, media scanning, external providers, load/capacity and production runtime. No automated application tests were run in this deployment task.
- Existing IMP-01 and IMP-03 access-control findings remain open; IMP-02 remains open if video is enabled. Use synthetic staging data only until resolved.
- At the original staging setup, production D1 had zero tables. Recheck before migrations. Later user-managed production Worker changes are recorded above; no production mutation was made by this task.

## Next action

Rotate the staging and production Google client secrets and store them as Worker Secrets. Set production `WEB_ORIGIN` to `https://charoo.live` only; keep the Google authorized redirect URI as `https://charoo.live/api/auth/google/callback`. Reconcile production Wrangler configuration with dashboard OAuth variables before deployment, then deploy the timeout to production and verify both runtimes. The original timeout version is deployed to staging; the reservation-boundary review fix has not been deployed, and staging behavior still needs runtime verification. Preserve the existing SRS access-control findings and staging-key backup.
