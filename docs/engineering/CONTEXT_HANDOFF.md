# Charoo shared engineering handoff

## Current denver branch: origin/main integration

- **2026-11-17**, workspace `denver`, branch `dJangg0/asl-profile-display-chat-fix`, base `origin/main`. Integrated `origin/main` commit `31c7b88` after the Cloudflare Preview configuration commit `4472fec`.
- Preserved upstream profile photo direct-upload and integrated avatar/bio work, plus this branch's chat delivery/reply/progress UI and Cloudflare Preview configuration. Resolved documentation conflicts in SRS FR-12/BE-05/BE-06, architecture decisions, and the implementation matrix. Profile uploads no longer require an external scanner; room attachments remain scanner-gated.
- PASS: `pnpm typecheck` (both TypeScript projects) and `git diff --check` after resolving the documentation conflicts. No application, browser, native or Cloudflare suite was rerun for the merge; earlier evidence below applies only to the commits/environments noted there.
- No Cloudflare resource mutation, secret upload, migration, or deployment was performed as part of this merge.

## Imported upstream milestone: integrated profile photo and bio

- **2026-11-17**, workspace `stockholm`, branch `dJangg0/upload-picture-profile-offset`, HEAD `f9fff70`, target `origin/main`. User requested removing the separate photo panel, clicking the photo in the identity card to add/change it repeatedly, and a bio. Prior direct upload fix remains; no external service or unrelated work was added.
- `ProfilePicture` now renders the identity card with a native avatar button, hidden file picker and camera affordance. Uploaded images appear in the avatar; both pointer and keyboard activation choose a file. Existing upload/replace validation, pending/error/retry and authoritative success checks remain. Removed obsolete standalone-panel styles.
- `App` exposes the existing `profile.bio` as a clearly labeled **Bio** editor (300 characters) before region/interests, saves through the existing profile PATCH and displays only the saved bio in the owner's identity card. It persists after reload. No backend schema, endpoint, dependency or other-user visibility change.
- PASS: `pnpm check` (types and110tests); owned profile/bio/layout/responsive browser files27cases plus existing disclosure8cases (**35 total**); `pnpm build:cloudflare` (existing third-party annotation/chunk warnings). Tests caught a portrait-avatar sizing issue; absolute positioning inside the fixed avatar corrected it, and all responsive cases passed afterward.
- PASS: actual built local workerd app in Playwright, no API mocks: avatar chooser upload, repeated same-file replacement, square photo, Bio save and reload persistence, and absence of a standalone photo panel. Synthetic mobile/desktop screenshots inspected: `.context/profile-card-mobile.png`, `.context/profile-card-desktop.png`. Test session used the existing HTTP-only local cookie override; no production cookie behavior is inferred. No remote deployment or migration.
- Checkpoint `.context/handoffs/profile-card-root.md`; Vite55040 remains available. The existing direct-upload backend is unchanged. Next: normal code review/deployment when requested; local implementation is complete and uncommitted. The owned local workerd smoke server was stopped; Vite55040 remains for preview.


## Previous milestone: scoped profile-photo upload and layout fix

- **2026-11-17**, workspace `stockholm`, branch `dJangg0/upload-picture-profile-offset`, starting HEAD `f9fff70`, target `origin/main`. Latest user steering: fix profile upload only; remove the added scanner service, moderation API, container/dependency and unrelated room-attachment work. Those additions were removed. Profile layout correction remains.
- Profile status/init no longer depend on scanner settings. Authenticated JPEG/PNG/WebP (up to5MB) uploads use existing private R2, server file/container/size/dimension checks and serialized exact-attempt completion. Failed replacements preserve the current image, successful replacements keep existing cleanup and sharing-consent rules, and duplicate completion is idempotent. Legacy profile scan links return unavailable. Room attachment source/configuration is unchanged.
- Frontend verifies the backend's matching saved ID/state before success and refreshes the preview. Pending/error/retry states remain. Profile identity/photo/form alignment and mobile account-button spacing are fixed.
- PASS: `pnpm check` — type checks and **110 tests**. New direct-upload cases run with no scanner settings or external fetch; existing disclosure/privacy/cleanup remains covered. PASS: `pnpm exec playwright test tests/browser/profile-upload.spec.ts tests/browser/profile-layout.spec.ts tests/browser/disclosure.spec.ts tests/browser/disclosure-responsive.spec.ts` — **32 tests** in46.9s. PASS: `pnpm run deploy:cloudflare:dry-run` — frontend/Worker build and bundle, existing dependency annotation/chunk warnings only. No production deployment inferred.
- PASS: actual isolated local workerd/D1/DO/R2/Queues HTTP smoke with no scanner settings/service:JPEG/PNG/WebP exact private bytes, replacement/idempotence, invalid/MIME/size rejection with same-upload retry, foreign/anonymous/CSRF denials and unchanged room-attachment scanner prerequisite. Existing local migrations were checked with none pending; no replay. Evidence `.context/profile-upload-workerd/results.json`. No remote migrations, resource creation, deployment, push or PR performed.
- PASS: actual Playwright browser file selection and saved preview against the built local workerd app (no API mocks). Synthetic preview screenshot: `.context/profile-upload-fixed.png`. The isolated HTTP origin used a test-only manually installed session cookie; this is not evidence of production HTTPS cookie behavior.
- Canonical SRS and ADR-02 document the user's profile-only override of the old scanner prerequisite. Validation is basic file-format checking, not a claim of decoding, metadata removal or automatic content moderation. No new dependencies or database migrations.
- Task checkpoint: `.context/handoffs/profile-upload-root.md`. Prior scanner-work checkpoints/results are superseded and do not describe this branch's current behavior. Vite55040 is available for local UI preview; recheck processes before reuse. Next: review the scoped diff, then use the normal publication/deployment process if authorized. Local implementation is complete; it has not been deployed.

