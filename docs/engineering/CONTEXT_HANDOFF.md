## Active feature work — reconnect consent (2026-11-17)

- User authorized a reconnect request flow with recipient accept/reject and removal of the associated archive when rejected. Implemented in source and documented in FR-06; four focused domain tests and one API test pass locally.
- Exact requester-owned, unexpired archive ID is required; acceptance checks current archive and creates a private room; rejection atomically marks the request and deletes only that archive row. The quick-chat archive is asymmetric: the person left behind owns the row.
- Reconnect is free under `reconnect_price: 0`. GAP-01's local implementation is covered by tests for exact archive, duplicate, acceptance, expiry, rejection/archive removal, block denial and the pending archive API field. `pnpm check` passes 113 tests; browser request/response UI, native runtime and production deployment remain unverified.
- Task checkpoint: `.context/handoffs/reconnect-consent-codex.md`. The profile-picture feedback changes and FR-11 documentation are also included as a separate PR commit, with typecheck and 8 focused browser tests passing.

# Charoo shared engineering handoff

Sanitized summary for the current deployment-isolation work. Root [SRS.md](../../SRS.md) remains canonical. Recheck repository and external state before continuing.

| Field | Current state |
|---|---|
| Updated | 2026-11-17 — GitHub/Cloudflare CI and deployment isolation review |
| Repository / workspace | Charoo / `nicosia` |
| Branch / target | `dJangg0/cloudflare-deployment-fix` / `origin/staging` |
| HEAD | Check the current branch tip with `git rev-parse HEAD`; this handoff is committed alongside the PR changes. |
| Objective / state | GitHub checks are scoped to `main` and `staging`; production Wrangler `WEB_ORIGIN` is `https://chat.charoo.live`, while staging remains on its separate `workers.dev` origin. Cloudflare preview/build controls remain dashboard-managed and were not changed. |

## Delivered and verified

- Updated `.github/workflows/check.yml`: `push` and `pull_request` events now target only `main` and `staging`. The existing workflow runs checks and a Celld dry run; it contains no Cloudflare deployment step.
- Updated AD-04 in [SRS.md](../../SRS.md), its [implementation matrix row](IMPLEMENTATION_MATRIX.md), and [README Cloudflare guidance](../../README.md#branch-promotion-and-ci) with the intended branch promotion policy.
- Production config uses `https://chat.charoo.live`; staging config remains `https://charoo-live-staging.shy-star-eff8.workers.dev`. Production and staging Worker names, D1 IDs, R2 buckets, queues and Durable Object namespaces are separate in their respective Wrangler files. The production origin update was already present in the workspace when reviewed; README/SRS now reflect it. No deployment or live runtime check was performed.
- Included the separate profile-picture UI update in the same PR as its own commit: upload phase feedback, preview loading/error/retry states, FR-11 wording and matrix evidence. `pnpm typecheck` passed; 8 focused Playwright cases passed (six responsive sizes, upload success and preview retry). Phase-by-phase upload timing is not separately asserted.
- GitHub Actions API returned zero workflow runs at review time, so no run was available to attribute to the reported push.
- Read-only Wrangler deployment history: latest listed production deployment was Worker version `dff72651-c7aa-4c80-b896-b31a9bf9a348`, source `wrangler`, on 2026-11-17 07:49 UTC; latest listed staging deployment was `188e9f23-4bac-42b7-8e33-0cead645f7e5`, source `wrangler`, on 2026-11-17 10:23 UTC. These are not evidence of Git-connected staging builds or a staging-triggered production promotion.
- Cloudflare's production Worker can run preview builds for non-production branch pushes if previews are enabled; those previews do not update the active production deployment. Disable previews on the production Worker to avoid any production-side build/check from a `staging` push. This dashboard setting could not be inspected or changed here.
- PASS: Ruby YAML parser accepted `.github/workflows/check.yml`; asserted push and pull request filters equal `main` and `staging`. `git diff --check` passed. `actionlint` is not installed. `pnpm check` passed all 113 Vitest tests; profile-picture update passed `pnpm typecheck` and 8 focused Playwright cases. Reconnect UI/native/Cloudflare runtime checks remain unverified.

## Prior staging state and remaining operational risks

- Isolated staging Worker is `charoo-live-staging`, URL https://charoo-live-staging.shy-star-eff8.workers.dev; separate D1/R2/Queues/DO resources are defined in `wrangler.staging.jsonc`.
- Prior staging deployment `17f1ade6-612c-4112-b9da-579472019756` included quick-chat timeout behavior. The subsequent reservation-deadline review fix was not deployed or runtime verified.
- Existing implementation findings IMP-01 and IMP-03 remain open; IMP-02 remains open if video is enabled. Use synthetic staging data only until access-control findings are resolved.
- Earlier handoff noted production OAuth credential placement issues; verify provider credentials are Worker secrets before production deployment. Do not record secret values.

## Next action

In Cloudflare Workers > each Worker > Settings > Builds > Branch control, confirm production branch `main`, staging branch `staging`, and disable production previews for strict staging isolation. Confirm each build deploy command uses `pnpm run deploy:cloudflare` or `pnpm run deploy:cloudflare:staging` respectively. Confirm the production Worker's live `WEB_ORIGIN` variable also matches `https://chat.charoo.live`; repo configuration alone does not update a deployed Worker. A merge to `main` is the production promotion event if automatic production deployment remains enabled.
