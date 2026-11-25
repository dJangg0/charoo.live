# Charoo shared engineering handoff

## Queue quota and staging outage, 2026-11-24

- Cloudflare's Queues free allowance (10,000 operations/day, shared by the `project` account) was exhausted on 2026-11-24; sends fail until 2026-11-25 00:00 UTC. Public `chat.charoo.live` still served the app shell and API responses. Discovery was empty because production had no open rooms.
- Staging `/api/*` returned 503 because staging D1 had five of six migrations recorded. `ensureSchema` in production mode throws `DATABASE_NOT_MIGRATED`, so the AppCoordinator refused to start. Applied `0006_credits.sql` to `charoo-d1-staging` (remote). Staging `/api/health` now returns 200 and `/api/settings` returns 401.
- Both alarms (`AppCoordinator.alarm`, `Room.alarm`) re-sent every outbox row to the queue on every run. A row that cannot deliver inline therefore cost a queue send each minute. Fixed in source: each row is redriven once per 10-minute rowid phase, plus on the short retry alarm while it is under 30 s old, so a transient inline failure still retries in about a second (`celld/shared/data.ts`, `app.ts`, `room.ts`; Room outbox gained an additive `queued_at` column, NULL for older rows). `tests/outbox-redrive.test.ts` covers both the capped redrive of an old row and the fresh-row retry for every phase; the Room alarm path has no automated test.
- Verified locally: `pnpm check` exit 0 (18 files, 162 tests).
- Not deployed: the code fix needs a deploy from `staging` (guarded script) and `main` (production). The guard blocks this branch, so I did not bypass it. Production still runs the 2026-11-17 build without this fix.
- Not verified: which outbox kind is stuck; the room-level Durable Object outboxes are not visible from D1; `wrangler queues` shows no operation counts.
- Uncommitted: `celld/shared/data.ts`, `celld/durable-objects/app.ts`, `celld/durable-objects/room.ts`, `tests/outbox-redrive.test.ts`, `docs/engineering/IMPLEMENTATION_MATRIX.md`, `docs/engineering/CONTEXT_HANDOFF.md`.

## Join identity and reconnect native verification, 2026-11-24

- FR-04 now lets each group join enter with the profile or as a guest with an optional nickname (2 to 24 characters). Members and the host see the nickname; guest entries get no profile picture; earlier guest messages keep their nickname after a profile rejoin. The SRS FR-04 sentence is now [CURRENT]. Evidence is in the [matrix](IMPLEMENTATION_MATRIX.md) FR-04 section and the 2026-11-24 log row.
- Verified locally: `pnpm check` (159 Vitest tests), `pnpm test:native` exit 0 (133 passing results, none failing). The first native run failed only the reconnect UI spec because the Chats button label includes an unread badge; the locator was corrected and the rerun passed.
- Not verified: a deployed Worker, a manual two-browser walkthrough of the join modal, and any live payment gateway. Other members still see the account's opaque user identifier. Review follow-up: guest entries now also hide ASL and are refused contact/private requests (`hasParticipant(id, true)` in `social.create`), with tests; `pnpm check` rerun after this change.
- Open decisions for the owner: whether hosts should see only the nickname (the implemented default) and whether to commit this work to PR #13.
- Uncommitted: `SRS.md`, `docs/engineering/`, `celld/`, `packages/contracts/`, `src/`, `tests/`; new files `src/JoinIdentity.tsx`, `tests/join-identity.test.ts` and `tests/native/`.

## Credits economy and quick-chat message milestone, 2026-11-22

