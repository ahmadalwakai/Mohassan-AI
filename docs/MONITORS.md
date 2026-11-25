# Smart monitors

تلتقط المراقبة الذكية طلبات المتابعة بالعربية والإنجليزية وتقترح خطة تعرض المصدر والقيمة الحالية وشرط التنبيه. تبدأ الفحوص بعد موافقتك، وتتباعد عند استقرار المصدر. عند تحقق الشرط يصلك تنبيه واحد وتجد الدليل في المحادثة. إذا تكرر تعذّر الوصول إلى المصدر أو اختفى الجزء المراد متابعته، تتوقف المراقبة مؤقتًا وتخبرك بالسبب. يمكنك إدارة المراقبات من المحادثة أو من «المراقبات» في الإعدادات. تفعيل الميزة بيد صاحب الخدمة.

## From chat to notification

1. The detector evaluates Arabic and English requests with deterministic rules. An explicit request gets a proposal for approval. A user who says they are waiting for a public change, or repeats the same public status question in the conversation, gets an offer. A run that cannot finish because a verified public page is unavailable or its publication status is pending can offer to watch for availability or publication and to continue the task when the user asks. The detector uses recent user turns to resolve references such as “this page” and asks for details when the target or condition is ambiguous.
2. The server validates the source, reading method, condition, timing and language. It reads the source for a preview and shows the measured value or excerpt with the proposed condition and schedule. For example, the card can show USD/SAR at `3.75` and a trigger below `3.70`. The user chooses **Start monitoring** to schedule checks or **Not now** to dismiss the proposal.
3. The scheduler records each due check and updates the card with the last check, the current value and the next check. A match completes the monitor and records the observed evidence in the conversation. If the source repeatedly fails or the watched part vanishes, the monitor pauses, explains why and waits for the user to resume or stop it.
4. The monitor reads public information and sends a notification to the user. Purchases, bookings, messages to third parties and submissions remain the user's responsibility. A request for a follow-up action gets a notification-only offer.

The request detector and proposal generation live beside the chat integration. [Detector](../apps/server/src/monitors/detection.ts) · [Specification builder](../apps/server/src/monitors/spec.ts) · [Chat integration](../apps/server/src/monitors/chat.ts)

## Specification

A `MonitorSpec` combines the following fields. The contract checks that the source, reading method and condition are compatible. [Shared contracts](../packages/contracts/src/monitors.ts)

| Field | What it describes |
| --- | --- |
| Source | A public HTTPS page with an optional text anchor, a currency pair, a weather location and metric, a public search query, or a background run ID owned by the signed-in account. |
| Reading | Main content, a number near a label, a status phrase, a date, phrase presence, or a list of items. |
| Condition | Meaningful change, text equality or containment, phrase appearance or disappearance, a numeric threshold or crossing, percentage change, or a new item. |
| Timing | Urgency, initial interval, maximum lifetime, optional deadline, and check and notification allowances. |
| Presentation | A title, notification message and Arabic or English language. |

Currency observations use the existing dated ECB reference feed and official pegs for supported currencies. Weather uses current Open-Meteo temperature in Celsius, precipitation in millimetres or wind speed in km/h. Search uses public provider results. The run reader accesses the signed-in account’s own status through the database. [Source adapters](../apps/server/src/monitors/sources.ts)

## Checking and scheduling

**Select the relevant content.** For HTML, use the main region if present and strip page chrome, scripts, hidden elements, timestamp labels, counters and identified rotating elements. An anchor can select a heading and its following section or a nearby block. Numeric, status and date reads use the selected label or target. When the request asks for a specific phrase, the check tracks presence inside the selected region.

**Distinguish changes from noise.** Compare normalized text with regularized whitespace, Unicode and Arabic spellings and digits. A general text edit needs two consistent observations before firing. Values that rotate between samples stay provisional. An unchanged conditional response can confirm the last sample. Structured status phrases distinguish current states from wording such as “opens soon.” Search results use canonical URLs for identity and ignore common tracking parameters and result rank. Numeric crossings require a move to the appropriate side of the threshold. Hysteresis re-arms a comparison only after the reading moves past the threshold in the opposite direction by one unit of the requested decimal precision. A below-`3.70` crossing therefore re-arms at `3.71`. A percentage change uses the first nonzero reading as its reference.

**Adapt the interval.** Start at the interval for the source and urgency below. Double the interval after an unchanged check, up to six hours. A changed reading resets the interval, and the final hour before a supplied deadline uses the source's urgent interval. A duration or calendar deadline in chat can shorten the lifetime. Date-only deadlines use the end of that UTC date so all workers use the same cutoff. An explicit interval is bounded by the source's urgent interval and the six-hour quiet cap.

