# مهام Codex (2026-11-24)

**للمالك:** أعطِ Codex كل مهمة في مهمة سحابية مستقلة، بهذه الجملة: «Read docs/CODEX-TASKS-2026-11-24.md and do Task 1 only».
وإن لم يكن هذا الملف مرفوعًا إلى GitHub، فانسخ له قسم «Rules for every task» مع قسم المهمة نفسها.
تدريب v5 يعمل على جهازك حتى نحو 22:00 UTC يوم 25 نوفمبر، فلا تشغّل Codex على الجهاز نفسه. وفي مجلد المشروع 85 ملفًا
عُدّلت ولم تُحفظ بعد، منها 6 في `apps/android`، وCodex السحابي لا يراها لأنه يبدأ من آخر نسخة على GitHub.

---

## Rules for every task

- Start from `origin/feat/skill-engine` (c2a0ff7 or later) unless the task says otherwise. Create one new branch per task with
  the name the task gives. Never commit to `feat/skill-engine` or `main`, never force-push, never merge. Push your branch and
  open a pull request into `feat/skill-engine`.
- Follow the root `AGENTS.md` (and `apps/web/AGENTS.md` for web code). Inspect the real code before changing it; do not invent
  APIs, packages, environment variables or database fields. Add a dependency only when unavoidable, and say why.
- The product uses no external AI API and no model service. Do not add calls to any AI API, hosted model or LLM SDK.
- Change only the paths your task names. Other agents work in the same repository.
- **Training safety.** A v5 training job runs on the owner's PC until about 2026-11-25 22:00 UTC, and on every restart it checks
  the SHA-256 of these files. Do not edit them in any branch you expect to merge before then (Task 3 is the one exception, on
  its own unmerged branch):
  `packages/execution-pipeline/scripts/train_v5_foundation.py`,
  `packages/execution-pipeline/execution_pipeline/{language_adaptation,pretrain,ads_finetune,chat_diagnostics}.py`,
  `packages/execution-model/execution_model/*.py`.
  Never touch `.data/gpu.lock`, `artifacts/execution-model-runs/` or `artifacts/chat-training/v5/`. If you run on the owner's PC
  instead of the cloud, run no full test suites, no Gradle builds and nothing on the GPU.
- Verify in proportion to the change: run the tests that cover it and report the exact commands and results. Never claim a check
  passed unless you ran it. Never print or commit secrets; use no real credentials in tests.
- Finish with a short TL;DR **in Arabic**: what changed and why, the files affected, the checks actually run and their results,
  and what is still unverified.

---

## Task 1: the Android app talks to the cloud server

**Branch:** `feat/android-cloud`. **Paths:** `apps/android/**`, plus the fixtures copied in below. Do not change the server.

**Why.** The Android app (`apps/android`, Kotlin 2.0.21, AGP 8.7.2, Gradle 8.10.2, min API 26, target 35) still reaches
Mohassan only through the owner's PC (the Wasla service, e.g. `https://192.168.1.10:47621`, with a pinned certificate and a
pairing code). The iPhone app already talks to the cloud server like the web does (TestFlight build 1.0 (13)). Bring Android to
the same behaviour.

**Reference implementation (read it first).** Branch `feat/iphone-cloud`, commit 5853c59:
`apps/ios/Wasla/{Models,Security,WaslaStore,Mohassan,Views}.swift`, `apps/ios/Tools/CloudChecks.swift`, and
`docs/IPHONE-RESTRUCTURE-PLAN-2026-11-23.md` section 9. Copy `tests/fixtures/cloud-phone/` (52 recorded exchanges and
`index.json`, which exist only on that branch) into your branch; `scripts/cloud-phone-fixtures.ts` recorded them. Request and
reply shapes are in `packages/contracts/src/command-chat.ts`.

**Behaviour to implement (same as the iPhone):**
- **Server:** `https://www.mohassansy.com`. The web proxies `/api/*` to the server.
- **Sign-in:** `POST /api/auth/sign-in/email` with `{email, password}`; read the session cookie from `Set-Cookie`
  (`__Secure-better-auth.session_token` or `better-auth.session_token`). Store only that cookie, encrypted (Android Keystore).
  Send it back unchanged as the `Cookie` header, because Windows grants are bound to a SHA-256 of the exact Cookie header.
  Sign out with `POST /api/auth/sign-out`. Do not follow redirects.
- **Every non-GET request** sends `Origin: https://www.mohassansy.com`. A 401 while a cookie is set means signed out: clear it
  and show sign-in.
- **Chat:**
  - `GET` and `POST /api/chat/conversations`.
  - `GET /api/chat/conversations/:id?since=<version>&wait=8000` is a long poll; the server caps `wait` at 8000 ms.
  - `POST /api/chat/conversations/:id/messages`, `/respond` and `/approve`, plus the conversation create, take an
    `Idempotency-Key`. When the list reply has `requestKeys: true`, resend a request whose reply was lost with the same key and
    the same body, as the iPhone's `PendingRequest` does (backoff 1/2/4/8 s, give up after 12 h).
  - `POST .../feedback`, `/secure` and `/cancel`; `DELETE /api/chat/conversations/:id`; `GET .../:id/screen` (JPEG).
  - Photos: `POST /api/chat/images` (body up to 7.5 MB) and `GET /api/chat/images/:imageId`.
