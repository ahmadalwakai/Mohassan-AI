# إعادة هيكلة تطبيق الآيفون (iPhone restructure plan)

Written 2026-11-23 at the owner's request («التطبيق مختلف تمامًا عن تطبيق الويب، وهناك أمور كثيرة في الواجهة
يجب أن تكون في الخلفية»). Status: **proposal, nothing built; waits for the owner's decisions in section 6.**

**ملخص للمالك:** تطبيق الآيفون اليوم برنامج مستقل يتصل بكمبيوترك مباشرة، وفيه أربعة تبويبات وشاشة ربط تقنية،
ويدير بنفسه منطقًا كثيرًا. الويب محادثة واحدة يقرر فيها الدماغ كل شيء على الخادم. الاقتراح: يصبح الآيفون واجهة
للمحادثة نفسها على الخادم نفسه، بالحساب نفسه. يعرض ويرسل فقط، ويقرر الخادم وينفذ.

## 1. Where the app is (read from `feat/iphone-daily` at `e31bb76`, build 12)

| Fact | Value |
| --- | --- |
| Code | `apps/ios/Wasla`: 6 Swift files, 2,844 lines (Views 788, Mohassan 800, Models 632, WaslaStore 403, Security 204) |
| Path | phone → Wasla service on the owner's PC (`apps/wasla-service`, pairing over Tailscale, pinned certificate) → the local Mohassan server |
| Screens | four tabs: «موحسن» (chat), «التحكم» (functions and a desktop touchpad), «الصور» (image prompt, style, English review, approve once), «البحث»; a pairing screen (address, certificate fingerprint, code); settings |
| Chat refresh | polls the conversation every 2 seconds while it works |
| Builds | Codemagic (`ios-verify` simulator build, `ios-release` signed IPA to internal TestFlight, group «Wasla Internal») |
| Android | `apps/android` mirrors the same companion design |

The web (`apps/web`) has one screen: the chat against `/api/chat/*` (17 routes on the server), with long-poll
(`?since=&wait=`, measured 55 ms to show a change), server capabilities, question and field cards, approvals,
secure fields, the run view, the browser panel, documents, sites and campaign cards.

## 2. Logic in the phone that belongs on the server

| In the phone today | Why it should move | On the server |
| --- | --- | --- |
| Separate Search tab | The brain already searches inside the chat | exists (search engine, hands) |
| Separate Control tab: touchpad, clicks, scrolls, screen stream | A tool the brain should drive, as on the web | exists: `computer_view/click/type/key` through the Windows companion (`apps/windows`), off in production today |
| Separate Images tab: English prompt preparation, style, approve once | A tool, not a screen; the brain refuses image generation today (`request-context.ts`) | missing: decision D3 |
| Delivery state machine: request keys, «not confirmed», check, send again, drop, hand back, saved across launches (`Mohassan.swift` lines 161–345) | The server already deduplicates by `clientRequestId`; the phone can retry the same key by itself and show only «sending» | exists (deduplication); a pending-request field may be added |
| 2-second polling | Slower and heavier than the web | exists: long-poll with `version` |
| Status titles, field-answer summary text, the 4,000-character limit, availability checks, seven connection states | Text and rules duplicated per client drift apart | partly exists (`capabilities`); labels and limits to be served |
| Pairing: address, certificate fingerprint, 8-digit code | A technical setup the owner should not see | replaced by account sign-in (missing: decision D1) |

## 3. What stays on the phone

Showing messages, steps, the activity line, question and field cards, approvals and the secure card; the
composer; attaching a photo (`/api/chat/images`); copying and sharing; the session token in the Keychain;
notifications later.

## 4. Missing on the server

- **Phone sign-in.** Auth is better-auth with browser cookies (`apps/server/src/auth.ts`); there is no bearer or
  app-token path. The phone needs the same accounts and the same member rules (`MEMBER_ROUTES`).
- **Image generation** as a chat tool, only if the owner wants it (D3).
- **Windows control on the production server** (`WINDOWS_REMOTE_ENABLED`), only if the owner wants desktop
  control from anywhere (D2).

## 5. Phases (each ends with a check)

1. **Server: phone sign-in.** Token issued after the same sign-in, stored in the Keychain, revocable, HTTPS only.
   Check: sign-in, sign-out and revoke tests; member limits apply.
