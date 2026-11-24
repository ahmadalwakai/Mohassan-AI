# تدقيق تبعيات npm — 2026-11-24

شمل التدقيق مساحات العمل `apps/*` و`packages/*` وملف القفل الجذري على Node 24. أبلغ التدقيق الكامل قبل التعديل عن 35 حزمة متأثرة ضمن ثمانية تنبيهات أمنية. بعد تثبيت ثلاثة إصدارات مصحَّحة ضمن تبعيات Lighthouse فقط، انخفض العدد إلى 30 حزمة. ظل عدد التنبيهات الفريدة ثمانية لأن تنبيه أدوات قواعد البيانات ما زال ينطبق على ثلاث حزم أخرى.

أعطى `npm audit --omit=dev` صفر نتائج قبل التعديل وبعده. تتبعنا مسارات التشغيل للخادم وواجهة Vercel وتطبيق سطح المكتب وإضافة Chrome. تبعيات التنبيهات تخص أداة قياس المواقع أو تجهيز مثبّت سطح المكتب، ولا يصل إليها كود التشغيل في أيٍّ من الأهداف الأربعة. يوضّح الجدول الإصلاحات المطبقة وما يلزم للبنود المؤجلة.

نجح التثبيت وفحص الأنواع قبل التعديل وبعده. سجّل تشغيل الاختبارات الكامل 23 إخفاقًا قبل التعديل و22 بعده. ظهرت حالتا إخفاق في استعادة المهام بعد التعديل فقط في التشغيل الكامل، ونجحتا عند إعادة تشغيلهما على النسختين.

## Advisories

