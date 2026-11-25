# Wave 5 security review | 25 November 2026

Production baseline `f015a1813c700c7cfd2f599a8095dd531a2ed1e4`. Release candidate under review `201321031293999003bb0ae55a29dbd250ac96ce` on `integration/wave-5-2026-11-25` (PR #95). The review covers the full difference between those commits, including integration waves 1–4, the platform wave, the release candidate and wave 5.

PR #9 was reviewed at `1bb51dd998c790db4894d17780585f054dd27384`. The earlier review branch remains outside the release. Relevant fixes are adapted against PR #95.

## Review status

The source review is in progress. Verification uses local fixtures, mocks and disposable state. No production service or deployment was accessed.

## HTTP route inventory

The location column refers to PR #95 (`201321031293999003bb0ae55a29dbd250ac96ce`). The inventory compares route registrations and Next.js route files against production (`f015a1813c700c7cfd2f599a8095dd531a2ed1e4`). It has 37 new Fastify method/path registrations. Fastify generates `HEAD` for the `GET` registrations below except member data export, which disables `HEAD` at registration. The member gate maps generated `HEAD` to `GET` with `routeKey`.

Fastify requires the internal proxy credential, then an eligible session for nonpublic routes. It checks the exact configured web origin before every write, with a loopback alias in development. The shared defaults are a 16,384-byte body limit, a request rate limit, and `Cache-Control: no-store`. See `apps/server/src/app.ts:184-252`, `apps/server/src/auth.ts:61-81`, and `apps/server/src/members.ts:21-67`. Member routes below are listed through the notification, reminder, share, and member-data route constants in `MEMBER_ROUTES`. Suspended members retain the listed personal data rights, and members with a pending deletion can read or cancel that account's deletion during the grace period. These paths still require authentication. Owner administration routes require the owner role.

| Method | Path | Registration | Session and authorization | Input and state |
| --- | --- | --- | --- | --- |
| POST | `/api/push/devices` | `apps/server/src/ios-push-routes.ts:12` | Member allow-listed. Registers under session account and rejects conflicting ownership. | Strict APNs registration with bounded token and app version. Origin required. |
| DELETE | `/api/push/devices/:token` | `apps/server/src/ios-push-routes.ts:22` | Member allow-listed. Deletes by session account and token. | Bounded hex token. Origin required. |
| GET, HEAD | `/api/notifications/settings` | `apps/server/src/notifications-routes.ts:57` | Member allow-listed. Reads own preferences and device summaries. | No input consumed. Read-only. |
| POST | `/api/notifications/settings` | `apps/server/src/notifications-routes.ts:58` | Member allow-listed. Updates own preferences and returns own summaries. | Strict quiet-hour, time zone and boolean preference schema. Origin required. |
| POST | `/api/notifications/subscribe` | `apps/server/src/notifications-routes.ts:63` | Member allow-listed. Registers under session account and rejects conflicting ownership. | Strict URL, keys and label with length limits. Delivery-time URL enforcement covered in the network section. Origin required. |
| DELETE | `/api/notifications/devices/:id` | `apps/server/src/notifications-routes.ts:75` | Member allow-listed. Deletes own device row by ID. | UUID. Origin required. |
| POST | `/api/notifications/sync` | `apps/server/src/notifications-routes.ts:78` | Member allow-listed. Syncs and reads by session account. | Strict UUID and tab-state enum. Origin required. |
| POST | `/api/notifications/events/:id/claim` | `apps/server/src/notifications-routes.ts:79` | Member allow-listed. Looks up event and tab under session account. | Event and tab UUIDs with an optional acknowledgement literal. Origin required. |
| GET, HEAD | `/api/notifications/events/:id` | `apps/server/src/notifications-routes.ts:84` | Member allow-listed. Checks own event and returns status only. | UUID. Read-only. |
| POST | `/api/notifications/test` | `apps/server/src/notifications-routes.ts:88` | Member allow-listed. Creates a generic test event for own devices. | Ignores body and query. Five requests per minute. Origin required. |
| GET, HEAD | `/api/reminders` | `apps/server/src/reminders/routes.ts:38` | Member allow-listed. Lists own scheduled reminders. | Empty query. Read-only. |
| GET, HEAD | `/api/reminders/due` | `apps/server/src/reminders/routes.ts:45` | Member allow-listed. Lists bounded deliveries under session account. | Empty query. Read-only. |
| POST | `/api/reminders` | `apps/server/src/reminders/routes.ts:52` | Member allow-listed. Verifies that the session account owns the conversation. | Strict reminder schema, future time, valid zone, and validated recurrence. Origin required. |
| PATCH | `/api/reminders/:id` | `apps/server/src/reminders/routes.ts:60` | Member allow-listed. Selects and updates own reminder. | UUID, empty query, strict changes and optional revision. Origin required. |
| DELETE | `/api/reminders/:id` | `apps/server/src/reminders/routes.ts:69` | Member allow-listed. Cancels own reminder. | UUID, empty query and body. Origin required. |
| GET, HEAD | `/api/chat/conversations/:id/export` | `apps/server/src/conversation-share.ts:64` | Member allow-listed. Loads own conversation snapshot. | UUID and strict PDF/Markdown format. 12 requests per minute. |
| POST | `/api/chat/conversations/:id/share/preview` | `apps/server/src/conversation-share.ts:75` | Member allow-listed, subject to owner sharing setting. Reviews own snapshot. | UUID and empty body. 20 requests per minute. Origin required. |
| POST | `/api/chat/conversations/:id/share` | `apps/server/src/conversation-share.ts:83` | Member allow-listed, subject to owner sharing setting. Creates link for own snapshot. | UUID, strict expiry and receipt, receipt bound to owner and snapshot. 12 requests per minute. Origin required. |
| GET, HEAD | `/api/chat/conversation-shares` | `apps/server/src/conversation-share.ts:97` | Member allow-listed. Lists own links. | No input consumed. Read-only. |
| DELETE | `/api/chat/conversation-shares/:id` | `apps/server/src/conversation-share.ts:98` | Member allow-listed. Revokes own link. | UUID. Origin required. |
| GET, HEAD | `/api/chat/conversation-shares/public/:token` | `apps/server/src/conversation-share.ts:103` | Public capability, internal proxy credential still required. Browser API relay blocks this path. | 22-character token, expiration and revocation checked on lookup. Read-only. |
| GET, HEAD | `/api/chat/conversation-share-settings` | `apps/server/src/conversation-share.ts:120` | Owner session. | No input consumed. Read-only. |
| POST | `/api/chat/conversation-share-settings` | `apps/server/src/conversation-share.ts:124` | Owner session. | Strict boolean. Origin required. |
| GET | `/api/member-data/export` | `apps/server/src/member-data-routes.ts:31` | Member allow-listed. Export assembled from session account. | Empty query, per-account hourly limit, 64 MiB archive cap. See legacy Fetch Metadata finding. |
| GET, HEAD | `/api/member-data/sessions` | `apps/server/src/member-data-routes.ts:55` | Member allow-listed. Lists own current and other sessions with masked IPs. | Empty query. Read-only. |
| DELETE | `/api/member-data/sessions` | `apps/server/src/member-data-routes.ts:60` | Member allow-listed. Revokes own other sessions. | Empty query and body. Origin required. |
| GET, HEAD | `/api/members/audit` | `apps/server/src/member-data-routes.ts:66` | Owner session. | Strict bounded pagination. Read-only. |
| DELETE | `/api/members/:userId/sessions` | `apps/server/src/member-data-routes.ts:70` | Owner session. Explicit member administration. Protects the owner account. | Bounded account ID, empty query and body. Origin required. |
| GET, HEAD | `/api/member-data/deletion` | `apps/server/src/member-deletion.ts:154` | Member allow-listed. Reads own deletion state. | Empty query. Read-only. |
| POST | `/api/member-data/deletion` | `apps/server/src/member-deletion.ts:158` | Member allow-listed. Starts own deletion and protects the owner account. | Empty query, strict password confirmation against the current session, five requests per minute. Origin required. |
| DELETE | `/api/member-data/deletion` | `apps/server/src/member-deletion.ts:178` | Member allow-listed. Cancels own pending deletion. | Empty query and body. Origin required. |
| GET, HEAD | `/api/members/deletions` | `apps/server/src/member-deletion.ts:185` | Owner session. Explicit member administration. | Empty query. Read-only. |
| DELETE | `/api/members/deletions/:userId` | `apps/server/src/member-deletion.ts:194` | Owner session. Explicit member administration of pending deletions. | Bounded account ID, empty query and body. Origin required. |
| GET, HEAD | `/api/ops/backup-status` | `apps/server/src/backup-status.ts:41` | Owner session. Workspace backup status. | Reads configured directory and fixed filenames. Output is limited to validated timestamps, verdict and computed age. |
| GET, HEAD | `/api/ops/metrics` | `apps/server/src/ops/metrics/index.ts:59` | Owner session. Workspace metrics. | No input consumed. Read-only. |
| GET, HEAD | `/api/ops/metrics.csv` | `apps/server/src/ops/metrics/index.ts:60` | Owner session. Workspace metrics. | No input consumed. Read-only. |
| GET, HEAD | `/api/training-monitor` | `apps/server/src/training-monitor/route.ts:59` | Owner session. Production binding denies the local reader unless the desktop-shell and loopback requirements apply. | No input consumed. Reads configured local artifacts. |

The web catch-all already served `GET`, `POST` and `DELETE` in production. New application-level Next.js paths and the PATCH handler are listed below. Framework-generated `HEAD` follows `GET` and automatic `OPTIONS` advertises handler methods without forwarding a data request.

| Method | Path | Registration | Authorization and input |
| --- | --- | --- | --- |
| PATCH | `/api/reminders/:id` | `apps/web/app/api/[...path]/route.ts:68` | Two path segments with `reminders` first, bounded proxy body. Fastify checks the session, allow-list, ownership, UUID and Origin. |
| GET, HEAD | `/share/:token` | `apps/web/app/share/[token]/route.ts:83` | Public capability with a fixed-length token. Forwards only the proxy credential to the internal lookup, renders validated data and applies no-store, no-referrer, noindex and CSP. |
| GET, HEAD | `/ops/metrics` | `apps/web/app/ops/metrics/page.tsx:5` | The page renders sign-in or forbidden UI if the fixed internal metrics route rejects the session. Metrics are fetched with no-store and owner authorization. |
| GET, HEAD | `/training-monitor` | `apps/web/app/training-monitor/page.tsx:6` | Public page shell. Snapshot fetch at `apps/web/app/training-monitor/monitor.tsx:227` requires an owner session. |
| GET, HEAD | `/notifications-sw.js` | `apps/web/public/notifications-sw.js:1` | Public static service-worker script. Before displaying a notification, the worker checks event ownership through the authenticated API. |
| GET, HEAD | `/mohassan-done.wav` | `apps/web/public/mohassan-done.wav` | Public static completion sound. |

Durable run creation, status and stop reuse the existing chat routes. See `apps/server/src/command-chat.ts:4555`, `:4561`, `:4568`, and `:4573` for the session-scoped handlers. Those method/path pairs also exist in production.

## HTTP findings

### Medium | Session credentials in browser-readable auth JSON

- **Location** `apps/server/src/member-data-bootstrap.ts:39-61`, `apps/server/src/member-data-request.ts:28-34`, and `scripts/cloud-phone-fixtures.ts:73-86` at PR #95.
- **Scenario** Better Auth places credential fields in successful sign-in and session JSON. The HTTP hooks forwarded those fields into application-readable data. The phone fixture recorder sanitizes `Set-Cookie` headers and saves the JSON body, so recording these responses also saved the underlying credentials from those sessions.
- **Evidence** `node --no-warnings /workspace/scratch/wave5-auth-response-check.mjs /workspace/wave5-http-review base` exited 1 with two credential fields present in the mocked Better Auth responses. The same command ending `head` exited 0 with zero credential fields and preserved account metadata, IP prefixing, invalid-credential response and signed-out null body. The focused integration regression is `tests/member-data-routes.test.ts` under “delivers the session through HttpOnly cookies and omits credentials from auth JSON”.
- **Fix** `apps/server/src/auth-http-response.ts` strips the top-level sign-in token and nested session token, preserving the HTTP-only cookie flow and existing masked IP metadata. The current web and phone fixture consumers use the cookie and account identity. The API specification reflects the response shape.

### Low | Legacy browser metadata fallback can consume an export slot

- **Location** `apps/web/app/api/[...path]/route.ts:8-13`, `apps/server/src/member-data-export.ts:190-197`, and `apps/server/src/member-data-routes.ts:44-49` at PR #95.
- **Scenario** An export GET allocates a one-hour per-account slot and records completed downloads. A legacy top-level navigation without Fetch Metadata can reach the authenticated handler under Lax cookie semantics, potentially starting an unwanted download or consuming that account's slot. Export selection remains scoped to the authenticated account. The browser's same-origin policy protects the response body from cross-origin script reads.
- **Evidence** `node --no-warnings /workspace/scratch/wave5-export-policy-check.mjs /workspace/wave5-http-review` exited 0. The test dispatched five combinations of Fetch Metadata to the actual Next.js handler against a stub authentication gate. The handler rejected cross-site and same-site metadata and forwarded same-origin, none and absent values to that gate.
- **Owner decision** Preserve current compatibility with API clients that omit browser metadata, or require a same-origin request signal or an Origin-checked POST for export admission.

## Outbound connections

## Findings

## PR #9 applicability

## Owner decisions

## Merge notes

## Verification

- `git rev-parse HEAD origin/integration/wave-5-2026-11-25` returned `201321031293999003bb0ae55a29dbd250ac96ce` for both refs before review changes.
- `git cat-file -t f015a1813c700c7cfd2f599a8095dd531a2ed1e4` returned `commit`.
- `gh pr view 95 --repo ahmadalwakai/Mohassan-AI --json headRefOid,headRefName,baseRefName,isDraft` confirmed the requested commit and integration branch as the draft PR head.
- `git fetch --no-tags origin refs/heads/security/review-2026-11-24:refs/remotes/origin/security/review-2026-11-24` completed. The review read `docs/SECURITY-REVIEW-2026-11-24.md` from that ref.
- `npm ci --offline --ignore-scripts --no-audit --no-fund` exited 1 with `ENOTCACHED` for a locked package. The verification environment needs the lockfile cache and the pinned Playwright Chromium build.
