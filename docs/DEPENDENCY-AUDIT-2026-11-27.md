# Dependency security audit · 2026-11-27

The audit started from production commit `29448aea3fa10d226ef82ec5bf0a65e723d6ec39` on `feat/model-council`. npm reported eight unique advisories in the full workspace graph and zero in the production-only graph. The three applicable OpenTelemetry fixes from PR #14 remove five affected package entries from the lockfile audit. The other instances of the same database-instrumentation advisory remain open. Python's pinned requirements yielded 12 distinct advisories. The production model worker installs affected versions when enabled, and the production code review found no call path to the vulnerable functions listed below. [Production commit](https://github.com/ahmadalwakai/Mohassan-AI/commit/29448aea3fa10d226ef82ec5bf0a65e723d6ec39) · [PR #14](https://github.com/ahmadalwakai/Mohassan-AI/pull/14)

External sources and advisory records below were retrieved on 2026-11-27. npm findings come from the npm registry audit service. Python findings come from `pip-audit` 2.10.1 and the PyPI vulnerability service. Reachability is based on the pinned dependency chains, application entry points and documented deployment. The audit did not inspect the live deployment or reproduce any vulnerability. [npm audit](https://docs.npmjs.com/cli/v11/commands/npm-audit/) · [npm registry](https://registry.npmjs.org/) · [pip-audit](https://github.com/pypa/pip-audit/tree/v2.10.1) · [PyPI release API](https://docs.pypi.org/api/json/)

## npm advisories

- `Lighthouse` is `lighthouse@12.8.2`, a root dev dependency. `Sentry` below it is `@sentry/node@9.47.2`.
- `Browser downloader` is Lighthouse → `puppeteer-core@24.43.1` → `@puppeteer/browsers@2.13.2`. Its FTP branch continues through `proxy-agent@6.5.0` → `pac-proxy-agent@7.2.0` → `get-uri@6.0.5`.
- `Installer` is the desktop workspace dev dependency `electron-builder@26.18.0` → `app-builder-lib@26.18.0`. [Baseline lockfile](https://github.com/ahmadalwakai/Mohassan-AI/blob/29448aea3fa10d226ef82ec5bf0a65e723d6ec39/package-lock.json)

| Advisory | Severity | Affected lockfile path | Reachable in production? | Action |
| --- | --- | --- | --- | --- |
| [GHSA-8988-4f7v-96qf](https://github.com/advisories/GHSA-8988-4f7v-96qf) · unbounded W3C baggage allocation | Moderate | Sentry → `@opentelemetry/core@1.30.1`, shared with Sentry OpenTelemetry resources, tracing and instrumentations | No. Site measurement tooling. | Upgrade Lighthouse and Sentry together to a compatible OpenTelemetry 2 stack. First Core fix is `2.8.0`. |
| [GHSA-qqmp-wf37-98f9](https://github.com/advisories/GHSA-qqmp-wf37-98f9) · database usernames in spans | Moderate | Sentry → `@opentelemetry/instrumentation-knex@0.44.1`, `instrumentation-mysql@0.45.1` and `instrumentation-tedious@0.18.1` | No. Site measurement tooling. | Applied exact scoped overrides to `0.65.0`, `0.67.0` and `0.40.0` respectively. |
| [GHSA-qqmp-wf37-98f9](https://github.com/advisories/GHSA-qqmp-wf37-98f9) · database usernames in spans | Moderate | Sentry → `@opentelemetry/instrumentation-mongoose@0.46.1`, `instrumentation-mysql2@0.45.2` and `instrumentation-pg@0.51.1` | No. Site measurement tooling. | Move to `0.67.0`, `0.67.0` and `0.73.0` respectively with the compatible OpenTelemetry 2 stack. |
| [GHSA-c475-qrg2-pj4r](https://github.com/advisories/GHSA-c475-qrg2-pj4r) · FTP listing CPU exhaustion | High | Browser downloader FTP branch → `basic-ftp@5.3.1` | No. Site measurement downloader dependency. | First fix `6.2.1`. Upgrade the downloader stack. |
| [GHSA-5pm8-86m8-9m6r](https://github.com/advisories/GHSA-5pm8-86m8-9m6r) · FTP listing crash | Moderate | Browser downloader FTP branch → `basic-ftp@5.3.1` | No. Site measurement downloader dependency. | First fix `6.2.4`. Upgrade the downloader stack. |
| [GHSA-r4jh-29pc-gfqr](https://github.com/advisories/GHSA-r4jh-29pc-gfqr) · FTP password or resumed-download crash | Moderate | Browser downloader FTP branch → `basic-ftp@5.3.1` | No. Site measurement downloader dependency. | First fix `6.2.3`. Upgrade the downloader stack. |
| [GHSA-jmr9-qjv8-65gv](https://github.com/advisories/GHSA-jmr9-qjv8-65gv) · ZIP symlink traversal | High | Browser downloader → `extract-zip@2.0.1` | No. Site measurement downloader dependency. | No patched version reported. Move to a downloader that removes this dependency. |
| [GHSA-7pqw-9j4j-h8q3](https://github.com/advisories/GHSA-7pqw-9j4j-h8q3) · ZIP symlink file overwrite | High | Browser downloader → `extract-zip@2.0.1` | No. Site measurement downloader dependency. | No patched version reported. Move to a downloader that removes this dependency. |
| [GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249) · glob matching denial of service | Moderate | Sentry → `minimatch@9.0.9`, Installer → `minimatch@10.2.6` and Installer → `@electron/universal@2.0.3` → `minimatch@9.0.9` | No. Site measurement and desktop packaging only. | First fix `11.0.1`. Update the Lighthouse and Electron Builder dependency trees and verify installer contents. |

The Fastify server starts from `apps/server/src/index.ts`. The Linux deploy installs dev dependencies for its `tsx` launcher, so the affected tooling may be on disk. The server runtime does not call the development site measurement script. The Next.js web app proxies API requests to the server. The Electron shell uses Electron and Node APIs and builds its installer from a clean staging directory. The Chrome extension has no npm dependencies. The sole direct Lighthouse consumer is a loopback site baseline script. [Server entry point](../apps/server/src/index.ts) · [Linux setup](../scripts/cloud-linux/README.md) · [Web API proxy](../apps/web/app/api/%5B...path%5D/route.ts) · [Desktop shell](../apps/desktop/src/main.ts) · [Installer](../apps/desktop/scripts/build-installer.mjs) · [Chrome extension](../packages/chrome-extension/package.json) · [Site measurement](../scripts/sites-baseline.ts)

### Applied and deferred changes

- The three PR #14 overrides are limited to `lighthouse@12.8.2` → `@sentry/node@9.47.2`. The lockfile changes four existing entries and adds 18 nested dependencies, all marked dev. Three changed entries are the fixed instrumentations and the fourth is their MySQL type dependency. The shared OpenTelemetry 1.x SDK and all production dependency entries retain their versions. The fixed integrations use newer database attributes. The site's programmatic Lighthouse entry point does not initialize Sentry's CLI instrumentation, and the smoke check exercised initialization of the three affected plugins. [PR #14](https://github.com/ahmadalwakai/Mohassan-AI/pull/14) · [OpenTelemetry attribute change](https://github.com/open-telemetry/opentelemetry-js-contrib/pull/3585)
- OpenTelemetry Core 2 changes the SDK and Resources API. The remaining Mongoose and PostgreSQL fixes require Core 2.9 or newer, and the MySQL2 fix adds SQL Common 0.42, which depends on Core 2. Move the Lighthouse/Sentry stack together and remove the temporary overrides after retesting. [OpenTelemetry 2 migration guide](https://github.com/open-telemetry/opentelemetry-js/blob/v2.0.0/doc/upgrade-to-2.x.md) · [Mongoose package metadata](https://registry.npmjs.org/@opentelemetry%2finstrumentation-mongoose/0.67.0) · [MySQL2 package metadata](https://registry.npmjs.org/@opentelemetry%2finstrumentation-mysql2/0.67.0) · [PostgreSQL package metadata](https://registry.npmjs.org/@opentelemetry%2finstrumentation-pg/0.73.0) · [SQL Common package metadata](https://registry.npmjs.org/@opentelemetry%2fsql-common/0.42.0)
- Lighthouse 13.6.0 moves to Sentry 11 and Puppeteer 25. Evaluate this upgrade for the OpenTelemetry, FTP and ZIP chains together and rerun the site measurement baseline because Lighthouse 13 changes scored audits. If maintaining the old stack, `get-uri@6.0.5` requires FTP 5. Moving it to FTP 6.2.4 or newer requires compatibility testing for FTP 6's control/data host policy. [Lighthouse 13.6.0 package metadata](https://registry.npmjs.org/lighthouse/13.6.0) · [Lighthouse 13 release](https://github.com/GoogleChrome/lighthouse/releases/tag/v13.0.0) · [Puppeteer 25 release](https://github.com/puppeteer/puppeteer/releases/tag/puppeteer-v25.0.0) · [get-uri package metadata](https://registry.npmjs.org/get-uri/6.0.5) · [Basic FTP 6 changes](https://github.com/patrickjuchli/basic-ftp/blob/v6.0.0/CHANGELOG.md)
- Electron Builder 26.18.1 still depends on a vulnerable minimatch range. Minimatch 11 changes parsed globs and partial matching. Wait for a compatible Builder release or explicitly verify Windows installer contents and paths before updating the packaged build. [Builder package metadata](https://registry.npmjs.org/app-builder-lib/26.18.1) · [Minimatch 11 changes](https://github.com/isaacs/minimatch/blob/v11.0.0/changelog.md)

## Python advisories

The optional production model worker uses the hash-pinned Linux aarch64 wheel closure with CPython 3.12. The worker loads checkpoints from operator-owned local paths and checks their SHA-256 before loading the validated snapshot with `torch.load(..., weights_only=True)`. The checked code does not route chat input to checkpoint selection, PT2 loading or `torch.jit.script`. Deployment installs binary wheels with hashes and a private state directory. The execution-pipeline manifest is for local training and tests. Its PyTorch advisory IDs overlap with the worker's. [Production worker setup](../scripts/cloud-linux/setup-model-worker.sh) · [Pinned wheel closure](../scripts/cloud-linux/model-worker-requirements-aarch64.txt) · [Operator deployment](V5-OWNER-CHAT-2026-11-26.md) · [Checkpoint loader](../packages/execution-integration/model_worker/checkpoints.py) · [Systemd unit](../scripts/cloud-linux/mohassan.service)

| Advisory | Pinned dependency | Reachable in production? | Action |
| --- | --- | --- | --- |
| [CVE-2026-4538](https://www.cve.org/CVERecord?id=CVE-2026-4538) / PYSEC-2026-139 · PT2 deserialization | `torch@2.10.0` in the pipeline and worker wheel closure | No PT2 package loader is called. The worker accepts pinned tensor checkpoints via a separate, validated loader. | Keep promotions restricted to approved checkpoint files. Check upstream for a confirmed fixed release before changing this pin. |
| [GHSA-rrmf-rvhw-rf47](https://github.com/advisories/GHSA-rrmf-rvhw-rf47) / PYSEC-2025-194 · `torch.jit.script` memory corruption | Same torch pins | No `torch.jit.script` call in the production worker path. | Candidate fix `2.13.0`. Validate the full CPU wheel closure and pinned checkpoints on aarch64. |
| [GHSA-6w46-j5rx-g56g](https://github.com/advisories/GHSA-6w46-j5rx-g56g) / PYSEC-2026-1845 · Unix temp directory handling | `pytest@7.4.3` in the pipeline | No. Development tests only. | Upgrade to `9.0.3` or newer in a pipeline change and rerun pytest. |
| [GHSA-v4x8-3wr5-3wq8](https://github.com/advisories/GHSA-v4x8-3wr5-3wq8) · SQLite lock path and side files on POSIX | `filelock@3.21.1` in the worker | No SQLite reader/writer lock call traced. The issue requires a locally writable lock directory. | Update to `4.2.1` or newer in the worker closure after compatibility testing. |
| [GHSA-9vhv-jxww-xfm5](https://github.com/advisories/GHSA-9vhv-jxww-xfm5) · Windows reader/writer lock side files | Same filelock pin | No. Worker deploy targets Linux. | Include the `4.2.1` fix when updating the closure. |
| [GHSA-j8f7-rjxc-mr56](https://github.com/advisories/GHSA-j8f7-rjxc-mr56) · SQLite follows a reader/writer lock path symlink | Same filelock pin | No SQLite reader/writer lock call traced. The issue requires local ability to place a symlink. | First fix `4.0.9`. The proposed `4.2.1` update covers it. |
| [GHSA-8mx5-7m5m-r77g](https://github.com/advisories/GHSA-8mx5-7m5m-r77g) · inherited permissions on Windows lock files | Same filelock pin | No. Worker deploy targets Linux. | Include the `4.2.1` fix when updating the closure. |
| [GHSA-69hj-f68j-2879](https://github.com/advisories/GHSA-69hj-f68j-2879) · Unix lock file truncation or mode changes | Same filelock pin | No vulnerable lock path traced. The issue requires another local user to place a file at the lock path. | Include the `4.2.1` fix when updating the closure. |
| [GHSA-cwqr-hh33-gh44](https://github.com/advisories/GHSA-cwqr-hh33-gh44) · crafted SQLite lock database can stall acquisition | Same filelock pin | No SQLite reader/writer lock call traced. The issue requires local write access to a lock database or its directory. | Include the `4.2.1` fix when updating the closure. |
| [GHSA-27vj-qcqg-25rc](https://github.com/advisories/GHSA-27vj-qcqg-25rc) / PYSEC-2026-4217 · template rendering in external filesystem references | `fsspec@2025.12.0` in the worker | No reference filesystem or external reference JSON reaches the worker. | Update to `2026.6.0` or newer when validating the worker closure. |
| [GHSA-h35f-9h28-mq5c](https://github.com/advisories/GHSA-h35f-9h28-mq5c) / PYSEC-2026-3447 · macOS source distribution exclusions | `setuptools@80.9.0` in the worker | No. Linux deployment installs hashed wheels and does not build a macOS source distribution. | First fix `83.0.0`. The proposed `84.1.0` update covers it. |
| [GHSA-xmj3-9gf7-h52w](https://github.com/advisories/GHSA-xmj3-9gf7-h52w) · Windows legacy wheel installation path escape | Same setuptools pin | No. Linux deployment uses pip's binary wheel installation. | Update to `84.1.0` or newer when validating the worker closure. |

The local host is Linux x86_64 and does not validate the deployed aarch64 binaries, their hashes or the real checkpoint. Keep the worker pins until the replacement wheels have been reviewed and verified on the deployment target. The five local requirements lists without lockfiles were checked at their explicit pins. Their unpinned transitive dependencies were outside this resolution-free scan.

## Verification

Commands ran from the workspace root or an isolated copy of the same production commit, with Node `v24.22.3`, npm `11.19.1` and Python `3.12.14`.

| npm command | Baseline lockfile | Updated lockfile |
| --- | --- | --- |
| `npm audit --json` before installation | 35 affected package entries, 27 moderate and 8 high, exit 1 | 30 affected package entries, 22 moderate and 8 high, exit 1 |
| `npm audit --omit=dev --json` before installation | 0, exit 0 | 0, exit 0 |

npm counts transitively affected package entries in addition to packages named directly by an advisory. Full audit exit 1 indicates remaining advisories. On the updated lockfile, `npm install --package-lock-only --ignore-scripts --no-audit` regenerated the resolution in 2.096 s. `npm ci` passed in 11.832 s and `npm run typecheck` passed in 28.937 s. npm used a writable local cache.

An additional `npm audit --json` from the installed workspace reported 33 affected entries on the baseline and 30 after the overrides, with the same eight unique advisories. The updated installed workspace's `npm audit --omit=dev --json` also returned zero.

`npm test -- tests/sites-commands.test.ts tests/sites-compose.test.ts tests/sites-recognize.test.ts tests/sites-plan.test.ts tests/sites-theme-copy.test.ts` passed 41 tests in five files (5.922 s wall time). The direct Node ESM smoke check below passed in 0.788 s.

```sh
node --input-type=module - <<'NODE'
import assert from 'node:assert/strict';
import lighthouse from 'lighthouse';
import { knexIntegration, mysqlIntegration, tediousIntegration } from '@sentry/node';
assert.equal(typeof lighthouse, 'function');
for (const integration of [knexIntegration, mysqlIntegration, tediousIntegration]) {
  assert.equal(typeof integration().name, 'string');
}
NODE
```

`npm exec -- playwright install chromium` succeeded in 83.371 s with a writable `PLAYWRIGHT_BROWSERS_PATH`. With the same browser cache, `npm exec -- tsx scripts/sites-baseline.ts --only services-ar --out /workspace/work/lighthouse-audit-smoke` passed in 19.148 s. A JSON assertion verified the site's checks and confirmed that Lighthouse returned four categories for each desktop and mobile preset.

The Python scans used the following command for each input, with a writable HTTP cache and individual JSON outputs. They checked the recorded versions without installing requirements. For the worker only, the input was a temporary copy of the wheel closure with hash options removed and its platform-specific `torch@...2.10.0+cpu...` URL expressed as `torch==2.10.0` for the upstream PyPI release lookup. This does not inspect the exact CPU wheel.

```sh
python -m pip_audit --disable-pip --no-deps --strict --cache-dir "$audit_dir/cache" \
  --progress-spinner off -f json -r "$requirements" -o "$output"
```

| Input | Distinct advisories | Exit | Wall time |
| --- | --- | --- | --- |
| `packages/execution-pipeline/requirements.txt` | 3 | 1 | 2.357 s |
| `packages/head-training/requirements.txt` | 0 | 0 | 0.924 s |
| `packages/scratch-classifiers/requirements.txt` | 0 | 0 | 1.514 s |
| `scripts/chat-training/requirements-data.txt` | 0 | 0 | 0.890 s |
| `scripts/refusal-classifier/requirements.txt` | 0 | 0 | 0.370 s |
| Normalized `scripts/cloud-linux/model-worker-requirements-aarch64.txt` | 11 | 1 | 2.623 s |

PyPI returned duplicate records for the pytest temp directory and setuptools macOS advisories. The table counts each advisory once per input. The two torch advisories appeared in both affected inputs.