## Previous staging history

Sanitized summary for the latest Cloudflare staging milestone. Root [SRS.md](../../SRS.md) remains canonical. Recheck repository and external state before continuing.

| Field | Current state |
|---|---|
| Updated | 2026-11-17 — Cloudflare Preview check diagnosis and local configuration verification |
| Repository / workspace | Charoo / `denver` |
| Branch / target | `dJangg0/asl-profile-display-chat-fix` / `origin/main` |
| Starting commit | `f9fff705664d8079f6860acc988c72914e2dfce6` |
| Objective / state | Chat UX changes are committed and [PR #2](https://github.com/dJangg0/charoo.live/pull/2) is open. Current task: correct the Cloudflare PR Preview check that failed at `npx wrangler preview` for missing bindings. Local preview config, command, and origin handling are implemented and build/config-checked. No remote Preview deploy, resource mutation, or secret upload. Prior task details and staging notes follow below. |

## Cloudflare Preview check (2026-11-17)

- Attachment `.context/attachments/FjuUkt/pasted_text_2026-11-17_14-10-49.txt` shows Cloudflare's `pnpm run build` and both TypeScript checks passed; deploy failed because bare `npx wrangler preview` had no `previews` block. It was using Wrangler's default config selection.
- Added `pnpm run preview:cloudflare` selecting `wrangler.cloudflare.jsonc`, Preview-only bindings to shared staging D1/R2 and staging dead-letter queue, and isolated-per-Preview DO bindings. Added `PREVIEW_MODE`; browser Origin must equal the request origin while enabled. README documents dashboard build/deploy command settings and limitations; SRS/AD-04 and matrix reflect the security/config contract.
- Preview shares staging D1/R2 and uses a dedicated Preview base `MESSAGE_KEY`; only synthetic data is appropriate. Static Preview `WEB_ORIGIN` is the staging URL, so generated absolute links go to staging; provider sign-in/email are not configured. Queue consumers and Cron do not run in Previews.
- PASS: `pnpm run build:cloudflare`; `pnpm exec wrangler deploy --dry-run --config wrangler.cloudflare.jsonc`; code/config Prettier; `git diff --check`. Vite emitted existing Zod annotation and large-chunk warnings. The Wrangler dry-run validates the production config/bundle, not the Preview block or remote deployment. No tests run, no Cloudflare mutation/deploy/secret upload. Markdown Prettier fails at HEAD for all four edited docs; no broad reformat.
- Next: owner updates Cloudflare Worker Build commands to `pnpm run build:cloudflare` and `pnpm run preview:cloudflare`, configures a dedicated synthetic Preview `MESSAGE_KEY`, then reruns the connected Preview build. Dashboard changes are outside this workspace.

## Chat UX task in denver (2026-11-17)

- Screenshot showed quick-chat counts You 4/5 and Stranger 3/5. The five-each milestone was not met. Qualifying content also requires at least eight normalized characters, four distinct characters, a three-second gap and a new content fingerprint. Peer ASL remains subject to the owner's visibility preference.
- Source review confirmed room WebSockets carry authenticated updates/typing; message writes use REST with a stable client ID, transactionally committed before durable outbox projection/event delivery. Keep this transport split.
- Local changes: optimistic bubbles show `Sending…`, become `Sent` pending authoritative history refresh, and offer retry only after a failed write; post-ack history refresh is background work. Refresh now targets the room that accepted the message and reconciles pending IDs when a room is reopened. Reply history includes a privacy-checked quoted message preview. Quick-chat progress is a compact two-person bar above history, with counts to five each; permitted age/sex/location appears after qualification.
- Commits: `b860984` ASL progress, `e4ec997` quoted replies, and `58f3b44` delivery states/reconciliation. Pushed to `origin/dJangg0/asl-profile-display-chat-fix`; PR #2 is open. `pnpm typecheck`, `git diff --check`, changed-file Prettier checks, and all 10 `tests/browser/disclosure.spec.ts` scenarios pass, including the delayed-send room-switch and quoted-reply regressions. Other Vitest/browser suites, responsive follow-up, Cloudflare runtime, deployment and migration were not run.

## Earlier staging milestone (2026-11-16)

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