| Source | Normal | Urgent | Reason |
| --- | ---: | ---: | --- |
| Public page | 15 min | 5 min | General-purpose public page checks leave time for independent confirmations. The shorter interval serves time-sensitive openings while limiting traffic. |
| Currency | 60 min | 15 min | The feed provides daily reference rates. An hour gives several opportunities to see the next publication. The urgent floor matches the existing feed cache. |
| Weather | 30 min | 10 min | Weather changes more often than a daily rate. The urgent interval lets time-sensitive users follow current readings without polling every minute. |
| Public search | 60 min | 30 min | Public indexes usually refresh less often than pages. A wider interval also leaves capacity for shared search providers. |
| Own background run | 2 min | 1 min | The account-scoped read is local and run status can change on a minute scale. |

Every outbound source request follows `SafeNetwork`, including redirects. The monitor checks `robots.txt` and reserves a per-host slot across accounts and workers. A site-wide or agent-specific Crawl-delay can extend the host slot. A logical check can read both the policy and its target on the same host. ETags and Last-Modified validators apply to the corresponding URL, and a 304 reuses the previous reading. Public addresses that resolve to private or mixed addresses are rejected. [Extraction](../apps/server/src/monitors/page.ts) · [Evaluation](../apps/server/src/monitors/evaluation.ts) · [Network and sources](../apps/server/src/monitors/sources.ts) · [Schedule](../apps/server/src/monitors/schedule.ts)

## Limits and recovery

These are initial operating defaults and their design reasons.

| Limit | Default | Reason |
| --- | --- | --- |
| Feature rollout | Off | Let the owner activate the new workflow after deploying the schema and giving it a test conversation. |
| Proposal lifetime | 30 minutes or an earlier deadline | Keep the approved reading and due date recent. |
| Monitor lifetime | 7 days, capped at 30 days | A week covers weekday and weekend release cycles. A month limits abandoned polling. A supplied duration has a one-minute floor, with an earlier deadline still ending the monitor. |
| Shared host slot | At least 1 minute between logical checks. Apply a longer Crawl-delay up to 30 days. | Bound combined traffic and respect a slower publisher policy throughout any monitor lifetime. |
| Robots cache | 1 hour and up to 200 hosts | Reuse the existing crawler policy defaults to reduce policy requests and bound process memory. |
| Quiet backoff | ×2 up to 6 hours | Cut unchanged reads while retaining up to four checks a day once the source settles and the allowance remains. |
| Deadline window | Last hour | Concentrate checks near the time the user specified. |
| Check allowance | `ceil(lifetime / 6 hours) + 24`, giving 52 checks by default and 144 at the lifetime cap | Reserve one per quiet interval plus room for initial, changed and deadline checks. |
| Health pause | 3 consecutive failed reads, or a failed read that uses the remaining checks | Tolerate brief outages and surface persistent failures before ending checks. |
| Notifications | Up to 3 per monitor, with at most one successful trigger | Leave room for health alerts across manual resumes and for the final result. Resume requires enough budget for a future notice. |
| Scheduler and source timeout | 30-second poll, 30-second read timeout, 2-minute lease | Keep queue latency below the minimum source interval in an unloaded worker, bound stalled reads and leave time for the fenced result transaction. |
| Work per poll | Up to 10 claims and 10 deferred notices, with 4 concurrent reads per worker | Bound database activity and keep a slow source from blocking every other read. |
| Returned monitor list | 100 records, active and pending first | Keep chat and settings responses bounded while surfacing current work. |
| Source and extraction bounds | 3 page redirects, 2 MB of page content, 20,000 visited nodes, depth 80, 160 text blocks, 512 characters per block and 320 per evidence excerpt | Bound public network, parsing and storage costs while retaining a short excerpt the user can identify. Heading context includes up to four following blocks so adjacent sections stay outside the watch. |
| Search list and item identity | Up to 10 search results per check and 2,048 recorded item hashes | Bound provider traffic and durable state. Item comparisons use a stable identity so reordering does not produce an alert. |
| History | Up to 12 earlier messages after the current turn | Resolve nearby conversational references without sending the transcript to a public source or scanning an entire thread. |

Live slots count pending, active and paused monitors. The server applies per-account quotas and the routes also use the existing chat access controls. UTC daily quotas reset at midnight so instances agree on a single budget day.