2. **iPhone: one chat client** on `/api/chat/*` with the shared contracts: list, open, send with
   `clientRequestId` and silent retry, long-poll, cards, approvals, cancel, photo upload, secure card, run status.
   The four tabs and the pairing screen go. Check: the same conversation opens on web and phone; Codemagic
   `ios-verify` passes; build on internal TestFlight.
3. **Moved tools** per decisions D2 and D3.
4. **Android** to the same design (repository rule: keep phone apps in sync).
5. **Live check** on the owner's iPhone before the old build is retired.

## 6. Decisions for the owner

- **D1 (main):** the phone talks to the cloud server like the web (recommended: same account and conversations,
  works anywhere, members can use it), or keeps the computer as the bridge (works only while the PC is on).
- **D2:** desktop control on the phone: through the brain on the server (needs Windows enabled on production),
  or dropped from the phone.
- **D3:** the Images tab: dropped now, or a server image tool later.

## 7. SWOT

- **Strengths:** the server and `packages/contracts` already serve the web; the iOS app is small (2,844 lines) and
  already renders Mohassan's cards; Codemagic builds work without a Mac here.
- **Weaknesses:** no phone sign-in; image generation absent from the brain; Windows control off in production;
  Android follows the old design.
- **Opportunities:** one product on web and phone; a fix on the server reaches both; members can use the phone
  (they cannot pair the owner's PC).
- **Threats:** the owner loses phone features before their server versions exist; a sign-in flaw exposes an
  account; Apple processing delays a build.
- **Recommendation:** D1 cloud-direct; keep build 12 installed until the new build passes phase 5.

## 8. Premortem

| Failure | Prevention (requirement) | Check (acceptance) |
| --- | --- | --- |
| A phone token leaks or cannot be revoked | Keychain only, HTTPS only, server-side revoke, short life with refresh | Tests for revoke and expiry; a revoked phone gets 401 |
| Phone and web drift apart again | The phone decodes the shared contracts and calls the same routes; no business text in Swift | The same conversation shows the same state on both |
| The owner loses desktop control or images | A written feature list with each item's new home, agreed before release | The owner signs off the list on the live check |

## 9. Owner decisions and what was built (2026-11-23, evening)

Owner: «بالخادم السحابي و اضف toggle button to remote control the windows app». D1 = the cloud server; D2 = desktop
control on the phone through a toggle; D3 not answered, so the Images tab is dropped and photos go into the chat
as attachments (the server reads their text).

- **Phone sign-in needs no new server route.** The phone signs in at `/api/auth/sign-in/email` through the web
  origin, keeps the better-auth session cookie in the Keychain and sends it unchanged, so member rules, sign-out
  and the Windows session binding all apply as on the web.
- **Server (this branch, uncommitted):** an optional `Idempotency-Key` on create, messages, respond and approve
  (`chat_request_keys`, migration `033_chat_request_keys`, 24 h), and `requestKeys: true` in the list so a client
  knows resends run once. Tests: `tests/chat-idempotency.test.ts` 8/8.
- **Fixtures:** `scripts/cloud-phone-fixtures.ts` records 52 real exchanges (sign-in, chat, cards, keys, Windows)
  into the iPhone branch's `tests/fixtures/cloud-phone`.
- **iPhone (worktree branch `feat/iphone-cloud`, from `e31bb76`):** one chat screen on `/api/chat/*` with keyed
  sends and silent same-key resends, long-poll, field/option/approval/secure cards, photo attachments, rating,
  browser screenshot; a Windows remote-control screen with the toggle (120 s control grant renewed while on; off
  swaps in a 30 s view grant; STOP; pairing code); the tabs, pairing, Tailscale and local-network exceptions are
  gone. Codemagic runs `apps/ios/Tools/CloudChecks.swift` on the fixtures before the build. Build number 13.
- **Not done:** no Swift compiler on this PC, so nothing compiled yet; the first compile is Codemagic `ios-verify`
  after the owner allows a push. The server change is not deployed, and production keeps
  `WINDOWS_REMOTE_ENABLED=false`, so the toggle shows «disabled on the server» until both are changed with the
  owner's OK. Android still talks to the PC gateway.