- **Windows remote control:**
  - Routes: `GET /api/windows`, `POST /api/windows/pairing`, and `POST /api/windows/devices/:id/grants`, `GET .../frame`,
    `POST .../actions` and `POST .../stop` under `/api/windows/devices/:id`.
  - A switch labelled «التحكم عن بُعد بتطبيق Windows». On: a 120 s control grant, renewed while on (check every 15 s, renew
    when under 35 s are left). Off: a 30 s view grant replaces control. STOP calls `/stop`, after which the PC needs new local
    consent.
  - Fetch frames about every 0.9 s, and only while the remote screen is open.
- Remove the PC-gateway pairing from the user flow. Keep the package name, app name, Arabic UI and right-to-left layout.

**Tests:**
- Keep the existing JVM tests that still apply (`ModelsTest`, `PinnedTrustTest`). If the gateway code goes away, remove its tests
  and say which.
- Add JVM tests that parse every fixture, encode each request body, cover the same-key resend rule, cover a 401 leading to
  signed out, and cover the switch's grant timing.

**Build:** run `./gradlew testDebugUnitTest assembleDebug` where your environment has the Android SDK. If it has none, say so
plainly, and keep the logic in plain Kotlin covered by JVM tests.

**Done when:**
- `feat/android-cloud` is pushed and the tests pass, stating where they ran.
- `apps/android/README-AR.md` describes the new flow in Arabic.
- The PR lists what was not verified, for example a real sign-in against production, which needs the owner.

---

## Task 2: four known defects in live chat

**Branch:** `fix/live-defects`. **Paths:** `apps/server/**` and the tests under `tests/` that cover it.

For each defect, first add a test that fails, then fix the cause, then run the tests of the areas you touched. Make no model calls.

1. **English "Explain why …" requests are refused instead of answered.** Arabic why-questions were fixed in commit caad77a
   (a request-scope `FACT_QUESTION` and a reason-sentence rule); English did not get the same treatment. Start from that commit.
2. **"Search the web for X. Return Y."** requests are refused or searched badly. The query should be X, and the reply should
   follow the "Return Y" part.
3. **The population answer for Australia is wrong.** The population path was changed in commits 3362d06 and c31e7a1.
4. **`judge.jsonl` is still written after shutdown,** which causes `ENOTEMPTY` in the teardown of
   `tests/assistant-local-sequence-chat.test.ts`. Make the judge's log stop and flush on close, so teardown can remove the folder.

**Done when:** each defect has a regression test that failed before and passes after, and the related existing tests (for
example `tests/assistant-judge*.test.ts` and `tests/assistant-local-sequence-chat.test.ts`) still pass.

---

## Task 3: the GPU guard survives one slow counter query (for future runs)

**Branch:** `fix/gpu-guard-retry`. **Paths:** `packages/execution-pipeline/execution_pipeline/chat_diagnostics.py` and a new
test file under `packages/execution-pipeline/tests/`. **Do not merge this branch.** v5 checks this file's hash on every restart,
so the change may land only after v5 ends.

**Why.** `GpuJob._monitor` (about line 188) samples every 5 s. One exception from `GpuJob._sample` (about line 96) sets
`self.problem` and stops the whole run. On 2026-11-24 that happened three times (07:56, 13:46 and 15:20 UTC): a Volume Shadow
Copy snapshot, taken by Dell SupportAssist or by Windows' daily Point-In-Time Restore task, made the `Get-Counter` query run past
its 20 s timeout. Each time the run lost everything since its last checkpoint, up to 100M positions.

**Change:**
- A failed sample (for example `subprocess.TimeoutExpired`) is transient. Log it to `gpu-memory.jsonl` with a `sample_error`
  field and keep running.
- Set `self.problem` only after 3 consecutive failed samples, or after 90 s without a good sample, whichever comes first.
- A good sample resets the count.
- A real memory problem found in a good sample still stops at once. The speed guard is unchanged.

**Tests:** simulate failing samples. One or two failures do not stop the job; the third does; a good sample in between resets
the count; a memory stop is still immediate. Run only the new test file and the existing GpuJob tests
(`test_v5_finetune.py`, `test_stage5_finetune.py`, `test_sft_accumulation.py`).

---

## Task 4 (optional): English Google Ads requests lost by the skills router

**Branch:** `fix/skills-english-ads`. **Paths:** `packages/skills/src/**`, `scripts/skills-library/measure-reader.ts`,
`docs/SKILLS-LIBRARY-EXPANSION-2026-11-24.md`.

**Why.** Commit ae20ce6 (rarity weights, Arabic stems, English whole words, cut 2/0.35) lifted the right skill to first place
on the library's dev questions from 77 to 84 of 100, on the first frozen test from 128 to 144 of 154, and on the second from 41
to 48 of 66. It also had costs, all measured in the docs file above:
- **Real questions, library skills only:** 36 of the 107 real requests need a skill. For those 36, an acceptable skill in the
  top 3 fell from 28 to 10. The file's own explanation is that most of them are English Google Ads requests whose nearest library
  skill (ad copywriting) scores weakly, so the new cut drops it.
