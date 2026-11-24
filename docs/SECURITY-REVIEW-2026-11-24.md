# Mohassan server security review | 2026-11-24

Reviewed `ahmadalwakai/Mohassan-AI` at `c2a0ff765071657cf200b5ee7d12fabaad738c0b` on `feat/skill-engine`. Evidence line numbers refer to that baseline. The review used a local checkout, disposable databases, injected HTTP requests, and synthetic credentials. It made no requests to production and performed no scans or load tests.

## Findings fixed on this branch

### Medium | Member chat quota can be exceeded or erased

- **Evidence.** The gate checked usage before the handler inserted a run. It checked two route patterns, while browser restore and review each called the same run-start function. Deleting a conversation cascaded to its runs, which were the entire source of quota history. `apps/server/src/app.ts:221-234`, `apps/server/src/members.ts:34-38,54-55,102-106`, `apps/server/src/command-chat.ts:372,3983-3986,4059,4183-4199,4329-4343`.
- **Scenario.** An invited member can exceed the configured allowance by starting work across separate conversations at the same time, using a restoration path, or deleting conversations to reclaim usage. The extra runs consume shared server and browser resources.
- **Fix.** Reserve usage inside the transaction that starts any chat run, with a per-member database lock. A server-only key namespace in the existing 24-hour request store preserves usage after conversation deletion and backfills recent member runs. Blank conversations and retries of committed requests consume no new run. Regression coverage is in `tests/members-access.test.ts`.

### Medium | Shared anonymous sign-in throttling

- **Evidence.** The Vercel relay discarded client IP headers, and the API passed no IP to Better Auth. Fastify used the socket address with proxy trust disabled. Better Auth 1.7.17 falls back to a shared per-path bucket when it lacks a client IP. `README.md:147`, `apps/web/app/api/[...path]/route.ts:11-14`, `apps/server/src/app.ts:168,185-190,258-271`, `apps/server/src/auth.ts:69`, `apps/server/src/request-rate-limit.ts:3-16`, `scripts/cloud-linux/Caddyfile:2-4`, `node_modules/better-auth/dist/api/rate-limiter/index.mjs:235-248`.
- **Scenario.** One unauthenticated visitor's failed login attempts can temporarily block other visitors from signing in through the same ingress.
- **Fix.** The Vercel web relay forwards its platform-provided single client address. The API accepts that address after checking its internal service credential and uses it for anonymous limits and Better Auth's existing address input. Verified accounts retain per-account limits. Without the ingress signal, Fastify still uses the socket address and Better Auth uses its built-in fallback. Regression coverage is in `tests/request-rate-limit.test.ts` and `tests/web-api-proxy.test.ts`. [Vercel request headers](https://vercel.com/docs/headers/request-headers)

### Medium | The web relay buffered uploads before API admission

- **Evidence.** The relay read a full request into chunks, allocated a second buffer, and only then started its upstream request and timeout. An upload route allowed up to 14 MB at that point. The API's session and role gate runs upstream. `apps/web/app/api/[...path]/route.ts:16-32`, `apps/server/src/app.ts:222-234`.
- **Scenario.** Anonymous uploads can tie up web relay memory and request handlers even when the API would reject the caller without processing the upload.
- **Fix.** Stream request bodies with backpressure, preserve route-specific byte limits, and bound upload time. The upstream gate can reject the request while the upload is still in progress. Regression coverage is in `tests/web-api-proxy.test.ts`.

### Medium | Anonymous site previews loaded generated files before token validation

- **Evidence.** The public preview fetched the complete generated file snapshot before verifying the token for its revision. The route's limiter used the supplied token as its key, so unverified values acquired separate buckets. `apps/server/src/members.ts:24-25`, `apps/server/src/sites.ts:27,84-86,253-257,329-333`.
- **Scenario.** A visitor who knows a site ID can cause repeated database reads of a large generated snapshot while presenting invalid tokens. The response denies access, but the unnecessary data reads consume shared capacity.
- **Fix.** Verify the token using revision metadata first, then rate-limit authenticated preview keys and load files or images pinned to the authorized revision. The existing preview URL format remains valid. Regression coverage is in `tests/sites-api.test.ts`.

### Medium | A retry could repeat committed chat work

