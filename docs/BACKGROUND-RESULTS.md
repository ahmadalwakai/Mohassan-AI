# Background results

## ملخص بالعربية

يؤكد موحسن بدء المهمة الطويلة ثم يتابعها على الخادم حتى إذا أغلق المستخدم التطبيق أو انقطع الاتصال. تعرض بطاقة المحادثة المهمة والخطوة الحالية والوقت المنقضي وزر الإيقاف. تظهر النتيجة في المحادثة عند اكتمال العمل، ويصل إشعار عند الاكتمال أو الحاجة إلى الموافقة أو تسجيل الدخول أو تعذّر التنفيذ. يعرض الإشعار نصًا عامًا افتراضيًا لحماية الخصوصية. صوت الاكتمال في صفحة الويب مفعّل افتراضيًا ويعمل بعد التفاعل مع الصفحة. تُحترم ساعات الهدوء، ويمكن إعداد إشعارات آيفون عبر خدمة Apple APNs.

## From request to result

The response policy can choose long work, and the user can ask for it in Arabic or English. For a supported long run, Mohassan saves the request and immediately replies that it will work in the background and notify the user. The durable plans from PR #89 cover public-source research, timed monitoring of a public page, and draft websites from complete briefs. The normal chat path handles requests outside those plans. [Response policy and run limits](RESPONSE-POLICY.md)

The conversation card shows the task, current step, elapsed time, and a Stop button. One durable run can be active per account, including while waiting for approval or sign-in. The server keeps working after the client disconnects and resumes eligible work from its last checkpoint after a restart. Stop uses the existing cancellation route and fences late results. The existing wall-clock, step, and retry limits still apply.

The final result is saved as an assistant reply in the same conversation and follows the reply-length decision. Approval, sign-in and failure have their own notification copy. The final run state, reply, and notification record commit together. Each terminal record uses the run ID. Each checkpoint has a stable notification ID for each kind of pause. The worker can recover outstanding delivery after a restart and skip deliveries it already committed.

- With the web page open, an in-app banner links to the conversation. A short chime plays for completion when the setting is enabled and the browser has accepted a page interaction.
- With the page closed, a subscribed browser receives Web Push with a title, body and link to the conversation. Browsers do not support custom Web Push sounds. The operating system and browser decide whether to play their default sound. [Browser notification setup](NOTIFICATIONS-2026-11-25.md)
- iPhone delivery uses APNs and routes each registered token to its own sandbox or production endpoint. The client can open the conversation from the payload and bundle the `mohassan-done.caf` sound.

One outcome can appear on the web and on registered iPhones. The web uses either an open-page banner or closed-page Web Push. An unacknowledged tab claim can be recovered, and a Web Push retry uses the same browser subscription while it is valid. Browser receipts, a stable Web Push topic, and the APNs collapse ID reduce repeat alerts if a process exits after provider acceptance and before the delivery is recorded. An already displayed native alert can still repeat after an ambiguous provider acceptance.

The checked-in web audio file is `apps/web/public/mohassan-done.wav`. Regenerate it from the repository root with `node scripts/generate-completion-chime.mjs`.

## Settings

| Setting | Default | Effect |
| --- | --- | --- |
| Completion sound | On | Controls the chime on the open web page. The browser must first accept a user gesture. |
| Show result preview | Off | Allows the first line of a successful result in the notification body. With previews off, completion uses generic text such as `اكتملت مهمتك`. Background notifications use generic titles. |
| Quiet hours | Off | Uses the account's existing start time, end time, and time zone when enabled. Background alerts wait until quiet hours end. |
| Browser push | Per browser | Enable notifications in browser settings and subscribe the browser under Mohassan's notification settings. |
| `MOHASSAN_LONG_RUN_ENABLED` | Off | Enables admission for the durable runner. |
| `MOHASSAN_BACKGROUND_RESULTS_ENABLED` | Off | Enables background result behavior for newly admitted durable runs. |

Turning off admission leaves admitted runs recoverable and their recorded outcomes deliverable.

## Enable iPhone push

1. In the Apple Developer account, open Certificates, Identifiers & Profiles and enable **Push Notifications** on the App ID for the iPhone app. The identifier must match the app bundle ID and the `apns-topic` used by the server.
2. Create an Apple Push Notification service key with access to the app and the environments you use. Download its `.p8` file and record the Key ID and your Developer Team ID. Store the private key outside Git. [Apple provider token setup](https://developer.apple.com/documentation/usernotifications/establishing-a-token-based-connection-to-apns)
3. On the Linux VM, install the key in a private location such as `/var/lib/mohassan/apns/AuthKey.p8`. The `mohassan` service user must be able to read it. For a key file owned by that user, use mode `0600` and restrict access to the parent directory.
4. Add `APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_KEY_PATH` (the absolute `.p8` path), and `APNS_BUNDLE_ID` to the service's `/etc/mohassan/server.env`. APNs delivery is disabled when any of the four is missing. Enable both durable-run flags on the server handling chat traffic. [VM environment example](../scripts/cloud-linux/server.env.example)
5. Allow outbound TLS over TCP 443 from the VM to `api.sandbox.push.apple.com` and `api.push.apple.com` for the environments you support. Restart `mohassan.service` after installing the key and updating the environment. Verify push with a registered build from each environment you intend to use.

The authenticated iPhone client registers its APNs token with `POST /api/push/devices` through the existing `/api` proxy. Send the signed-in session cookie and configured web origin in the `Origin` header for both mutations. The body supplies `platform: "ios"`, the hex `token`, `environment: "sandbox"` or `"production"`, and `appVersion`. Unregister with `DELETE /api/push/devices/:token` before signing out or switching accounts. Both endpoints return `204` on success. A token already registered to another account returns `409`. The server removes invalid tokens reported by APNs. The payload has this shape.

```json
{
  "aps": {
    "alert": { "title": "Task completed", "body": "Your task is complete." },
    "sound": "mohassan-done.caf",
    "thread-id": "<conversationId>"
  },
  "conversationId": "<conversationId>",
  "runId": "<runId>",
  "kind": "run-completed"
}
```

`kind` can also be `run-blocked` or `run-failed`. The iPhone client uses `conversationId` to navigate and refreshes the conversation when it opens the alert.

## Android follow-up

Android continues to read the existing chat responses with optional background metadata. A future Android change needs to render the run card, link it to the existing stop route, refresh the conversation on return, and add a native notification channel, permission flow and deep link. Closed-app delivery will also need its own device registration and server transport. The iPhone endpoint accepts `platform: "ios"`.

## Merge notes

| Held file | Hook | Added / removed |
| --- | --- | --- |
| `apps/server/src/app.ts` | Install migration `042` after member data rights and before chat starts. | 2 / 0 |
| `apps/server/src/command-chat.ts` | Read the latest run's worker and task, and project the active background card. | 3 / 1 |
| `packages/contracts/src/command-chat.ts` | Add optional `backgroundRun` to the conversation response. | 2 / 0 |
| `apps/web/components/assistant-app.tsx` | Show the background card and use its Stop action in place of duplicate controls. | 4 / 1 |
| `apps/web/components/notification-client.ts` | Claim background outcomes through the existing web notification sync and skip them in the legacy native-notice loop. | 4 / 1 |
| `apps/web/components/notification-settings.tsx` | Add the sound and result preview controls. | 2 / 0 |

Migration `042_background_results` follows `041_long_run_checkpoints` and adds `ios_push_devices`, the APNs delivery ledger, and additive columns on the existing notification tables. [Migration ledger](MIGRATION-LEDGER-2026-11-25.md)