- **Real questions with the built-in skills (Google Ads among them):** acceptable in the top 3 fell from 32 to 27.
- **Messages that need no skill** and correctly get none fell from 21 to 16 of 40 on the dev questions, and from 55% to 42.5%
  on the real context path.

**Change:** find the cause and recover what the change lost without lowering the first-place scores above (84, 144, 48). Do not
edit the frozen sets.

**Done when:** the PR reports before and after numbers from the existing measurement script.

---

## Task 5: the whole test suite and type check, run in the cloud

**Branch:** `fix/test-suite-health`. **Paths:** whatever each real failure needs, except the files of Tasks 2 and 4, the
pinned training files, and `apps/android`.

**Run:**
- `npm ci`, then `npm run typecheck` (root `tsc` and the web workspace), then `npm test` (Vitest).
- The tests use `@electric-sql/pglite`, so no PostgreSQL server is needed.
- Optionally run `npx playwright install chromium` and then `npm run test:e2e` (the isolated fixture listens on port 3100).

**Known failures on a clean HEAD:**
- `tests/assistant-safety.test.ts`, «blocks JavaScript writes…», tied to loopback networking.
- `tests/google-ads-skill.test.ts`, the case «اكتب إعلان لخدمة النقل».
- `tests/assistant-local-sequence-chat.test.ts` (ENOTEMPTY). This one belongs to Task 2, so leave it.

**For every failure,** decide whether it is a real bug, a limit of the environment, or a stale test:
- Fix real bugs with the smallest change and a test.
- Never skip, weaken or delete a test to make it pass.
- For a limit of the environment, write down why.

**Done when:** the PR has a table of every failure (test, cause, action), and both type checks pass or each remaining error is
explained.

---

## Task 6: a security review of the public server

**Branch:** `security/review-2026-11-24`. **Paths:** the files below and their tests, plus a new
`docs/SECURITY-REVIEW-2026-11-24.md`.

Production runs this code at https://www.mohassansy.com. Review it locally only: no requests to the live site, no scanning, no
load tests.

**Scope:**
- **`apps/server/src/app.ts`:** the session gate, the Origin check, the `x-mohassan-internal` header, and the default-deny member
  routing (about lines 200–270).
- **`apps/server/src/members.ts`:** `MEMBER_ROUTES`, `PUBLIC_ROUTES` and the member quotas.
- **`apps/web/app/api/[...path]/route.ts`:** the web proxy, especially which headers and cookies it forwards both ways.
- **`packages/windows/src`:** pairing, grants bound to a hash of the Cookie header, frames, actions and STOP.
- **`apps/server/src/command-chat.ts`:** image upload size and type checks, the Idempotency-Key store, and the rate limits.
- **Logging:** secrets or session cookies that could reach logs.

**Output:**
- The report lists each finding with its severity, the evidence (file and line), a realistic attack, and the fix.
- Fix the confirmed High and Medium findings in the branch, each with a test.
- List the Low findings only.
- Change no auth-provider configuration and no production setting.

---

## Task 7: reasoning gaps in the model-free chat

**Branch:** `fix/chat-reasoning-gaps`. **Paths:** `apps/server/src/assistant/**` and the tests under `tests/`. The chat answers
without any model; keep it that way.

The owner's browser test on 2026-11-23 found five gaps. For each one, add a failing test first, then fix the cause:
1. **Comparison questions** (which of two things is bigger, older or more) are answered wrong.
2. **«متى ولد؟» after a question about Microsoft** resolves to the company's page instead of the person the conversation means
   (Bill Gates).
3. **Two-step calculations** do only the first step.
4. **Fahrenheit and Celsius conversions** are weak.
5. **"Why" and superlative questions** end in an honest no-answer. Answer them when the fetched source states the reason or the
   extreme, and keep the honest no-answer when it does not.

Do not edit frozen evaluation sets. Run the assistant tests you touched and report the results.

---

## Tasks 8–11 (standalone prompts, written 2026-11-24 for pasting into Codex)

- **Task 8, branch `ci/github-actions`:** add `.github/workflows/ci.yml` (none exists): Node 24 typecheck + Vitest, the web
  build, and the Android unit tests on pull requests; no secrets, no deploys, no skipped tests.
- **Task 9, branch `test/phone-contract-fixtures`:** validate the 52 recorded phone exchanges (from `feat/iphone-cloud`) against
  the zod contracts, so a server change that would break the phone apps fails a test.
- **Task 10, branch `test/migration-safety`:** run every database migration twice on a fresh PGlite, require idempotency and
  unique versions, and fail on destructive SQL outside an explicit allow-list.
- **Task 11, branch `chore/dependency-audit`:** `npm audit` with reachability, patch and minor fixes only, no new test failures,
  and a report in `docs/DEPENDENCY-AUDIT-2026-11-24.md`.

The full prompts are in the chat of session ca515fd6; each one repeats the rules at the top of this file.