| Account limit | Owner | Member | Reason |
| --- | ---: | ---: | --- |
| Live slots | 10 | 3 | Support parallel watches and limit how many unattended monitors each account can hold. |
| Preview reads per day | 40 | 12 | Allow an average of four previews per live slot for clarifications and alternate targets. |
| Scheduled checks per day | 240 | 96 | Bound sustained work at ten owner checks or four member checks per hour averaged across a day. |
| Notifications per day | 40 | 12 | Allow multiple health and completion outcomes across live slots while limiting aggregate delivery. |

An exhausted daily check allowance defers further reads until the next UTC budget day, subject to expiry. A notification waiting on the daily allowance stays in a durable receipt for later delivery. A worker commits a lease and consumes the check's due slot before reading. Competing workers skip occupied rows, and a stale lease cannot publish. If a worker stops in the middle of a check, the monitor recovers on a later slot. Pause preserves the expiry, and stop prevents further checks. [Storage](../apps/server/src/monitors/store.ts) · [Runtime](../apps/server/src/monitors/runtime.ts)

## Settings and delivery

Open **المراقبات** in the web account settings menu to see the account's active and paused monitors. Each card can open the original conversation or pause, resume or stop the monitor. Conversation cards show the source, reading and check times.

When a trigger or health pause is committed, the same database transaction records the conversation message and the existing background-results notification. The event ID deduplicates the logical notification. Delivery uses the existing browser, Web Push and APNs paths and their registration and preference settings. A trigger uses `run-completed` and a health pause uses `run-blocked`. iPhone build 15 opens the conversation using the existing `conversationId` and `runId` fields. For a monitor, `runId` carries that event's ID and `monitorId` is an optional extra. Lock-screen text is generic by default. A completed result can include its excerpt only when the account enables result previews. [Background notification settings and setup](BACKGROUND-RESULTS.md) · [Monitor delivery](../apps/server/src/monitors/delivery.ts)

| Authenticated route | Request and result |
| --- | --- |
| `GET /api/chat/monitors` | List the account’s monitors. Optional `conversationId` filters to a conversation. Returns `{ monitors }`. |
| `POST /api/chat/monitors` | Approve a conversation proposal with `{ proposalId }`. Returns the activated card. |
| `POST /api/chat/monitors/:id/pause` | Pause scheduled checks. Returns the updated card. |
| `POST /api/chat/monitors/:id/resume` | Resume a paused monitor within its original lifetime and budgets. Returns the updated card. |
| `POST /api/chat/monitors/:id/stop` | Stop a monitor or decline a proposal. Returns the updated card. |

The server accepts up to 12 calls per minute on each mutation route, matching the secure chat route limit for interactive actions. Each route requires a session and enforces account ownership. [Member permissions](../apps/server/src/members.ts) · [Routes](../apps/server/src/monitors/routes.ts)

## Enable the rollout

1. Deploy the server and web changes. On the managed Linux VM, set `MOHASSAN_MONITORS_ENABLED=1` in `/etc/mohassan/server.env` and run `sudo systemctl restart mohassan.service`. Apply the same setting to each API replica running monitor work.
2. Open a web conversation and ask to monitor a public fixture or source with a known value. Review the approval card, approve it and check that its next check appears. Open **المراقبات** in settings and exercise pause and resume.
3. Verify that a completed monitor opens the right conversation and shows the evidence. Use a browser subscribed to Web Push and a registered iPhone with APNs configured to check closed-app delivery in those environments. [Existing background delivery setup](BACKGROUND-RESULTS.md)
4. To turn the feature off, unset the flag or set it to `0` and restart the API. Detection, new approvals and smart checks stop. Stored monitors retain their original expiry. The existing two-hour monitor is available with its own rollout setting. [Wave 5 flags](INTEGRATION-WAVE-5-2026-11-25.md#flags)

## Merge notes

- `043_smart_monitors` applies after `042_background_results`. It adds `smart_monitors`, per-account budget and shared host-slot tables, and the optional monitor link in the existing notification outbox. The additive migration can stay applied when the rollout is off. [Migration ledger](MIGRATION-LEDGER-2026-11-25.md)
- `apps/server/src/app.ts` handles monitor errors, applies the migration and registers the flag-gated routes and scheduler.
- `apps/server/src/command-chat.ts` initializes the monitor service, projects its optional conversation and capability fields, admits monitor turns and publishes proposals through fenced chat completion. The terminal error path can offer a monitor for a verified public blockage.
- `apps/server/src/members.ts` makes the monitor routes available to members and applies the member chat quota check to approval.
- `packages/contracts/src/command-chat.ts` adds optional monitor cards and the smart-monitor capability field.
- `packages/browser/src/network.ts` admits conditional read headers. `packages/browser/src/search/robots.ts` accepts an optional crawler product token for matching robots rules.
- `apps/web/components/assistant-app.tsx` mounts the conversation cards and account settings entry.
