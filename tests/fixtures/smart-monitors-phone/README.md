# iPhone smart monitor fixtures

`cards.json` was generated from `packages/contracts/src/monitors.ts` at `a453dc17a78f55c0cd3e5bf23f347843893bc3d2` on `feat/smart-monitors` (PR #98). The generator checks the checkout's commit and imports the schema using Node 24 and the server's pinned Zod 4.6.7. It serializes the results of `MonitorCardSchema.parse`, `MonitorListSchema.parse` and `MonitorApproveSchema.parse`. The cards cover all six server statuses, all five source kinds, and an expired card with no current value.

The `future` cases start with those validated cards and change their status, source, condition or fields. They also include a card with an unreadable spec. The generator checks that the pinned schema rejects each of these deliberately changed cases so they can exercise the iPhone app's fallback behavior.

Run from the iPhone repository root with `MONITOR_CONTRACT_CHECKOUT` pointing to the detached server checkout at the pinned commit. The dependency install stays outside both checkouts.

```sh
npm --cache /tmp/mohassan-npm-cache --prefix /tmp/mohassan-monitor-fixture-deps install --ignore-scripts --no-save zod@4.6.7
node apps/ios/Tools/generate-monitor-fixtures.mjs "$MONITOR_CONTRACT_CHECKOUT" /tmp/mohassan-monitor-fixture-deps > tests/fixtures/smart-monitors-phone/cards.json
```

Run the monitor checks with a Linux Swift compiler on `PATH`.

```sh
swiftc -swift-version 5 -module-cache-path /tmp/mohassan-swift-monitor-cache apps/ios/Wasla/MonitorModels.swift apps/ios/Tools/MonitorChecks.swift -o /tmp/mohassan-monitor-checks
/tmp/mohassan-monitor-checks tests/fixtures/smart-monitors-phone/cards.json
```