- **Evidence.** Chat committed its run before dispatch and response construction. The idempotency store wrote the cached reply afterwards and released the key on any error. `apps/server/src/command-chat.ts:4058-4076,4394-4422`.
- **Scenario.** When a phone loses a reply because a post-commit read or cache write fails, the same retry can create another conversation or start the same paid or side-effecting work twice.
- **Fix.** Persist the idempotency receipt with the mutation in the same transaction. A retry can recover the conversation response after a reply failure without replaying the mutation. Pre-commit failures still release the key. Regression coverage is in `tests/chat-idempotency.test.ts`.

### Medium | Owner conversation logs could contain credentials

- **Evidence.** Production defaults to retaining owner conversation text in the judge log. The log could contain the question, previous turn, reply, and derived excerpts carrying the same value. `apps/server/src/assistant/judge-shadow.ts:75-79,87-90,104-111`, `apps/server/src/command-chat.ts:1356-1357`.
- **Scenario.** The owner pastes browser network diagnostics that include a session cookie, a credential header, or a password. Someone with access to the stored judge log or its backups can recover that value from the full text or a derived excerpt.
- **Fix.** Check for recognizable credential material before clipping and omit all conversation text fields for the affected record. The judge still produces its decision and audit metadata. Regression coverage is in `tests/assistant-judge-shadow.test.ts`.

### Medium | Rejected database URLs could reach startup logs

- **Evidence.** Parsing the database connection string could throw a Node URL error carrying its rejected input. The top-level startup awaits it while the launcher inherits stderr, which the sample service sends to the journal. `packages/database/src/index.ts:78-82`, `apps/server/src/index.ts:3-5`, `scripts/start-server.mjs:58-60`, `scripts/cloud-linux/mohassan.service:25-26`.
- **Scenario.** A credential-bearing connection URL is entered incorrectly. The application fails to start and a reader of service logs can recover the connection credentials from the diagnostic.
- **Fix.** Replace the URL parser error with a fixed diagnostic that does not retain the rejected input. Regression coverage is in `tests/postgres-connection-recovery.test.ts`.

### Medium | An assistant run could inherit another session's Windows grant

- **Evidence.** Each chat route overwrote a process-wide entry for the owner. Assistant operations looked up that mutable entry when they reached the Windows tool. `apps/server/src/app.ts:476`, `packages/windows/src/index.ts:77,137-142,219-237`.
- **Scenario.** Two browsers are signed in as the same owner, and one holds a Windows grant. A normal chat request from that browser can change which grant a background run in the other browser resolves, exposing the approved window across sessions.
- **Fix.** Bind each assistant execution to the validated session that dispatched it. Independently dispatched chat work cannot change that binding. Regression coverage is in `tests/assistant-tools.test.ts` and `tests/windows-assistant-scope.test.ts`.

### Medium | Signing out could leave Windows consent usable

- **Evidence.** Windows hashed the entire Cookie header for pairing, grants, and revocation. The auth route used the header from the sign-out request, which can differ in order or unrelated cookie values while resolving to the same session. `apps/server/src/app.ts:258-269`, `packages/windows/src/index.ts:34,55-72,160-177,200-212`.
- **Scenario.** An owner signs out after cookie metadata has changed. A short-lived pairing code issued in that session or a queued action covered by its grant can survive the expected revocation.
- **Fix.** Use a versioned hash of the authenticated session ID and check that the session still exists before consuming pairing consent or delivering queued work. Old temporary bindings are refused and the user can request fresh consent. Persisted device pairing remains valid. Regression coverage is in `packages/windows/src/windows.test.ts` and `tests/assistant-tools.test.ts`.

## Low findings

