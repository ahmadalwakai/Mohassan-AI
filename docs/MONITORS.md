# Smart monitors

تلتقط المراقبة الذكية طلبات المتابعة بالعربية والإنجليزية وتقترح خطة تعرض المصدر والقيمة الحالية وشرط التنبيه. تبدأ الفحوص بعد موافقتك، وتتباعد عند استقرار المصدر. عند تحقق الشرط يصلك تنبيه واحد وتجد الدليل في المحادثة. إذا تكرر تعذّر الوصول إلى المصدر أو اختفى الجزء المراد متابعته، تتوقف المراقبة مؤقتًا وتخبرك بالسبب. يمكنك إدارة المراقبات من المحادثة أو من «المراقبات» في الإعدادات. تفعيل الميزة بيد صاحب الخدمة.

في الإصدار الثاني تقرأ المراقبات البيانات المنظّمة وموجزات النشر، وتطلب منك تحديد القيمة عند الالتباس. يمكنك جمع عدة شروط ومتابعة الاتجاهات وطلب ملخّص يومي. تتعلّم كل مراقبة توقيت تغيّر مصدرها، وتعرض التنبيهات القيمة قبل التغيّر وبعده. الإصدار الثاني اختياري ومطفأ افتراضيًا.

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

## Smart monitors v2

`MOHASSAN_MONITORS_V2=1` enables v2 when `MOHASSAN_MONITORS_ENABLED=1`. New v2 monitors have an explicit v2 specification. Existing v1 monitors keep their original check path. Turning v2 off takes those monitors out of the scheduler and the v1 UI. Their original expiry still applies.

### Extraction and confirmation

A public page is parsed with parse5. Schema.org JSON-LD and microdata supply Offer price, currency and availability, Event start date and status, and Product name. Visible-text extraction supplies a fallback. A user-selected visible anchor retains its identity when the page also contains structured data. Price summaries show the currency and whether a value is an old price, when the page supplies that evidence. Arabic and Persian digits and Arabic thousands and decimal separators are normalized before numeric comparisons. Hijri conversion uses the runtime's ICU Umm al-Qura calendar via `Intl.DateTimeFormat` and a search of its Gregorian days. Status mappings preserve distinctions between open, closed, out of stock and coming soon. [Schema.org Offer](https://schema.org/Offer) · [Schema.org Event](https://schema.org/Event) · [Schema.org Product](https://schema.org/Product) · [ECMA-402](https://tc39.es/ecma402/#datetimeformat-objects)

A saved anchor records the label, value type, unit, currency, old-price marker, surrounding text and location. A type, currency, unit or old-price mismatch receives zero. Otherwise the score starts at 0.35 for the matching value pattern, adds 0.25 for a matching label, up to 0.30 for word-set overlap, and 0.10 for an unchanged location and extraction method. An exact unique match or a score of at least 0.84 with a lead of at least 0.16 resumes automatically and records the relocation. A score of at least 0.55 with two or more candidates produces one question with two to four source-backed choices. A composite preview with several ambiguous sources asks one question at a time. Lower confidence, or a single weak candidate, pauses the monitor and records one health notice within the existing allowance. These weights require corroborating label and surrounding text before automatic relocation. [Page reader](../apps/server/src/monitors/page-v2.ts) · [Choice rules](CLARIFICATION-CHOICES.md)

