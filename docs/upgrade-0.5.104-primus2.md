# 9Router 0.5.104-primus2 acceptance

Date: 2026-10-22 (+07). Repository: https://github.com/Suphot-Ch/9router.

## Scope

Merge upstream `v0.5.104` (`87a74e1bda3677193c6f71a7e2100c90311f0689`) into the existing Primus lineage at `a655cbd0`, preserving pricing/import, custom quota, model-health and Responses/Meta behavior. Exact release identifier: `0.5.104-primus2`.

Original dirty checkouts `/home/user/9router-custom` and `/home/user/workspace/9router` were not edited. Release worktree: `/home/user/workspace/9router-0.5.104-primus2`; branch `release/0.5.104-primus2`.

## Conflict resolution

- Retain upstream extracted Claude conversion helper and add Primus visible refusal handling.
- Retain quota zero/unknown behavior and upstream quota units.
- Keep both upstream and prior Primus release notes.
- Update the pricing catalog fixture from retired GPT-5.5 to current GPT-5.6 Sol; assert the retired entry is absent.

## Verification

- Selected all test files changed by either upstream upgrade or prior Primus patches: 63 files, 840 assertions, 836 passed, 4 failed, zero skipped. Run with 3 workers and 30s hook timeout to avoid build-concurrency timeout noise.
- All four failures reproduce with identical names/messages in pristine upstream v0.5.104: GLM-5.2 reasoning effort, Codex Sol capabilities, combo default context, Antigravity retry count. No new selected-suite failures.
- Provider registry baseline: 94 providers; alias baseline: 132 tokens; OAuth URL baseline passed.
- Focused lint: two existing `react-hooks/set-state-in-effect` errors in QuotaTable, independently reproduced on pristine upstream. Other manually resolved JS files passed focused lint.
- Docker build completed with Next.js 16.4.2 / Node 22 Alpine. Image `rd-primus/9router:0.5.104-primus2`, ID `sha256:6cc788c01d816ea898dff1fcf922649a7f11ec27e4414972cc9a1e646adad6e0`.
- Sanitized SQLite staging snapshot: all provider connections/API keys/proxy pools/combos removed, startup settings disabled. HTTP health/version/pricing page/editor passed; editor contains 1508 rows. Rechecked startup and routes in a network-none container using `DISABLE_BACKGROUND_TOKEN_REFRESH=1`, `MODEL_CATALOG_SYNC=off`.
- Production recreated only service `9router` with the existing base Compose plus the release worktree override. Runtime image ID, OCI version label, package metadata and `/api/version` match.
- Health returns HTTP 200, `ok=true`. Unauthenticated pricing/provider/usage APIs return HTTP 401; downstream inference bearer cannot access pricing administration.
- Existing dashboard login works via public HTTPS. Session cookie is Secure, HttpOnly, SameSite=Lax. Mobile Pricing at 390px has scrollWidth=390, with version visible.
- Auth environment values preserved by private equality/hash comparison. Mount remains existing `/app/data`. Provider connections=22, nodes=4, API keys=13. Pricing/importedPricing/customModels hashes unchanged. Database integrity_check=ok.
- Custom unsupported quota returns supported=false and empty quotas; official OpenRouter custom key-budget route returns supported=true and empty quotas (no finite key limit, not a zero balance).
- Authenticated model catalog HTTP 200, 301 unique models.
- Real inference `ds/deepseek-v4-flash`, prompt `Reply with exactly OK.`, stream=false, max_tokens=256: HTTP 200, nonempty content, finish_reason=stop, returned model `deepseek-flash`, prompt_tokens=2035, completion_tokens=11, total_tokens=2046.
- Runtime extracted Claude helper hash equals final source. Staging containers removed after checks.

## Security limitations

Dependency audit of locally resolved production dependencies reports 4 high and 2 moderate package findings, including node-forge, proxy glob dependencies and Monaco/DOMPurify. These are not claimed fixed; no unsafe `npm audit fix --force` or unrelated major dependency upgrade was applied. Dockerfile uses npm install without a tracked lockfile, so dependency resolution is not reproducible. The packaged image has no lockfile for a direct npm audit result; local audit is not represented as an exhaustive image audit.

This upgrade does not implement the separate per-connection usage-summary backlog. The selected tests are not the entire repository suite, and one successful inference does not establish every provider/model works.

## Rollback

Prior image retained as `rd-primus/9router:0.5.99-primus.2` and `rd-primus/9router:rollback-pre-0.5.104-primus2`, old image ID `sha256:7dbba6d2dc18efe904aea347e8ac7b6d63fbba40f177e32a95e0d353964c9051`.

Consistent SQLite backup: `/home/user/ai-local/primus-ai/backups/9router-pre-0.5.104-primus2-20261022-135755/data.sqlite`, permissions 0600, integrity_check=ok. Restore only with the service stopped and account for post-backup usage; do not overwrite an active WAL database. Existing non-database auth/runtime files remain in place.

To revert the image only, use the original override `/home/user/9router-custom/compose.production.override.yml` with the same base Compose and `up -d --no-deps --pull never 9router`. Assess data compatibility before rollback; a retained image alone is not a complete database rollback.
