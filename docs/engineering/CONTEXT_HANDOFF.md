# Charoo shared engineering handoff

Sanitized summary for the current deployment-isolation work. Root [SRS.md](../../SRS.md) remains canonical. Recheck repository and external state before continuing.

| Field | Current state |
|---|---|
| Updated | 2026-11-17 — GitHub/Cloudflare CI and deployment isolation review |
| Repository / workspace | Charoo / `nicosia` |
| Branch / target | `dJangg0/cloudflare-deployment-fix` / `origin/staging` |
| HEAD | `f9fff705664d8079f6860acc988c72914e2dfce6` |
| Objective / state | GitHub checks are scoped to `main` and `staging`; production Wrangler `WEB_ORIGIN` is `https://chat.charoo.live`, while staging remains on its separate `workers.dev` origin. Cloudflare preview/build controls remain dashboard-managed and were not changed. |

## Delivered and verified

- Updated `.github/workflows/check.yml`: `push` and `pull_request` events now target only `main` and `staging`. The existing workflow runs checks and a Celld dry run; it contains no Cloudflare deployment step.
- Updated AD-04 in [SRS.md](../../SRS.md), its [implementation matrix row](IMPLEMENTATION_MATRIX.md), and [README Cloudflare guidance](../../README.md#branch-promotion-and-ci) with the intended branch promotion policy.
- Production config uses `https://chat.charoo.live`; staging config remains `https://charoo-live-staging.shy-star-eff8.workers.dev`. Production and staging Worker names, D1 IDs, R2 buckets, queues and Durable Object namespaces are separate in their respective Wrangler files. The production origin update was already present in the workspace when reviewed; README/SRS now reflect it. No deployment or live runtime check was performed.
- GitHub Actions API returned zero workflow runs at review time, so no run was available to attribute to the reported push.
- Read-only Wrangler deployment history: latest listed production deployment was Worker version `dff72651-c7aa-4c80-b896-b31a9bf9a348`, source `wrangler`, on 2026-11-17 07:49 UTC; latest listed staging deployment was `188e9f23-4bac-42b7-8e33-0cead645f7e5`, source `wrangler`, on 2026-11-17 10:23 UTC. These are not evidence of Git-connected staging builds or a staging-triggered production promotion.
- Cloudflare's production Worker can run preview builds for non-production branch pushes if previews are enabled; those previews do not update the active production deployment. Disable previews on the production Worker to avoid any production-side build/check from a `staging` push. This dashboard setting could not be inspected or changed here.
- PASS: Ruby YAML parser accepted `.github/workflows/check.yml`; asserted push and pull request filters equal `main` and `staging`. `git diff --check` passed. `actionlint` is not installed; no application tests were run for this workflow/documentation change.

## Prior staging state and remaining operational risks

- Isolated staging Worker is `charoo-live-staging`, URL https://charoo-live-staging.shy-star-eff8.workers.dev; separate D1/R2/Queues/DO resources are defined in `wrangler.staging.jsonc`.
- Prior staging deployment `17f1ade6-612c-4112-b9da-579472019756` included quick-chat timeout behavior. The subsequent reservation-deadline review fix was not deployed or runtime verified.
- Existing implementation findings IMP-01 and IMP-03 remain open; IMP-02 remains open if video is enabled. Use synthetic staging data only until access-control findings are resolved.
- Earlier handoff noted production OAuth credential placement issues; verify provider credentials are Worker secrets before production deployment. Do not record secret values.

## Next action

In Cloudflare Workers > each Worker > Settings > Builds > Branch control, confirm production branch `main`, staging branch `staging`, and disable production previews for strict staging isolation. Confirm each build deploy command uses `pnpm run deploy:cloudflare` or `pnpm run deploy:cloudflare:staging` respectively. Confirm the production Worker's live `WEB_ORIGIN` variable also matches `https://chat.charoo.live`; repo configuration alone does not update a deployed Worker. A merge to `main` is the production promotion event if automatic production deployment remains enabled.
