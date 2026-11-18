# Charoo shared engineering handoff

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