- Implemented the credits economy (FR-13, ships disabled by `credits_enabled=false`), BE-08 and AD-06, and changed FR-12 to distinct messages (ten each) with per-owner picture consent removed. Decisions: [ADR-05](ARCHITECTURE_DECISIONS.md#adr-05-credit-wallet-and-ledger-owned-by-appcoordinator), [ADR-06](ARCHITECTURE_DECISIONS.md#adr-06-message-based-profile-reveal-and-removal-of-per-chat-picture-consent). SRS, matrix and index updated.
- Migration `0006_credits.sql` is additive and must be applied before production traffic. No remote migration or deploy was run.
- Verified locally: `pnpm check` (149 Vitest tests), full Playwright suite 59/59 against local Celld and Vite, `pnpm test:native` exit 0, Cloudflare build and dry-run. Not verified: a deployed Worker, D1 migration on a remote database, a live payment gateway, and a manual two-browser walkthrough.
- Open decisions for the owner: pack prices (provisional USD 5/12/35), whether the verification bonus should apply retroactively to accounts verified before the flag is enabled, and whether `402` is the right status for insufficient credits.
- Pre-existing: `pnpm format:check` fails on HEAD `tests/ports.test.ts`; not changed here.

## Group avatar choice, 2026-11-22

- Group joins (public or invited) ask members to choose their profile picture or one of eight generated avatars. Group rooms need no picture; quick chat still does. Pictures pinned to a group join are served only while approved.
- Changed the Room, join routes, contracts, `src/Avatar.tsx`, `src/AvatarChoice.tsx`, the join modals, the sidebar, SRS FR-04, ADR-04, and tests (`tests/group-avatars.test.ts`, the invited-guest and public-join browser tests).
- Known gap: no way to change the choice after joining.

## Picture required to start a quick chat, 2026-11-22

- Starting a new search requires an approved profile picture (Matcher, 403). Existing active rooms still return. SRS FR-06 and FR-12 updated. Native runtime stage passes. The browser smoke case that creates a group room and then admits a guest failed on this branch, not the base commit: joins now show the avatar step before the request is sent. The test now clicks through that step. A later step (guest page after a block is lifted) failed on origin/staging (66d69bb) too, so it predates this branch: blocking closes the guest's open room, and the test expected it to reopen by itself. The test now reopens the room from the guest's list. Whether access should auto-return after unblock is an open product question.

## Gender-aware quick-chat pairing, 2026-11-22

- The Matcher pairs male–female, male–other, female–other and other–other at once. Male–male and female–female wait one minute for the earlier-queued participant. Unset gender matches at once; this default is not yet confirmed by product.
- Changed `celld/durable-objects/matcher.ts`, FR-06 in `SRS.md`, the matrix, and `tests/domain.test.ts`. Passed: typecheck, the full Vitest suite (134 tests), and a mutation check.
- Not run for this entry: browser or native suites. Later native results are recorded in the matrix.

## Quick-chat milestone split, 2026-11-22

- Permitted ASL unlocks when each participant has ten words in the quick chat. Picture-sharing controls and picture reads unlock when each has twenty. Counts cap at twenty; legacy backfill restores up to twenty from encrypted history. Progress bars stay visible until picture sharing is eligible.
- Changed `packages/contracts/src/index.ts`, `celld/durable-objects/room.ts`, `src/QuickChatDisclosure.tsx`, `src/App.tsx`, FR-12 in `SRS.md` and the related engineering docs, and the FR-12 domain, browser and native tests. Added a legacy restore test above ten words.
- PASS (local): `pnpm exec vitest run tests/fr12.test.ts` (29 tests, including a recount case for counts stored under the old ten-word cap).
- `pnpm test:native` (final review run, 2026-11-22): exit 0. Native 8/8 and 1/1, browser 59/59, Vite 59/59. The origin/staging export was also run and fails `tests/browser/smoke.spec.ts:195` at the same block-then-unblock step, so that failure predates this branch.
- Deploy note: participants whose stored count lacks the current `word_cap` marker are recounted from encrypted history on their next snapshot or message. No manual step is needed.

## Access-control fixes, 2026-11-22

- Source: approval refuses a block in either direction (`celld/durable-objects/room.ts`). `authorize()` denies a non-host member of a shared room when a block exists between them and the host (either direction), which also covers REST, socket upgrade and live delivery. `join_status` omits the title for strangers. LiveKit `DeleteRoom` uses `roomCreate` (`celld/features/providers/livekit.ts`; fixture in `tests/native/providers.ts`).
- Tests: four new regression tests in `tests/domain.test.ts` and `tests/cloudflare-fetch.test.ts`. All four fail on the original code and pass on the fix.
- Decision to confirm with product: shared-room access follows the host's blocks only, matching the join path. Blocks between two ordinary members are unchanged.
- PASS (local): `pnpm typecheck`; `pnpm test` (14 files, 125 tests). `prettier --check` still lists only the three files that already failed (`celld/durable-objects/app.ts`, `tests/domain.test.ts`, `tests/ports.test.ts`). The new lines are clean.
- Not run: `pnpm test:native`, `pnpm test:browser`, Cloudflare dry runs, live LiveKit, deployed checks. The `[ISSUE]` markers in the SRS stay until those pass.
- Checkpoint: `.context/handoffs/access-control-fixes-haiku.md`. Next: confirm the block-scope decision, run the native suite with the Celld CLI, then take IMP-04 to IMP-07.

## Quick-chat ASL in the left sidebar, 2026-11-20

- After the existing ten-word-each gate, the left room sidebar shows only the other participant’s permitted ASL beneath their “Stranger” entry. Both participants get the same perspective-relative behavior. The viewer’s own ASL stays hidden in quick chat; picture consent remains in its own panel.
- Changed `src/RoomSidebar.tsx`, `src/QuickChatDisclosure.tsx`, `src/App.tsx`, FR-12 in `SRS.md`, README quick-chat guidance, the implementation matrix and an existing browser assertion. The backend gate, profile visibility and persisted messages are unchanged.
- PASS: `git diff --check`, `pnpm check` (121 tests), and `pnpm test:native` (9 runtime scenarios plus 58 browser cases against each the built app and Vite, including the sidebar disclosure assertion). No deployment or remote migration. Task details: `.context/handoffs/asl-chat-message-root.md`.

## Quick-chat word milestone, 2026-11-20

- Quick chat displays two word progress bars. Ten words from each participant unlock permitted ASL under the other participant’s entry in the left sidebar and the picture-sharing choice. Photo access still requires the owner's room-specific approval. Existing open rooms restore counts from retained encrypted messages.
- Passed `pnpm check` (121 tests), the native and browser suites, the Cloudflare dry run and local workerd threshold and privacy checks. The fix is local to this workspace. [Verification](IMPLEMENTATION_MATRIX.md#fr-12-implementation)
- Checkpoint is `.context/handoffs/quick-chat-word-progress-root.md`.

## Cloudflare branch checks, 2026-11-19

- Restored the production branch guard in `deploy:cloudflare` and added a test for wiring both publish commands to their guards. `pnpm check` passed 121 tests. With Workers Builds reporting `staging`, the production command exited before build or deploy.
- The project owner confirmed that Cloudflare maps `main` to `charoo-live` and `staging` to `charoo-live-staging`. Cloudflare returned 403 on direct reads of Workers Builds settings and logs. Earlier deployment history confirmed that production stayed on its November 17 version after PR #5 merged to staging. Production Preview Builds is the setting that controls additional build activity from other branches.

## Active chat refresh, 2026-11-19

- In `tbilisi` on `dJangg0/image-spamming-concurrency` at staging base `b1fc9ce`, fixed IMP-08 and the overlapping refreshes reported with it. The active room socket drives fallback. Message updates share one refresh at a time, and duplicate send/socket notifications and already recorded read receipts skip extra work.
- `pnpm check` passed 120 tests. `pnpm test:native` passed nine Celld scenarios and all 58 browser tests against both the built app and Vite. The Cloudflare frontend build passed. The reported production 429s could not be attributed from the screenshot. [Implementation evidence](IMPLEMENTATION_MATRIX.md#verification-gates-and-evidence-log)
- Task checkpoint is `.context/handoffs/chat-refresh-root.md`. The local changes are ready for branch review. Cloudflare runtime verification is pending.

## Current staging integration

- **2026-11-18**, workspace `douala`, branch `dJangg0/staging-main-misalignment-merge`, target `origin/staging`. Local integration combines `origin/main` `5e62d8b` (containing PRs #1 and #2) with staging `68f1157` (PR #3).
- Preserved staging reconnect behavior and branch-gated Cloudflare publishing; integrated main's profile avatar/bio, direct private profile upload, disclosure UX and Cloudflare Preview changes. Profile photos use bounded authenticated format/size checks without an external scanner; room attachments remain scanner-gated. Migration 0005 remains required before deployment.
- Merge conflicts were resolved across SRS/engineering docs, package scripts, profile UI and styles. The profile UI keeps main's identity-card avatar and authoritative completion response plus staging's upload progress and preview retry/error feedback.
- PR [#4](https://github.com/dJangg0/charoo.live/pull/4) is open and mergeable. Latest CI run `44277756939` passed `pnpm check`, `pnpm build`, `pnpm test:native` and the native deployment dry run. It also verified the corrections for stale photo URL/feedback assertions, responsive selectors and the “Confirming your picture…” completion state. No Cloudflare deployment or remote migration was performed.
- Immediate next step: merge PR #4 to `staging`, then verify the remote `staging` head and update this handoff with the merge SHA.

Root [SRS.md](../../SRS.md) remains canonical. Recheck repository and external state before continuing.

| Field | Current state |
|---|---|
| Updated | 2026-11-18 — staging/main integration |
| Repository / workspace | Charoo / `douala` |
| Branch / target | `dJangg0/staging-main-misalignment-merge` / `origin/staging` |
| HEAD at verification | Merge commit to be recorded after local commit |

## Reconnect review follow-up

- Quick-chat history now reports a pending reconnect across all archive rows for the requester and peer. The originating archive still governs validation, acceptance and removal on decline.
- The Connections action says **Accept** and opens the private room returned by the response endpoint.
- Typecheck and 117 Vitest tests passed, including the HTTP regression for a pending request across same-peer archives and clearing that state on decline. Thirty-three Playwright tests passed with API fixtures, including the Connections acceptance regression. Native and deployed runtime checks for these changes remain pending. See the [implementation matrix](IMPLEMENTATION_MATRIX.md#functional-requirements).
- Task checkpoint is `.context/handoffs/reconnect-review-fixes-root.md`.

## Cloudflare deployment isolation

GitHub checks target `main` and `staging`. Production Wrangler uses `https://chat.charoo.live` and staging uses its separate `workers.dev` origin. Package deploy scripts enforce the branch and target match. Cloudflare preview and build controls remain dashboard-managed.

### Delivered and verified

- Updated `.github/workflows/check.yml`: `push` and `pull_request` events now target only `main` and `staging`. The existing workflow runs checks and a Celld dry run; it contains no Cloudflare deployment step.
- Added `cloudflare-deploy-guard.ts` to the production and staging deploy scripts: production requires `main`, staging requires `staging`; Workers Builds reads `WORKERS_CI_BRANCH`, and local deploys use `git branch --show-current`. The README now requires these package scripts instead of raw `wrangler deploy`.
- Updated AD-04 in [SRS.md](../../SRS.md), its [implementation matrix row](IMPLEMENTATION_MATRIX.md), and [README Cloudflare guidance](../../README.md#branch-promotion-and-ci) with the intended branch promotion policy.
- Production config uses `https://chat.charoo.live`; staging config remains `https://charoo-live-staging.shy-star-eff8.workers.dev`. Production and staging Worker names, D1 IDs, R2 buckets, queues and Durable Object namespaces are separate in their respective Wrangler files. The production origin update was already present in the workspace when reviewed; README/SRS now reflect it. No deployment or live runtime check was performed.
- Included the separate profile-picture UI update in the same PR as its own commit: upload phase feedback, preview loading/error/retry states, FR-11 wording and matrix evidence. `pnpm typecheck` passed; 8 focused Playwright cases passed (six responsive sizes, upload success and preview retry). Phase-by-phase upload timing is not separately asserted.
- GitHub Actions API returned zero workflow runs at review time, so no run was available to attribute to the reported push.
- Read-only Wrangler deployment history: latest listed production deployment was Worker version `dff72651-c7aa-4c80-b896-b31a9bf9a348`, source `wrangler`, on 2026-11-17 07:49 UTC; latest listed staging deployment was `188e9f23-4bac-42b7-8e33-0cead645f7e5`, source `wrangler`, on 2026-11-17 10:23 UTC. These are not evidence of Git-connected staging builds or a staging-triggered production promotion.
- Cloudflare's production Worker can run preview builds for non-production branch pushes if previews are enabled; those previews do not update the active production deployment. Disable previews on the production Worker to avoid any production-side build/check from a `staging` push. This dashboard setting could not be inspected or changed here.
- PASS: Ruby YAML parser accepted `.github/workflows/check.yml`; asserted push and pull request filters equal `main` and `staging`. `git diff --check` passed. `actionlint` is not installed. `pnpm check` passed all 113 Vitest tests; profile-picture update passed `pnpm typecheck` and 8 focused Playwright cases. Reconnect UI/native/Cloudflare runtime checks remain unverified.
- PASS (2026-11-18): `pnpm exec vitest run tests/cloudflare-deploy-guard.test.ts` (4 tests) and `pnpm typecheck`. Running `pnpm run deploy:cloudflare` on `dJangg0/cloudflare-deployment-fix` exited at the guard before build/deploy. Full suite and Cloudflare runtime were not run for this task.

## Prior staging state and remaining operational risks

- Isolated staging Worker is `charoo-live-staging`, URL https://charoo-live-staging.shy-star-eff8.workers.dev; separate D1/R2/Queues/DO resources are defined in `wrangler.staging.jsonc`.
- Prior staging deployment `17f1ade6-612c-4112-b9da-579472019756` included quick-chat timeout behavior. The subsequent reservation-deadline review fix was not deployed or runtime verified.
- Existing implementation findings IMP-01 and IMP-03 remain open; IMP-02 remains open if video is enabled. Use synthetic staging data only until access-control findings are resolved.
- Earlier handoff noted production OAuth credential placement issues; verify provider credentials are Worker secrets before production deployment. Do not record secret values.

## Next action

In Cloudflare Workers > each Worker > Settings > Builds > Branch control, confirm production branch `main`, staging branch `staging`, and disable production previews for strict staging isolation. Confirm each build deploy command uses `pnpm run deploy:cloudflare` or `pnpm run deploy:cloudflare:staging` respectively; raw `wrangler deploy` bypasses the repository branch guard. Confirm the production Worker's live `WEB_ORIGIN` variable also matches `https://chat.charoo.live`; repo configuration alone does not update a deployed Worker. A merge to `main` is the production promotion event if automatic production deployment remains enabled.