| Finding | Baseline evidence | Scenario and proposed fix |
| --- | --- | --- |
| The web relay drops the preview's framing, sandbox, and referrer policies | `apps/web/app/api/[...path]/route.ts:33-45`, `apps/server/src/sites.ts:329-333` | A third party with a preview link can frame it on another site and mislead visitors into interacting with the preview. The app iframe applies sandboxing and the generator escapes member content. Forward the fixed preview policies for this route. |
| Chat image retention and quota do not match their stated windows | `apps/server/src/command-chat.ts:404,4106-4122,4133-4134,4161,4342` | A caller with continued owner-account access and an old image link can recover an expired draft or an attachment after deleting its conversation. Removing expired rows also lowers the count used for the nominal daily upload quota. Enforce expiry on read and attach, delete orphaned data, and count admissions independently of image retention. |
| Cached chat replies can survive conversation deletion | `apps/server/src/command-chat.ts:411,4342,4401,4412,4416` | An authenticated phone retry with an existing key can redisplay deleted chat content until the cache expires. Keep only a deletion receipt or erase the cached snapshot when deleting the conversation. |
| Local shadow logs can retain entered credentials | `apps/server/src/app.ts:364-370`, `apps/server/src/assistant/router.ts:125-140`, `apps/server/src/assistant/conversation-state-shadow.ts:95-99,151-163` | A developer who pastes credentials during a local session may expose them to readers of shared test artifacts. Apply credential-aware omission before writing local text and exclude sensitive records from replay. These shadow paths are gated outside production. |
| A Windows grant can inherit a recent frame for the same target | `packages/windows/src/index.ts:193-196,204-209,221-223` | A browser that receives a replacement grant can see a still-fresh frame captured under the preceding grant. Bind accepted frames to the grant that authorized capture and clear them at a consent transition. |

## Review coverage and limits

- The API requires the internal service header and a valid Origin for writes. The health endpoint and the two native companion endpoints are explicit exceptions, with endpoint-specific credentials for companion requests. Session and member admission use registered route patterns. The reviewed allowlists and auth operation filter did not yield a route around the owner/member gate. `apps/server/src/app.ts:200-234,258-275`, `apps/server/src/members.ts:17-59`.
- The relay supplies the internal header, carries the Cookie header, limits request headers to explicit names, and disables redirect following. It preserves separate upstream Set-Cookie fields. The current upstream cookie producer is the auth handler. `apps/web/app/api/[...path]/route.ts:9-14,31-45`, `apps/server/src/app.ts:263-275`.
- Chat image uploads have a request cap, a decoded-size cap, pixel limits, format and declared-MIME checks, and a normalized-size cap. Downloads are scoped to the uploader. The member allowlist excludes the image upload and download routes. `apps/server/src/command-chat.ts:4091-4122,4455-4458`, `apps/server/src/members.ts:31-52`.
- Windows companion endpoints rely on expiring pairing codes or device credentials and are off by default in production. STOP takes the device lock, rejects queued inputs, and clears the frame. A command already delivered to a companion can have an unknown result. `apps/server/src/config.ts:26`, `packages/windows/src/index.ts:87-103,160-198,214-215`, `apps/windows/Companion.cs:199-210`.
- Vercel ingress headers and upload buffering, production TLS and companion enablement, real PostgreSQL contention, native Windows behavior, and production log contents and access were outside runtime verification. Earlier logs may contain historical disclosures. The credential filter recognizes labeled and known formats and cannot identify arbitrary unlabeled secrets.

## Verification

```sh
MOHASSAN_ISOLATED_TEST=true npm test -- packages/windows/src/windows.test.ts tests/windows-assistant-scope.test.ts tests/assistant-computer-cancel-queue-audit.test.ts tests/assistant-computer-native-completion-audit.test.ts tests/assistant-native-queue-owner-access-audit.test.ts tests/assistant-tools.test.ts tests/members-access.test.ts tests/api-security.test.ts tests/request-rate-limit.test.ts tests/chat-idempotency.test.ts tests/assistant-image-messages.test.ts tests/web-api-proxy.test.ts tests/sites-api.test.ts tests/assistant-judge-shadow.test.ts tests/assistant-judge-production.test.ts tests/postgres-connection-recovery.test.ts
MOHASSAN_ISOLATED_TEST=true npm test -- tests/external-ai-cut.test.ts
npm run typecheck
git diff --cached --check
git diff --exit-code c2a0ff7 -- packages/execution-pipeline packages/execution-model apps/server/src/auth.ts
```

- The focused suite exited 0 with 146 tests passed across 16 files. One native Windows test was skipped on Linux.
- The external AI configuration suite exited 0 with both tests passed.
- The root and web type checks exited 0.
- The staged whitespace and protected-path checks exited 0 with no diagnostics.