| Advisory | Severity | Dependency path (baseline) | Reachable in production? | Action |
| --- | --- | --- | --- | --- |
| [GHSA-8988-4f7v-96qf](https://github.com/advisories/GHSA-8988-4f7v-96qf) — unbounded baggage allocation | Moderate | `OTel → core@1.30.1`, also via Sentry OTel packages, Resources, SDK Trace Base, SQL Common and instrumentations for AMQP, Connect, Express, FS, Hapi, HTTP, Koa, Mongoose, PG and Undici | S/W/D/C no | Deferred. Core 2.8.0 requires a coordinated OTel/Sentry migration. |
| [GHSA-qqmp-wf37-98f9](https://github.com/advisories/GHSA-qqmp-wf37-98f9) — DB username in spans | Moderate | `OTel → instrumentation-knex@0.44.1` | S/W/D/C no | Fixed with the scoped `0.65.0` override. |
| [GHSA-qqmp-wf37-98f9](https://github.com/advisories/GHSA-qqmp-wf37-98f9) — DB username in spans | Moderate | `OTel → instrumentation-mongoose@0.46.1` | S/W/D/C no | Deferred. The fixed `0.67.0` requires Core 2.9+. |
| [GHSA-qqmp-wf37-98f9](https://github.com/advisories/GHSA-qqmp-wf37-98f9) — DB username in spans | Moderate | `OTel → instrumentation-mysql@0.45.1` | S/W/D/C no | Fixed with the scoped `0.67.0` override. |
| [GHSA-qqmp-wf37-98f9](https://github.com/advisories/GHSA-qqmp-wf37-98f9) — DB username in spans | Moderate | `OTel → instrumentation-mysql2@0.45.2` | S/W/D/C no | Deferred. The fixed `0.67.0` uses SQL Common 0.42, which requires Core 2. |
| [GHSA-qqmp-wf37-98f9](https://github.com/advisories/GHSA-qqmp-wf37-98f9) — DB username in spans | Moderate | `OTel → instrumentation-pg@0.51.1` | S/W/D/C no | Deferred. The fixed `0.73.0` requires Core 2.9+ and SQL Common 0.42. |
| [GHSA-qqmp-wf37-98f9](https://github.com/advisories/GHSA-qqmp-wf37-98f9) — DB username in spans | Moderate | `OTel → instrumentation-tedious@0.18.1` | S/W/D/C no | Fixed with the scoped `0.40.0` override. |
| [GHSA-c475-qrg2-pj4r](https://github.com/advisories/GHSA-c475-qrg2-pj4r) — FTP listing CPU exhaustion | High | `FTP → basic-ftp@5.3.1` | S/W/D/C no | Deferred. First fix in `6.2.1`. |
| [GHSA-5pm8-86m8-9m6r](https://github.com/advisories/GHSA-5pm8-86m8-9m6r) — FTP listing crash | Moderate | `FTP → basic-ftp@5.3.1` | S/W/D/C no | Deferred. First fix in `6.2.4`. |
| [GHSA-r4jh-29pc-gfqr](https://github.com/advisories/GHSA-r4jh-29pc-gfqr) — FTP password/download path crash | Moderate | `FTP → basic-ftp@5.3.1` | S/W/D/C no | Deferred. First fix in `6.2.3`. |
| [GHSA-jmr9-qjv8-65gv](https://github.com/advisories/GHSA-jmr9-qjv8-65gv) — ZIP symlink traversal | High | `ZIP → extract-zip@2.0.1` | S/W/D/C no | Deferred. The upstream package has no patched version. |
| [GHSA-7pqw-9j4j-h8q3](https://github.com/advisories/GHSA-7pqw-9j4j-h8q3) — ZIP symlink file overwrite | High | `ZIP → extract-zip@2.0.1` | S/W/D/C no | Deferred. The upstream package has no patched version. |
| [GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249) — glob matching DoS | Moderate | `LH → @sentry/node → minimatch@9.0.9`<br>`Builder → minimatch@10.2.6`<br>`Builder → @electron/universal@2.0.3 → minimatch@9.0.9` | S/W/D/C no | Deferred. First fix in `11.0.1`. Electron Builder 26.18.1 keeps the vulnerable ranges. |

### Dependency paths and production reachability

Path prefixes in the table describe the baseline lockfile. Reachability was assessed by inspecting production entry points, manifests and the resolved dependency chains.

- `LH` = root dev dependency `lighthouse@12.8.2`.
- `OTel` = `LH → @sentry/node@9.47.2`, followed by the named `@opentelemetry/*` package.
- `ZIP` = `LH → puppeteer-core@24.43.1 → @puppeteer/browsers@2.13.2`.
- `FTP` = `ZIP → proxy-agent → pac-proxy-agent → get-uri@6.0.5`.
- `Builder` = `apps/desktop → electron-builder@26.18.0 → app-builder-lib@26.18.0`. The app-builder packages also have circular peer paths via `dmg-builder` and `electron-builder-squirrel-windows`.

- **Server (`S`)** — [`apps/server/src/index.ts`](../apps/server/src/index.ts) starts the Fastify application. Its imports and workspace dependency paths do not reach Lighthouse or Electron Builder. The documented Linux deployment installs dev dependencies for the `tsx` launcher, so the affected packages can still be present on disk. [Server install instructions](../scripts/cloud-linux/README.md)
- **Vercel web app (`W`)** — The Next.js app and its catch-all API proxy do not load Lighthouse or Electron Builder. The proxy forwards to the server over HTTP. [API proxy](../apps/web/app/api/%5B...path%5D/route.ts)
- **Desktop shell (`D`)** — The Electron main process uses Electron and Node APIs and can start the repository's server/web stack as a separate process. The installer stages the shell's compiled code and assets. Electron Builder runs during packaging. The Electron binary ships with the shell even though Electron is declared as a dev dependency. The audit did not flag Electron itself. [Shell entry point](../apps/desktop/src/main.ts) · [Installer script](../apps/desktop/scripts/build-installer.mjs)
- **Chrome extension (`C`)** — The Manifest V3 service worker and popup use extension-local code. The workspace declares no npm dependencies. [Extension manifest](../packages/chrome-extension/manifest.json) · [Workspace manifest](../packages/chrome-extension/package.json)

### Overrides and deferred migrations

- The three exact overrides apply only below Sentry 9.47.2. They bring isolated OTel 0.x instrumentation libraries and leave the shared OTel Core, Resources and SDK on 1.x. The fixed releases emit stable database attributes. Sentry 9 uses legacy `db.system` and `db.statement` for span classification and has a `db.system` check in the Tedious integration. That would affect database trace metadata if those integrations handled live DB spans. The repository uses Lighthouse's programmatic API for [site measurements](../scripts/sites-baseline.ts), which bypasses the CLI's Sentry initialization. A Node smoke check imported Lighthouse and initialized the three Sentry integrations without a DSN or database connection. [OTel attribute change](https://github.com/open-telemetry/opentelemetry-js-contrib/pull/3585)
- **OpenTelemetry Core 2 and Sentry.** Forcing Core alone breaks calls to `getEnv` and `getEnvWithoutDefaults` from the 1.x SDK/Resources. Forcing the whole SDK to 2.x would also break Sentry 9's `new Resource(...)` call. Upgrade the integrated Lighthouse/Sentry stack when adopting the newer OTel generation. [OpenTelemetry 2 migration guide](https://github.com/open-telemetry/opentelemetry-js/blob/v2.0.0/doc/upgrade-to-2.x.md)
- **Lighthouse 13 and Puppeteer 25.** Puppeteer 25 uses an ESM-only API and makes `executablePath` and `defaultArgs` asynchronous. Its newer Browsers 3 dependency eliminates the vulnerable ZIP and FTP branches. Lighthouse 13.6 uses Puppeteer 25 and Sentry 11. Lighthouse 13 changes or removes audits and changes scoring, so the saved data from `scripts/sites-baseline.ts` needs a new baseline before comparisons. The third-party `@keep-lts/extract-zip` fork lacked verifiable public source provenance. Electron's internal extractor supports the same call shape, but its security policy excludes unverified archives and its platform matrix excludes Windows IA32. Both are relevant to Puppeteer's downloader. [Puppeteer release](https://github.com/puppeteer/puppeteer/releases/tag/puppeteer-v25.0.0) · [Lighthouse release](https://github.com/GoogleChrome/lighthouse/releases/tag/v13.0.0) · [Electron extractor security policy](https://github.com/electron/extract-zip/blob/v1.0.8/SECURITY.md)
- **Basic FTP 6.** `get-uri` 6 requires FTP 5 and constructs a default FTP client. FTP 6 rejects different control and data hosts by default, which changes compatibility with split-host FTP servers. The combined minimum fix is FTP 6.2.4. [Basic FTP 6 changelog](https://github.com/patrickjuchli/basic-ftp/blob/v6.0.0/CHANGELOG.md)
- **Minimatch 11.** v11 changes the type of parsed `Minimatch#set` entries and partial globstar and Windows path matching. Electron Builder reads `set` and uses partial matching to select installer contents. Forcing v11 across the packaging tree can change which files are included. A supported Builder upgrade or installer validation is needed for the migration. [Minimatch changelog](https://github.com/isaacs/minimatch/blob/v11.0.0/changelog.md)

The lockfile comparison found 22 changed entries, all flagged `dev`. Next 16, React 19, Fastify 5, Better Auth 1, Kysely 0.29, Zod 4, Playwright 1 and Vitest 5 keep their exact baseline versions.

## Verification

Baseline commit `c2a0ff765071657cf200b5ee7d12fabaad738c0b` on `feat/skill-engine`. The commands ran from the root of each checkout with Node `v24.22.3` and npm `11.19.1`. The baseline and updated tests used the same Playwright Chromium build and emitted text and JSON reports for comparison. npm counts affected package entries and includes parents whose dependencies are flagged. The table lists the underlying advisories by affected package and path.

| Command | Before | After |
| --- | --- | --- |
| `npm audit --json` | 35 package entries (27 moderate, 8 high), exit 1 | 30 package entries (22 moderate, 8 high), exit 1 |
| `npm audit --omit=dev --json` | 0, exit 0 | 0, exit 0 |
| `npm ci` | Passed | Passed |
| `npm run typecheck` | Passed | Passed |
| `npm test` | 7,552 passed, 23 failed, 1 expected failure, 48 skipped (403 files), exit 1 | 7,553 passed, 22 failed, 1 expected failure, 48 skipped (403 files), exit 1 |

### Test failure comparison

Compared the JSON results by repository-relative file and full test name. Twenty cases failed in both full runs.

| Suite | Before failures | After failures | Observed failure |
| --- | --- | --- | --- |
| `tests/ads-goal-corpus.test.ts` and `tests/ads-goal-grammar.test.ts` | 16 | 16 | Missing `artifacts/ads-training/service-vocab.json`. |
| `tests/assistant-conversation-follow-up.test.ts` | 1 | 1 | The follow-up lookup omits the expected Nile keyword. |
| `packages/desktop/src/desktop.test.ts` | 1 | 1 | The scaffold reports `git: false` where the test expects `true`. |
| `tests/skills-benchmark-runner.test.ts` | 2 | 1 | The temporary-root cleanup assertion fails in both runs. The crash-worker cleanup case also fails on the baseline. |
| `tests/assistant-safety.test.ts` | 1 | 0 | A browser navigation to the loopback fixture fails on the baseline. |
| `tests/skills-recovery.test.ts` | 2 | 3 | The browser-to-file worker fails on both. The two runs hit the crash worker's checkpoint error in different cases. |

The after-only cases in the full runs were “never repeats a write after a confirmed checkpoint crash” and “survives a second crash during verification using the original receipt and no new execution attempt.” Both passed when rerun by name in each checkout. A separate rerun of the whole five-case file in each checkout matched at four passes and one failure, the shared browser-to-file worker failure. Two more concurrent reruns per checkout also passed both named cases. The after-only failures did not reproduce in the follow-up checks.
