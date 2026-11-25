# Production hotfix for redirect headers · 25 November 2026

**ملخص بالعربية** — كان متصفح الوكيل في إصدار الإنتاج `f015a18` يزيل ترويسة ملفات تعريف الارتباط فقط عند التحويل اليدوي إلى نطاق آخر، ما قد يكشف ترويسات مصادقة أخرى. يمرّر الإصلاح ترويسات القراءة المسموح بها فقط بين النطاقات، ويحافظ على الترويسات كاملة داخل النطاق نفسه. يلزم إعادة نشر خادم API فقط. يمكن للمالك فحص الصحة محليًا دون بيانات اعتماد، والرجوع إلى `f015a18` عند الحاجة.

## Scope and fix

When a read-only page resource redirects, AgentBrowser can send the follow-up itself. On a change of origin, the production implementation dropped `Cookie` and forwarded other headers, including `Authorization` and custom credential headers. This affects production commit `f015a1813c700c7cfd2f599a8095dd531a2ed1e4` and builds containing that unpatched AgentBrowser implementation, which dates to `6a91f81`. [PR #97 finding](https://github.com/ahmadalwakai/Mohassan-AI/blob/security/wave-5-review/docs/SECURITY-REVIEW-WAVE-5-2026-11-25.md#high--browser-hands-carried-private-headers-into-redirected-requests)

The PR #97 allowlist keeps six passive headers on a change of origin, matching header names case-insensitively. They are `Accept`, `Accept-Encoding`, `Accept-Language`, `Origin`, `Range` and `User-Agent`. AgentBrowser and `SafeNetwork.text` use that list on each origin change. Same-origin hops keep the headers they received.

## Audit of other manual redirects at `f015a18`

| Code path | Can a credential header cross origins? | Evidence at the production commit |
| --- | --- | --- |
| Approved downloads | No | The cookie lookup is scoped to the current page origin. The redirect target must match the approved URL's origin before another dispatch. `packages/browser/src/agent-browser.ts:1281–1283,1294–1297` |
| BrowserEngine | No | The non-browser transport filters out Authorization and custom headers. The resource loop deletes lowercase Cookie on an origin change. A top-document redirect initiates a separate validated navigation with `page.goto`. `packages/browser/src/engine.ts:77–94,122–130` and `packages/browser/src/network.ts:62–73` |
| SafeNetwork text reader | Yes, for an options object carrying headers | The exported method passes the whole options object to `request` on every hop. TypeScript accepts an options variable with a supported field and extra `headers`, and the non-browser transport accepts Cookie. The public text options omit headers and current production callers supply none. The hotfix filters extra headers on an origin change. `packages/browser/src/network.ts:62–73,101–107` and `packages/browser/src/research.ts:25,49,117` |
| Local search index | No | Each dispatch supplies only the abort signal and byte limit. `packages/browser/src/search/local-index.ts:106–111` |
| Robots reader | No | Each dispatch supplies only the abort signal and byte limit. `packages/browser/src/search/robots.ts:62–66` |
| Google Ads landing-page reader | No | Each dispatch supplies only the abort signal and byte limit. The loop operates on the public landing page. `apps/server/src/google-ads.ts:12–20` |
| Studio live preview | No | The signed gateway request uses `redirect: 'error'`. The gateway returns the upstream redirect to Studio, which returns a validated relative `Location` to the client. `apps/server/src/studio-live.ts:32–35,54,117–128` and `apps/sandbox-gateway/control.mjs:28` |

## Verification

All tests ran in a network namespace with only loopback enabled, using locked Playwright Chromium 1248 (Chrome for Testing 156.0.8078.4). Production was a detached worktree at the exact commit. Only the two regression test files were copied there for the red run.

| Check | Production `f015a18` | Hotfix |
| --- | --- | --- |
| `npm run typecheck` | Exit 0 | Exit 0 |
| New mocked regressions | Exit 1, 2 failed at the cross-origin assertions | Exit 0, 2 passed |
| Full browser package | Exit 0, 206 passed across 12 files | Exit 0, 208 passed across 14 files on rerun |
| AgentBrowser and Hands server suites | Exit 1, 662 passed and 1 failed across 50 files | Exit 0, 663 passed across 50 files |
| Isolated `assistant-safety` rerun | Exit 0, 43 passed | Exit 1, 42 passed and the same 1 failed |
| Paired rerun of the intermittent case alone | Exit 0, 1 passed and 42 skipped by selection | Exit 0, 1 passed and 42 skipped by selection |

The mock runs reached and passed the same-origin assertions on both revisions. The browser comparison matched all 206 existing cases by name and outcome. The first full browser run at the final code revision exited 1 when the existing quiet-network test read its fixture before the late text arrived. It passed on the next full run.

The first server comparison differed only at `assistant-safety.test.ts` → “blocks JavaScript writes, background submissions and iframe form navigation”. Each revision hit the documented `AGENT_NAVIGATION_FAILED` opening the `127.0.0.1` fixture in a different run. The paired single-case rerun passed on both. Using that paired result for the one intermittent case, all 663 server outcomes matched by name and status. [Hands handover](https://github.com/ahmadalwakai/Mohassan-AI/blob/f015a1813c700c7cfd2f599a8095dd531a2ed1e4/docs/HANDOVER-2026-11-22-HTTP-FIRST-HANDS.md#L76-L81)

<details>
<summary>Exact verification commands</summary>

The local `/workspace/work/redirect-offline` wrapper ran this command for each test and typecheck, with the appropriate checkout as the working directory.

```sh
unshare --user --map-root-user --net bash -c 'ip link set lo up && exec "$@"' bash env PLAYWRIGHT_BROWSERS_PATH=/workspace/work/redirect-chromium npm_config_update_notifier=false "$@"
```

```sh
/workspace/work/redirect-offline npm run typecheck
/workspace/work/redirect-offline npm test -- \
  packages/browser/src/agent-browser-redirect-headers.test.ts \
  packages/browser/src/network-redirect-headers.test.ts
/workspace/work/redirect-offline npm test -- packages/browser --reporter=default --reporter=json \
  --outputFile=/workspace/work/redirect-logs/browser-production.json
/workspace/work/redirect-offline npm test -- packages/browser --reporter=default --reporter=json \
  --outputFile=/workspace/work/redirect-logs/browser-final-hotfix.json
```

The server command ran with `revision=production` and `revision=hotfix` in the respective checkouts.

```sh
/workspace/work/redirect-offline npm test -- \
  tests/browser- tests/assistant-browser- tests/assistant-hands \
  tests/agent-capture-evidence.test.ts tests/learning-acceptance.test.ts tests/assistant-capture-chat.test.ts \
  tests/assistant-flow.test.ts tests/assistant-recovery.test.ts tests/assistant-safety.test.ts \
  tests/assistant-open-read-chat.test.ts tests/assistant-private-browser-scope-audit.test.ts tests/assistant-live-test-repairs-chat.test.ts \
  tests/assistant-agent-cycle-chat.test.ts tests/assistant-public-projection-chat.test.ts tests/assistant-search-routing.test.ts \
  tests/assistant-web-sequence.test.ts tests/assistant-request-scope-nominal.test.ts tests/assistant-unsupported-request.test.ts \
  tests/assistant-activity.test.ts tests/assistant-conversation-follow-up.test.ts tests/assistant-date-questions.test.ts \
  tests/assistant-releases.test.ts tests/assistant-reply-directive.test.ts tests/assistant-two-sources.test.ts \
  --maxWorkers=2 --fileParallelism --reporter=default --reporter=json \
  --outputFile="/workspace/work/redirect-logs/focused-$revision.json"
/workspace/work/redirect-offline npm test -- tests/assistant-safety.test.ts --retry=2 \
  --reporter=default --reporter=json --outputFile="/workspace/work/redirect-logs/safety-retry-$revision.json"
/workspace/work/redirect-offline npm test -- tests/assistant-safety.test.ts \
  --testNamePattern='blocks JavaScript writes, background submissions and iframe form navigation' \
  --retry=2 --reporter=default --reporter=json --outputFile="/workspace/work/redirect-logs/safety-case-$revision.json"
```

The preceding broader server runs used `tests/browser- tests/assistant- tests/agent-capture-evidence.test.ts tests/learning-acceptance.test.ts` with the default worker configuration and the same two reporters. I stopped those runs with SIGINT (exit 130) once the focused comparison started.

</details>

PR #95's launcher cannot produce a development comparison for these revisions. It injects review and structured-memory adapters in both V1 and V2, plus clarification in V2. The pinned adapter imports three modules absent from `f015a18`. The V2 audit merge explicitly restores the measured product tree before starting. No benchmark or sealed set ran. [Launcher](https://github.com/ahmadalwakai/Mohassan-AI/blob/integration/wave-5-2026-11-25/scripts/dev-bench/runner.py#L279-L311) [Pinned adapter](https://github.com/ahmadalwakai/Mohassan-AI/blob/0dfff7c54d3658a02cf878ff11faac7f630a6c10/scripts/agent-capability-bench/by-branch.mjs#L126-L150)

`git ls-tree -r --name-only f015a1813c700c7cfd2f599a8095dd531a2ed1e4 -- apps/server/src/assistant/review apps/server/src/assistant/structured-memory-migration.ts apps/server/src/assistant/clarify` exited 0 with no matching paths.

## Owner deployment and rollback

Redeploy only the Ubuntu API service `mohassan.service`, which runs AgentBrowser. No Vercel action is required. The existing API uses the VM's PostgreSQL 18 and Caddy. [Production runbook](../scripts/cloud-linux/README.md#current-production-deployment-2026-11-08)

1. From the approved hotfix commit based on `f015a18`, run `node scripts/package-cloud.mjs` to generate the source snapshot and manifest.
2. Stop admitting new work. Let active work finish or cancel it, close previews and confirm the documented read-only work counts have drained. Stop `mohassan.service` and any standalone workers before replacing source. Verify their supervisors keep them stopped.
3. Transfer the snapshot's `source` to `/opt/mohassan/app`. Exclude local dependencies, `.data`, `.env` and browser profiles. Verify the transferred files against the manifest. Preserve the production environment, PostgreSQL and persistent browser state.
4. Run `sudo bash /opt/mohassan/app/scripts/cloud-linux/prepare.sh` with the service stopped. It installs the locked dependencies and Chromium and runs the isolated Chromium smoke check. Run `sudo systemctl start mohassan`, then inspect the service status and journal. [Deployment runbook](../scripts/cloud-linux/README.md#prerequisites)

Credential-free check for the owner on the API VM. Expect HTTP 200 and `{"status":"ok"}`. This checks API availability. The redirect behavior is covered by the offline regressions. [Existing public health check](../scripts/check-cloud.mjs#L45-L65)

```sh
curl -q --noproxy '*' --fail --silent --show-error --write-out '\nHTTP %{http_code}\n' http://127.0.0.1:4000/health
```

To roll back, drain and stop the API and any standalone workers, then redeploy the snapshot built from `f015a1813c700c7cfd2f599a8095dd531a2ed1e4` with the same procedure. Keep the database, environment and persistent profiles, then repeat the loopback health check. This restores the previous backend and reintroduces the redirect exposure. [Rollback runbook](../scripts/cloud-linux/README.md#cutover-and-verification)

## Merge notes

- `packages/browser/src/agent-browser.ts:7,840` imports `crossOriginReadHeaders` and calls it at the origin-change check in `forward` (2 additions, 1 deletion).
- `packages/browser/src/network.ts:6,104,108–109` imports the same helper and filters forwarded headers before dispatch in `text` (4 additions, 1 deletion).
