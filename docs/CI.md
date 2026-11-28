# Production CI

CI runs on pull requests targeting `feat/model-council` and on pushes to that branch. A newer run cancels the previous run for the same ref. The workflow uses Ubuntu 24.04, read-only repository access and no repository secrets. Both jobs install Node.js 24.22.3 and Python 3.12.14 from the pins in the development benchmark Dockerfile. The npm cache uses the root lockfile, and `npm ci` runs in every job. [Runtime pins, retrieved 2026-11-27](https://github.com/ahmadalwakai/Mohassan-AI/blob/29448aea3fa10d226ef82ec5bf0a65e723d6ec39/scripts/dev-bench/Dockerfile)

The setup actions are pinned to the commits behind their upstream tags, checked on 2026-11-27. [Checkout v6](https://github.com/actions/checkout/commit/d23441a48e516b6c34aea4fa41551a30e30af803) · [Setup Node v6](https://github.com/actions/setup-node/commit/249970729cb0ef3589644e2896645e5dc5ba9c38) · [Setup Python v7.1.0](https://github.com/actions/setup-python/commit/6d4fd22b20465ccc0f7354476588e8df7c9ca0e0)

## Required fast job

`Fast checks` installs the workspace dependencies, typechecks the root project and web workspace, and runs seven focused test files. The configuration tests reject production use of local fixture settings and external AI credentials. The API and member tests cover sign-in, origin checks and owner/member route boundaries. The migration test checks startup order, repeat startup and legacy migration IDs. The chat tests check idempotent retries, conversation versions and the wait endpoint.

From the repository root on Linux, put the pinned runtimes on `PATH` and run the same commands. The fixtures use local PGlite and in-process HTTP requests. Leave `PLATFORM_MIGRATION_TEST_DATABASE_URL` unset to use the embedded migration fixture.

```bash
npm ci
npm run typecheck
npm test -- \
  tests/config-boundary.test.ts \
  tests/external-ai-cut.test.ts \
  tests/api-security.test.ts \
  tests/members-access.test.ts \
  tests/platform-wave-migrations.test.ts \
  tests/chat-idempotency.test.ts \
  tests/chat-wait.test.ts
```

## Optional full Vitest suite

Four jobs divide the default Vitest file set. Each job installs Playwright Chromium and its system dependencies and uses the repository's Vitest configuration. A shard failure remains visible in Actions, and the other shards continue to run. Historical full-suite runs took about 36 minutes with three file workers and 102 minutes serially. The Linux suite has reported failures when the Git-ignored Ads vocabulary, Windows tooling or a trusted Python interpreter was unavailable. Other tests skip when optional model fixtures are missing. [Full-suite baseline](INTEGRATION-WAVE-5-2026-11-25.md#full-vitest) · [Serial run](RELEASE-CANDIDATE-2026-11-25.md#full-vitest)

From the repository root on Linux, run the shard commands individually to reproduce their results.

```bash
npm ci
npx playwright install --with-deps chromium
npm test -- --shard=1/4
npm test -- --shard=2/4
npm test -- --shard=3/4
npm test -- --shard=4/4
```

## GitHub Actions prerequisite

GitHub recorded an account billing lock during the first CI attempt on 2026-11-24. The owner needs to resolve billing before hosted jobs can start. Once `Fast checks` has reported on a pull request, select that status check as required in the branch protection rule or ruleset for `feat/model-council` and leave the four `Full Vitest` checks optional. [Prior workflow](https://github.com/ahmadalwakai/Mohassan-AI/pull/4) · [Failed run, reviewed 2026-11-27](https://github.com/ahmadalwakai/Mohassan-AI/actions/runs/45480659472) · [Required status checks](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches#require-status-checks-before-merging)
