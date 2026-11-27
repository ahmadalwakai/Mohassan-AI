# Migration ledger · 25 November 2026

## Agent reservations

`git ls-remote --heads origin refs/heads/integration/wave-1 refs/heads/integration/wave-2` returned agent wave 1 at `93066fbb0984643110404372d5e32d3da3f324d2`. The highest recorded number in that tree is `036`. Agent wave 1 owns `035_chat_conversation_review` and `036_structured_memory`. It upgrades the former standalone memory ID, `035_structured_memory`, when present. The branch lookup returned no agent wave 2 ref or reservation. Retrieved 25 November 2026. [Agent wave 1 tree](https://github.com/ahmadalwakai/Mohassan-AI/tree/93066fbb0984643110404372d5e32d3da3f324d2)

## Platform order

| Order | PR | Recorded ID | Accepted legacy ID |
| --- | --- | --- | --- |
| 1 | #20 | `037_notifications` | `035_notifications` |
| 2 | #65 | `038_reminders` | `036_reminders` |
| 3 | #66 | `039_conversation_shares` | `038_conversation_shares` |
| 4 | #69 | `040_member_data_rights` | `037_member_data_rights` |
| 5 | #89 | `041_long_run_checkpoints` | — |
| 6 | #92 | `042_background_results` | — |
| 7 | `feat/smart-monitors` | `043_smart_monitors` | — |
| 8 | #100 | `044_smart_monitors_v2` | — |
| 9 | #100 | `045_smart_monitor_conversation_controls` | — |
| 10 | #104 | `046_smart_monitor_visual_budget` | — |
| 11 | #102 | `047_monitor_alert_feedback` | `044_monitor_alert_feedback` |
| 12 | #105 | `048_smart_monitor_decisions` | `046_smart_monitor_decisions` |
| 13 | `fix/chat-data-hygiene` | `058_chat_run_indexes` | — |

Startup recognizes each full legacy ID and changes the existing ledger row to its recorded ID inside the migration transaction, preserving the original application timestamp. The notifications upgrade also widens the existing notification kind constraint for reminder delivery. Fresh databases run each migration once. The platform branch starts at `c2a0ff7` and leaves the agent migrations to the agent wave.

The branch IDs `044_smart_monitors_v2`, `045_smart_monitor_conversation_controls`, and `046_smart_monitor_visual_budget` remain the recorded IDs.

Wave 5 runs `041_long_run_checkpoints` through the `042_background_results` startup migrator, after the release candidate's `037`–`040`. The two migrations add durable-run indexes, extend the notification kind constraint and add background-outcome and APNs storage. The previously recorded ledger IDs stay in place. [Wave 5 report](INTEGRATION-WAVE-5-2026-11-25.md#migrations)

`042_background_results` follows `041_long_run_checkpoints`. It adds per-account iPhone registrations in `ios_push_devices`, per-device APNs delivery state, and background result metadata and preferences in the existing notification tables.

`043_smart_monitors` follows `042_background_results`. It adds `smart_monitors`, `smart_monitor_budgets`, `smart_monitor_hosts`, and a nullable `chat_notifications.monitor_id` for monitor outcomes carried by the existing delivery queues. The rollout flag controls monitor admission, routes, and scheduling.

`044_smart_monitors_v2` follows `043_smart_monitors`. It adds nullable per-monitor state and a digest due time to `smart_monitors`.

`045_smart_monitor_conversation_controls` follows `044_smart_monitors_v2` and creates `smart_monitor_v2_preferences`, `smart_monitor_v2_offers`, and `smart_monitor_v2_actions`.

`046_smart_monitor_visual_budget` follows `045_smart_monitor_conversation_controls` and creates `smart_monitor_visual_budget` for daily render admission shared across accounts and workers.

`047_monitor_alert_feedback` adds one optional feedback record per account and monitor alert. Startup applies it with monitors off, and deletion of the account or alert cascades to its feedback.

`048_smart_monitor_decisions` adds the recording preference and proposal outcomes. The training export joins those outcomes with `047` alert feedback. The startup transaction applies `044` through `048` in order under the monitor schema lock.

`058_chat_run_indexes` indexes the five chat foreign keys that reference `chat_runs`, the conversation references in `chat_images` and `chat_observations`, and non-null image expiry times. The chat control startup pass applies it after `042_background_results` has added the `chat_notifications.run_id` foreign key. The ID may need renumbering at merge.

## Collisions

- Prefix `035` was claimed by notifications (#20), conversation review (#28, retained in #61), feedback (#30), standalone structured memory (#31, recognized as legacy in #61), and the activation console (#43).
- Prefix `036` was claimed by reminders (#65) and agent wave 1 structured memory (#61).
- Prefix `037` moves from member data rights to notifications. Prefix `038` moves from conversation shares to reminders. Each legacy check uses the entire ID to distinguish these entries.
- Prefix `044` was claimed by alert feedback and v2 state. Prefix `046` was claimed by the visual budget and decision recording. The full legacy IDs identify the feedback and decision entries independently of the recorded v2 and visual IDs.
- The base already uses prefixes `007`, `029`, and `033` for more than one distinct full ID in `schema_migrations`. The quota migration proposed by #9 uses `auth_schema_migrations`, a separate ledger. Platform integration makes no number assignments for the excluded feedback, activation, or quota migrations. [Base tree](https://github.com/ahmadalwakai/Mohassan-AI/tree/c2a0ff765071657cf200b5ee7d12fabaad738c0b)

## Open pull requests #1–#70

Retrieved 25 November 2026. The GitHub open-PR list provided the base of each PR. I fetched the corresponding `refs/pull/<number>/head` and inspected the added migration registrations and schema DDL with `git diff --unified=0 <merge-base> <head>`. Each stacked PR is compared with its own merge base, so inherited migrations appear only where the PR itself introduces them. A dash means the PR introduces no ledger ID. [Open pull request source](https://api.github.com/repos/ahmadalwakai/Mohassan-AI/pulls?state=open&sort=created&direction=asc&per_page=100)

| PR | Git head | Added migration IDs | Integration assignment |
| --- | --- | --- | --- |
| [#1](https://github.com/ahmadalwakai/Mohassan-AI/pull/1) | `7c81d5b4ea6c` | — | — |
| [#2](https://github.com/ahmadalwakai/Mohassan-AI/pull/2) | `8889496feb36` | — | — |
| [#3](https://github.com/ahmadalwakai/Mohassan-AI/pull/3) | `16558bba05bb` | — | — |
| [#4](https://github.com/ahmadalwakai/Mohassan-AI/pull/4) | `a3cef12d8e5e` | — | — |
| [#5](https://github.com/ahmadalwakai/Mohassan-AI/pull/5) | `ebae053c2c81` | — | — |
| [#6](https://github.com/ahmadalwakai/Mohassan-AI/pull/6) | `0cab2a978e32` | — | — |
| [#7](https://github.com/ahmadalwakai/Mohassan-AI/pull/7) | `c39375ee6ca1` | — | — |
| [#8](https://github.com/ahmadalwakai/Mohassan-AI/pull/8) | `80af7fc56be0` | — | — |
| [#9](https://github.com/ahmadalwakai/Mohassan-AI/pull/9) | `1bb51dd998c7` | `003_member_run_quota` (auth ledger) | Outside this wave |
| [#10](https://github.com/ahmadalwakai/Mohassan-AI/pull/10) | `46852de0a6f9` | — | — |
| [#11](https://github.com/ahmadalwakai/Mohassan-AI/pull/11) | `7ed9be832c92` | — | — |
| [#12](https://github.com/ahmadalwakai/Mohassan-AI/pull/12) | `7321c8680427` | — | — |
| [#13](https://github.com/ahmadalwakai/Mohassan-AI/pull/13) | `38c5f83b538e` | — | — |
| [#14](https://github.com/ahmadalwakai/Mohassan-AI/pull/14) | `c6aa84065e32` | — | — |
| [#15](https://github.com/ahmadalwakai/Mohassan-AI/pull/15) | `b43ee56c3d2a` | — | — |
| [#16](https://github.com/ahmadalwakai/Mohassan-AI/pull/16) | `2dd30cb94f36` | — | — |
| [#17](https://github.com/ahmadalwakai/Mohassan-AI/pull/17) | `cc577ba70d2a` | — | — |
| [#18](https://github.com/ahmadalwakai/Mohassan-AI/pull/18) | `0915bdc450fb` | — | — |
| [#19](https://github.com/ahmadalwakai/Mohassan-AI/pull/19) | `9eab15c0ba9c` | — | — |
| [#20](https://github.com/ahmadalwakai/Mohassan-AI/pull/20) | `ae8b33121f31` | `035_notifications` | `037_notifications` |
| [#21](https://github.com/ahmadalwakai/Mohassan-AI/pull/21) | `65e701499ddf` | — | — |
| [#22](https://github.com/ahmadalwakai/Mohassan-AI/pull/22) | `a258b3d47e39` | — | — |
| [#23](https://github.com/ahmadalwakai/Mohassan-AI/pull/23) | `72575f37799c` | — | — |
| [#24](https://github.com/ahmadalwakai/Mohassan-AI/pull/24) | `ccec5a67f543` | — | — |
| [#25](https://github.com/ahmadalwakai/Mohassan-AI/pull/25) | `e3cc45d16398` | — | — |
| [#26](https://github.com/ahmadalwakai/Mohassan-AI/pull/26) | `5ccc61789b9a` | — | — |
| [#27](https://github.com/ahmadalwakai/Mohassan-AI/pull/27) | `7eb3713c42a1` | — | — |
| [#28](https://github.com/ahmadalwakai/Mohassan-AI/pull/28) | `eb5166e0431d` | `035_chat_conversation_review` | `035_chat_conversation_review` in agent wave 1 |
| [#29](https://github.com/ahmadalwakai/Mohassan-AI/pull/29) | `5315f2525158` | — | — |
| [#30](https://github.com/ahmadalwakai/Mohassan-AI/pull/30) | `7a99ba76f58f` | `035_feedback_loop` | Outside this wave |
| [#31](https://github.com/ahmadalwakai/Mohassan-AI/pull/31) | `c365b368446e` | `035_structured_memory` | `036_structured_memory` in agent wave 1 |
| [#32](https://github.com/ahmadalwakai/Mohassan-AI/pull/32) | `e4e55b3cf4fb` | — | — |
| [#33](https://github.com/ahmadalwakai/Mohassan-AI/pull/33) | `21bd4de30b04` | — | — |
| [#34](https://github.com/ahmadalwakai/Mohassan-AI/pull/34) | `09e96baf3a9c` | — | — |
| [#35](https://github.com/ahmadalwakai/Mohassan-AI/pull/35) | `2d171b0dce3a` | — | — |
| [#36](https://github.com/ahmadalwakai/Mohassan-AI/pull/36) | `6cf96af677dc` | — | — |
| [#37](https://github.com/ahmadalwakai/Mohassan-AI/pull/37) | `15583669c7e7` | — | — |
| [#38](https://github.com/ahmadalwakai/Mohassan-AI/pull/38) | `9bdec96ef5f1` | — | The offline SQLite stores have no server migration ID |
| [#39](https://github.com/ahmadalwakai/Mohassan-AI/pull/39) | `d49ae714ebc2` | — | — |
| [#40](https://github.com/ahmadalwakai/Mohassan-AI/pull/40) | `f50520112a23` | — | — |
| [#41](https://github.com/ahmadalwakai/Mohassan-AI/pull/41) | `0dfff7c54d36` | — | — |
| [#42](https://github.com/ahmadalwakai/Mohassan-AI/pull/42) | `14ea9894949f` | — | — |
| [#43](https://github.com/ahmadalwakai/Mohassan-AI/pull/43) | `470d5593e4c8` | `035_activation_console` | Outside this wave |
| [#44](https://github.com/ahmadalwakai/Mohassan-AI/pull/44) | `763db24ae4e1` | — | — |
| [#45](https://github.com/ahmadalwakai/Mohassan-AI/pull/45) | `460a93f67a19` | — | — |
| [#46](https://github.com/ahmadalwakai/Mohassan-AI/pull/46) | `c65b7c738f02` | — | The SQLite entity index has no server migration ID |
| [#47](https://github.com/ahmadalwakai/Mohassan-AI/pull/47) | `0a7e6d644484` | — | — |
| [#48](https://github.com/ahmadalwakai/Mohassan-AI/pull/48) | `2ca532328cd5` | — | — |
| [#49](https://github.com/ahmadalwakai/Mohassan-AI/pull/49) | `70c0ba4588dc` | — | — |
| [#50](https://github.com/ahmadalwakai/Mohassan-AI/pull/50) | `27d09463d6d3` | — | — |
| [#51](https://github.com/ahmadalwakai/Mohassan-AI/pull/51) | `4f17a0cab6c9` | — | — |
| [#52](https://github.com/ahmadalwakai/Mohassan-AI/pull/52) | `e150f149223e` | — | — |
| [#53](https://github.com/ahmadalwakai/Mohassan-AI/pull/53) | `06f2a00cc96d` | — | — |
| [#54](https://github.com/ahmadalwakai/Mohassan-AI/pull/54) | `e245184feaf1` | — | — |
| [#55](https://github.com/ahmadalwakai/Mohassan-AI/pull/55) | `4a0a54fbe742` | — | — |
| [#56](https://github.com/ahmadalwakai/Mohassan-AI/pull/56) | `a130b239d9e6` | — | — |
| [#57](https://github.com/ahmadalwakai/Mohassan-AI/pull/57) | `d6aa9125b625` | — | — |
| [#58](https://github.com/ahmadalwakai/Mohassan-AI/pull/58) | `bdabd28b2f8f` | — | — |
| [#59](https://github.com/ahmadalwakai/Mohassan-AI/pull/59) | `3d1dff31267e` | — | — |
| [#60](https://github.com/ahmadalwakai/Mohassan-AI/pull/60) | `88865ba46c55` | — | — |
| [#61](https://github.com/ahmadalwakai/Mohassan-AI/pull/61) | `93066fbb0984` | `035_chat_conversation_review`, `036_structured_memory` | Agent wave 1 also recognizes `035_structured_memory` as a legacy ID |
| [#62](https://github.com/ahmadalwakai/Mohassan-AI/pull/62) | `12cedfe592aa` | — | — |
| [#63](https://github.com/ahmadalwakai/Mohassan-AI/pull/63) | `9fefcb1a7fa6` | — | — |
| [#64](https://github.com/ahmadalwakai/Mohassan-AI/pull/64) | `3a4ff3c35584` | — | — |
| [#65](https://github.com/ahmadalwakai/Mohassan-AI/pull/65) | `bccfe23ed5cf` | `036_reminders` | `038_reminders` |
| [#66](https://github.com/ahmadalwakai/Mohassan-AI/pull/66) | `4e6d5bacb60a` | `038_conversation_shares` | `039_conversation_shares` |
| [#67](https://github.com/ahmadalwakai/Mohassan-AI/pull/67) | `74e85830758e` | — | — |
| [#68](https://github.com/ahmadalwakai/Mohassan-AI/pull/68) | `81f3304e5840` | — | — |
| [#69](https://github.com/ahmadalwakai/Mohassan-AI/pull/69) | `eb0b47e566b5` | `037_member_data_rights` | `040_member_data_rights` |
| [#70](https://github.com/ahmadalwakai/Mohassan-AI/pull/70) | `a1e1cb020b7b` | — | — |