New-item watches look for RSS and Atom autodiscovery links and a sitemap in HTML or robots.txt, falling back to `/sitemap.xml`. Discovery goes through the same HTTPS, robots, host reservation, redirect and conditional-request path as the watched page. It reads up to two child maps from an index. The XML tokenizer caps each document at 512 KiB, 24 levels, 12,000 tokens and 100 items. It accepts standard and numeric XML entities and rejects declarations and custom entities. The limits bound processing and stored validators per check. Feed captions take precedence for duplicate links and sitemap links are limited to descendants of the watched path. Minute-precision or finer publication timestamps can inform scheduling. [RSS](https://www.rssboard.org/rss-specification) · [Atom](https://www.rfc-editor.org/rfc/rfc4287) · [Sitemaps](https://www.sitemaps.org/protocol.html) · [XML](https://www.w3.org/TR/xml/)

### Conditions, evidence and conversation

Up to three sources can form an AND or OR. A sequence has exactly two sources and requires a later confirmed B after a confirmed A within the specified window. Each source has a freshness limit. The default is six hours plus one scheduler poll so a normal quiet check can confirm a sample before it ages out. Sources are checked in order and each scheduled source read uses one check. A conditional 304 can revalidate a prior read. A broad HTML edit requires three agreeing observations at least an hour apart to reduce alerts from rotating content. Anchored and structured reads can confirm sooner. Trends use either a previous confirmed value inside a time window, or consecutive directional readings. [Conditions and limits](../packages/contracts/src/monitors.ts) · [Evaluation](../apps/server/src/monitors/evaluation-v2.ts)

New-item watches can run once, alert on successive checks that find new items, or combine notices at the next UTC day boundary. Item identity is tracked even if the source changes order. Digests are durable and can be published without another source fetch. The existing budgets cap checks and notices across normal operation, digests and health pauses. A recurring monitor completes when its last allowed trigger or digest is committed. Trigger evidence shows before and after, signed absolute and percent change where defined, the observation time in UTC, an excerpt and a link. It uses the conversation's language. The notification outbox retains the existing APNs envelope and generic lock-screen default. [Evidence](../apps/server/src/monitors/delivery-v2.ts) · [Runtime](../apps/server/src/monitors/runtime.ts)

Examples include “What are you monitoring for me?”, «أوقف مراقبة الدولار», «غيّر الحد إلى 3.65» and «أرسل لي ملخصًا يوميًا بدل كل تنبيه». Changes require separate confirmation. An ambiguous name can prompt a choice before the confirmation card. Answer-based offers require a verified public source and agreement between the answer and its evidence on the pending state. Offers are capped at one per topic in each conversation and do not appear during refusals, small talk or clarification. The account's monitoring settings can turn them off. [Conversation controls](../apps/server/src/monitors/chat.ts)

### Predictive scheduling

Consider a change at time $t$ between checks at $a$ and $b$. Its detection delay is $b-t$. If $\lambda(t)$ is the expected change rate over time, the interval's expected sum of delays is $\int_a^b \lambda(t)(b-t)\,dt$. With the prefix integrals $M(t)=\int^t\lambda(s)\,ds$ and $S(t)=\int^t s\lambda(s)\,ds$, this is $b[M(b)-M(a)]-[S(b)-S(a)]$. With a uniform rate, the total is proportional to the sum of squared gaps. Even spacing minimizes that sum for a fixed number of checks and total time.

The scheduler uses the prefix integrals in a fixed-count dynamic program on a grid no wider than 15 minutes. It plans about one day ahead, executes the first slot, and replans after each observation. It uses the source's existing urgent floor and six-hour quiet cap. The final hour before an explicit deadline receives reserved checks. Failure and confirmation retries share the same allowance. An untimestamped change can use one normal-interval follow-up probe when the remaining budget covers the quiet slots. A novel broad-text edit can use an early confirmation slot from the same hard budget. Repeated values that reverted before confirmation use the normal schedule. Brief weather threshold conditions retain the responsive v1 cadence until there are enough publication timestamps to forecast them. Own background runs retain the v1 initial backoff until a state transition is observed. A new-item watch with at least three dated releases, a concentrated weekly phase and a quiet next day can use the six-hour gap. Those gates limit sparse-history predictions and preserve coverage for unexpected releases.

The rate estimate divides the observed changes, including distinct feed or sitemap timestamps, by elapsed observation time plus one prior day. This regularization limits early spending. Timestamped releases contribute directly to 15-minute UTC daily and weekly bins. An undated change contributes across the bracket between the last confirmed sample and its observation, capped at six hours. Each contribution puts half its weight in its bin and a quarter in each neighboring bin to tolerate small timing shifts. Separate days or weeks are required before using their respective patterns. At most 75% of the baseline density comes from periodic patterns, preserving coverage at other times. Nearby changes add a short burst term with a six-hour half-life. The state lives on the individual monitor row owned by its account. [Scheduler](../apps/server/src/monitors/schedule-v2.ts)

## Verification

### Measurement protocol

The simulator checks the pinned v1 checkout at `a453dc17a78f55c0cd3e5bf23f347843893bc3d2` against the candidate's production source adapters, evaluator and scheduler. It uses a virtual clock and in-process source fixtures. SHA-256 counter streams provide deterministic draws. The fixtures generate Poisson arrivals by inverse exponential sampling, jittered daily and weekly releases, and bursts with explicit spacings. They also generate rotating blocks, A/B changes, time stamps, threshold flaps, layout moves, price decoys, outage windows and redirects. The oracle records actual events independently of extraction and scheduling. [Generator](../scripts/monitor-simulation/fixtures.ts) · [Runner](../scripts/monitor-simulation/run.ts)

Each trial covers one monitor-week. Checks count logical scheduled source reads. A feed check can issue conditional reads for several resources. Precision counts matched alerts over all condition alerts. Recall counts detected ground-truth opportunities. False alarms and checks are divided by enrolled monitor-weeks, including trials that ended early. Latency uses the event time and alert observation time. The table shows raw latency over detected events. The paired comparison uses only events both arms detect. The restricted comparison assigns each miss its time to expiry, accounting for changes in the detected population. Relocation success means reading the right value after a known layout move. An explicit relocation record is counted separately. The one-shot aggregate contains the eight classes with the same notification semantics. The recurring feed is reported separately because v1 stops after its first trigger.

The first candidate was tuned on 32 seeds per source class. Its 64 held-out seeds per class were opened after freeze. A separate agent then worked on the scheduler in a fresh context using the code and the original tuning bank. The independent replication uses 128 fresh trials per class under the same generator, parameters, oracle and gates. Its 256-bit salt is generated after the second freeze and recorded with the results.

### Held-out results

The first snapshot `4415845` exited **1**. It improved both paired delay measures and overall recall, but run-source recall fell from 48/48 to 47/48 and one-shot checks increased from 12,463 to 12,641. Its per-class results are recorded below.

```bash
/workspace/scratch/monitor-bench-offline ./node_modules/.bin/tsx scripts/monitor-simulation/run.ts --baseline /workspace/scratch/monitor-baseline --bank held-out > /workspace/scratch/monitor-held-out.json
```

| Source | Matched opportunities | Precision | Recall | False alarms/week | Mean / p95 minutes | Checks/week | Relocation success |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| plain-page | 0 / 50 → 50 / 50 | 0.0% → 100.0% | 0.0% → 100.0% | 1.00 → 0.00 | — / — → 289.8 / 434.9 | 4.00 → 26.45 | — → — |
| structured-offer | 32 / 64 → 50 / 64 | 65.3% → 100.0% | 50.0% → 78.1% | 0.27 → 0.00 | 160.3 / 345.0 → 104.2 / 250.0 | 30.72 → 27.02 | 16/35 → 35/35 |
| arabic-page | 40 / 64 → 54 / 64 | 100.0% → 100.0% | 62.5% → 84.4% | 0.00 → 0.00 | 18.4 / 89.0 → 116.6 / 317.0 | 33.13 → 30.81 | 23/34 → 28/34 |
| weekly-feed | 47 / 48 → 47 / 48 | 100.0% → 100.0% | 97.9% → 97.9% | 0.00 → 0.00 | 176.0 / 331.0 → 63.3 / 168.0 | 20.13 → 17.84 | — → — |
| recurring-feed | 46 / 141 → 141 / 141 | 100.0% → 100.0% | 32.6% → 100.0% | 0.00 → 0.00 | 186.1 / 340.0 → 25.4 / 46.0 | 19.36 → 25.48 | — → — |
| currency | 48 / 52 → 52 / 52 | 100.0% → 100.0% | 92.3% → 100.0% | 0.00 → 0.00 | 198.9 / 348.0 → 130.8 / 281.0 | 29.88 → 25.64 | — → — |
| weather | 52 / 64 → 52 / 64 | 100.0% → 100.0% | 81.3% → 81.3% | 0.00 → 0.00 | 78.8 / 229.0 → 78.8 / 229.0 | 23.73 → 23.73 | — → — |
| search | 48 / 48 → 48 / 48 | 100.0% → 100.0% | 100.0% → 100.0% | 0.00 → 0.00 | 178.8 / 345.0 → 171.9 / 331.0 | 20.63 → 19.81 | — → — |
| run | 48 / 48 → 47 / 48 | 100.0% → 100.0% | 100.0% → 97.9% | 0.00 → 0.00 | 177.0 / 327.0 → 144.6 / 294.5 | 32.53 → 26.20 | — → — |
| Shared one-shot total | 315 / 438 → 400 / 438 | 79.5% → 100.0% | 71.9% → 91.3% | 0.16 → 0.00 | 142.4 / 333.0 → 137.3 / 331.0 | 24.34 → 24.69 | 39/69 → 63/69 |

For 271 events both arms detected, mean and p95 delay went from 161.65 / 336.00 to 115.04 / 292.00 minutes. Restricted mean and p95 went from 2,517.85 / 9,344.00 to 2,197.88 / 8,529.00 minutes. The candidate recorded 28 relocations.

The independent replication at `ae662ed` exited **0**. Each source class matched or improved recall, and the one-shot total used 273 fewer checks. The scheduler used 5,897 versus 6,156 checks in the tuning bank before the replication salt was generated.

```bash
/workspace/scratch/monitor-bench-offline ./node_modules/.bin/tsx scripts/monitor-simulation/run.ts --baseline /workspace/scratch/monitor-baseline --bank held-out --replication 4df4e5fd7666511ada67cbd164b43a29587fa95657ce4302e13a0f7c414a1173 > /workspace/scratch/monitor-held-out-replication.json
```

| Source | Matched opportunities | Precision | Recall | False alarms/week | Mean / p95 minutes | Checks/week | Relocation success |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| plain-page | 0 / 102 → 99 / 102 | 0.0% → 100.0% | 0.0% → 97.1% | 1.00 → 0.00 | — / — → 306.8 / 463.5 | 4.00 → 24.17 | — → — |
| structured-offer | 66 / 128 → 106 / 128 | 64.1% → 100.0% | 51.6% → 82.8% | 0.29 → 0.00 | 181.9 / 346.0 → 106.8 / 246.0 | 31.86 → 26.44 | 36/73 → 68/73 |
| arabic-page | 80 / 128 → 113 / 128 | 100.0% → 100.0% | 62.5% → 88.3% | 0.00 → 0.00 | 28.9 / 109.0 → 115.9 / 303.0 | 32.68 → 28.95 | 41/61 → 51/61 |
| weekly-feed | 97 / 98 → 98 / 98 | 100.0% → 100.0% | 99.0% → 100.0% | 0.00 → 0.00 | 158.1 / 335.0 → 72.6 / 211.0 | 22.41 → 19.26 | — → — |
| recurring-feed | 99 / 300 → 294 / 300 | 100.0% → 100.0% | 33.0% → 98.0% | 0.00 → 0.00 | 197.0 / 349.0 → 23.2 / 43.0 | 18.94 → 23.09 | — → — |
| currency | 107 / 109 → 109 / 109 | 100.0% → 100.0% | 98.2% → 100.0% | 0.00 → 0.00 | 189.1 / 351.0 → 143.4 / 292.0 | 29.24 → 25.13 | — → — |
| weather | 113 / 128 → 113 / 128 | 100.0% → 100.0% | 88.3% → 88.3% | 0.00 → 0.00 | 88.0 / 295.0 → 88.0 / 295.0 | 23.45 → 23.45 | — → — |
| search | 104 / 109 → 108 / 109 | 100.0% → 100.0% | 95.4% → 99.1% | 0.00 → 0.00 | 154.7 / 321.0 → 176.4 / 346.0 | 19.05 → 18.29 | — → — |
| run | 101 / 106 → 106 / 106 | 100.0% → 100.0% | 95.3% → 100.0% | 0.00 → 0.00 | 169.3 / 340.0 → 191.2 / 347.6 | 32.54 → 27.41 | — → — |
| Shared one-shot total | 668 / 908 → 852 / 908 | 80.2% → 100.0% | 73.6% → 93.8% | 0.16 → 0.00 | 139.3 / 330.0 → 148.8 / 352.5 | 24.40 → 24.14 | 77/134 → 119/134 |

For the 597 events both arms detected, mean and p95 fell from 152.51 / 332.00 to 132.71 / 320.73 minutes. Restricted mean and p95 fell from 2,465.89 / 9,013.00 to 2,009.96 / 8,203.00 minutes. Raw mean and p95 rose across each arm's own set of detected events, which included 184 more detections in v2. The candidate recorded 51 relocations. The recurring watch detected 195 additional publication events and used 4.15 more checks per monitor-week.

### Three-arm development benchmark

The coordinator ran the pinned baseline and the same release candidate with v2 off and on. All arms used PR #95’s arm C settings with v1 monitoring enabled, the same development inputs, two workers and a network-disabled container. The case comparison includes reply text and scored turn details. Timing-only receipt fields do not enter the equality check. [Development launcher](../scripts/dev-bench/README.md) · [PR #95 settings](INTEGRATION-WAVE-5-2026-11-25.md#three-arm-development-run)

| Development set | Cases | Baseline | Head, v2 off | Head, v2 on | Flag-off verdict / check / reply differences | Enabled subgroup regressions |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| V1 | 240 | 176 | 176 | 176 | 0 / 0 / 0 | 0 |
| V2 | 2,400 | 1,588 | 1,588 | 1,588 | 0 / 0 / 0 | 0 |

- V1 compared 14 area, 2 language and 28 area/language groups.
- V2 compared 8 area, 2 language and 12 area/language groups.

| Arm | Detection matches | Management matches | Proactive matches | Displayed offers | False offers |
| --- | ---: | ---: | ---: | ---: | ---: |
| Baseline | 0 | 0 | 0 | 0 | 0 |
| Head, v2 off | 0 | 0 | 0 | 0 | 0 |
| Head, v2 on | 0 | 0 | 0 | 0 | 0 |

No development case matched detection, management or proactive offering. The reviewed monitoring-request allowlist is empty for these development sets. The functional suites exercise positive monitoring and offer cases.

The timings are nearest-rank values in milliseconds. Each sampled turn sums its calls to the relevant check.

| Arm | Detection turns | Detection p50 / p95 ms | Proactive turns | Proactive p50 / p95 ms |
| --- | ---: | ---: | ---: | ---: |
| Baseline | 2,247 | 0.0304 / 0.2023 | 0 | — / — |
| Head, v2 off | 2,247 | 0.0300 / 0.1746 | 0 | — / — |
| Head, v2 on | 2,247 | 0.0224 / 0.1644 | 1,635 | 0.1071 / 0.2763 |

The launcher exited **0** and the release comparator exited **0**. No sealed set was used. The exploratory invocation on `4415845` was stopped after its baseline arm completed when that snapshot was superseded.

```bash
/workspace/scratch/monitor-dev-bench ae662ed9ad2872bc68154e8b8c1e5a75028763ec /workspace/scratch/monitor-dev-three-arms-release
/workspace/scratch/monitor-bench-offline python3 -B scripts/dev-bench/compare.py \
  --baseline /workspace/scratch/monitor-dev-three-arms-release/a/receipt.json \
  --flags-off /workspace/scratch/monitor-dev-three-arms-release/b/receipt.json \
  --flags-on /workspace/scratch/monitor-dev-three-arms-release/c/receipt.json \
  --monitor-requests /workspace/scratch/monitor-dev-bench-requests.json \
  --output /workspace/scratch/monitor-dev-three-arms-release/monitor-comparison.json
```

### Offline tests

Node `24.22.3` and Playwright Chromium build `1248` were used. Setup downloaded locked packages from the npm registry and the pinned browser from Playwright. The verification commands ran with Docker networking disabled and loopback available to the web and API fixtures.

```bash
npm run typecheck
npm run test -- tests/monitors-api.test.ts tests/monitors-detection.test.ts \
  tests/monitors-web.test.ts tests/smart-monitor-runtime.test.ts tests/smart-monitor-sources.test.ts \
  tests/smart-monitor-sources-v2.test.ts tests/smart-monitor-reasoning-v2.test.ts \
  tests/smart-monitor-schedule-v2.test.ts tests/smart-monitor-chat-v2.test.ts
env MOHASSAN_E2E_WEB_PORT=3114 MOHASSAN_E2E_SERVER_PORT=4114 npm_config_offline=true \
  npm run test:e2e -- tests/e2e/smart-monitors.spec.ts tests/e2e/smart-monitors-v2.spec.ts
```

On the release snapshot, `npm run typecheck` exited **0**, and the nine affected Vitest suites passed **162/162**, including the Arabic fixtures, DTD and external-entity rejection, budget isolation and the existing build 15 APNs envelope. Both Playwright scenarios passed in the same offline environment, including price choice before activation and confirmation of a conversational stop. The release browser rerun took 1.1 minutes using local fixtures.

## Enable the rollout

1. Deploy the server and web changes. On the managed Linux VM, set `MOHASSAN_MONITORS_ENABLED=1` in `/etc/mohassan/server.env` and run `sudo systemctl restart mohassan.service`. Apply the same setting to each API replica running monitor work.
2. Open a web conversation and ask to monitor a public fixture or source with a known value. Review the approval card, approve it and check that its next check appears. Open **المراقبات** in settings and exercise pause and resume.
3. Verify that a completed monitor opens the right conversation and shows the evidence. Use a browser subscribed to Web Push and a registered iPhone with APNs configured to check closed-app delivery in those environments. [Existing background delivery setup](BACKGROUND-RESULTS.md)
4. To turn the feature off, unset the flag or set it to `0` and restart the API. Detection, new approvals and smart checks stop. Stored monitors retain their original expiry. The existing two-hour monitor is available with its own rollout setting. [Wave 5 flags](INTEGRATION-WAVE-5-2026-11-25.md#flags)

Set `MOHASSAN_MONITORS_V2=1` alongside the original flag to try the v2 controls and new-monitor workflow. Set only the v2 flag to `0` to return to v1 chat behavior.

## Merge notes

### V2, stacked on PR #98

- `044_smart_monitors_v2` adds `v2_state` and `v2_digest_due_at` to `smart_monitors`. `045_smart_monitor_conversation_controls` adds the account preference, per-topic offer receipt and confirmation action tables. The existing startup hook applies both after `043`. [Migration ledger](MIGRATION-LEDGER-2026-11-25.md)
- `apps/server/src/command-chat.ts` projects the optional capability, accepts the management result status and calls the answer-offer check after the final verdict. This is the only v2 change in a server file that overlaps PR #97's areas.
- `packages/contracts/src/command-chat.ts` adds the optional v2 capability.
- `apps/web/components/assistant-app.tsx` mounts the conversation controls and passes the capability to monitor settings. `apps/web/components/smart-monitors.tsx` mounts candidate choices and offer settings. `apps/web/components/monitors-client.ts` shares the existing monitor endpoint and change events with the new controls.

### V1, in PR #98

- `043_smart_monitors` applies after `042_background_results`. It adds `smart_monitors`, per-account budget and shared host-slot tables, and the optional monitor link in the existing notification outbox. The additive migration can stay applied when the rollout is off. [Migration ledger](MIGRATION-LEDGER-2026-11-25.md)
- `apps/server/src/app.ts` handles monitor errors, applies the migration and registers the flag-gated routes and scheduler.
- `apps/server/src/command-chat.ts` initializes the monitor service, projects its optional conversation and capability fields, admits monitor turns and publishes proposals through fenced chat completion. The terminal error path can offer a monitor for a verified public blockage.
- `apps/server/src/members.ts` makes the monitor routes available to members and applies the member chat quota check to approval.
- `packages/contracts/src/command-chat.ts` adds optional monitor cards and the smart-monitor capability field.
- `packages/browser/src/network.ts` admits conditional read headers. `packages/browser/src/search/robots.ts` accepts an optional crawler product token for matching robots rules.
- `apps/web/components/assistant-app.tsx` mounts the conversation cards and account settings entry.
