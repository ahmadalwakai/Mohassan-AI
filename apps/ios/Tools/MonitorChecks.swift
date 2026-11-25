import Foundation

@main
enum MonitorChecks {
    private struct Failure: Error, CustomStringConvertible { let description: String }

    private struct Fixtures: Decodable {
        struct Approval: Decodable { let proposalId: String }
        struct Future: Decodable {
            let unknownStatus: MonitorCard
            let unknownSource: MonitorCard
            let unknownCondition: MonitorCard
            let unknownFields: MonitorCard
        }
        let contractCommit: String
        let list: MonitorList
        let approval: Approval
        let future: Future
    }

    static func main() throws {
        guard CommandLine.arguments.count == 2 else { throw Failure(description: "usage: monitor-checks <cards.json>") }
        let data = try Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1]))
        let decoder = JSONDecoder()
        let fixtures = try decoder.decode(Fixtures.self, from: data)
        let cards = fixtures.list.monitors
        var checks = 0
        func check(_ condition: Bool, _ description: String) throws {
            guard condition else { throw Failure(description: "FAILED: " + description) }
            checks += 1
        }
        func card(_ status: MonitorStatus) throws -> MonitorCard {
            guard let card = cards.first(where: { $0.status == status }) else { throw Failure(description: "Missing \(status) card") }
            return card
        }

        try check(fixtures.contractCommit == "a453dc17a78f55c0cd3e5bf23f347843893bc3d2", "fixtures name the pinned server commit")
        try check(cards.map(\.status) == [.proposed, .paused, .expired, .active, .completed, .stopped], "all six server statuses decode in server order")
        try check(cards.allSatisfy { UUID(uuidString: $0.id) != nil && UUID(uuidString: $0.conversationId) != nil }, "cards contain monitor and conversation IDs")

        let proposed = try card(.proposed)
        try check(proposed.spec.source.kind == .currency && proposed.spec.source.base == "USD" && proposed.spec.source.quote == "SAR", "currency pair decodes")
        try check(proposed.spec.read.kind == .number && proposed.spec.condition.kind == .crossing && proposed.spec.condition.direction == .below, "numeric reading and condition decode")
        try check(proposed.spec.condition.value == .number(3.70) && proposed.spec.condition.hysteresis == 0.01, "condition value and hysteresis decode")
        try check(proposed.spec.timing.initialIntervalMs == 3_600_000 && proposed.spec.timing.lifetimeMs == 604_800_000, "timing uses milliseconds")
        try check(proposed.spec.language == .ar && proposed.offer == .explicit, "language and offer decode")
        try check(proposed.current?.value == .number(3.75) && proposed.current?.excerpt == "3.75 SAR", "numeric observation and excerpt decode")
        try check(proposed.current?.observedAt == proposed.lastCheckedAt && proposed.nextCheckAt == nil, "proposal exposes the preview time without a scheduled check")

        let active = try card(.active)
        try check(active.spec.source.kind == .page && active.spec.source.anchor == "التسجيل", "page and anchor decode")
        try check(active.spec.read.label == "حالة التسجيل" && active.current?.value == .text("مغلق"), "labeled text observation decodes")
        try check(active.nextCheckAt == "2026-11-25T13:00:00.000Z", "active card includes next check")

        let paused = try card(.paused)
        try check(paused.spec.read.phrase == "التسجيل مفتوح" && paused.current?.value == .boolean(false), "phrase and false observation decode")
        try check(paused.note?.contains("تعذّر الوصول") == true, "paused card can explain the pause")
        let stopped = try card(.stopped)
        try check(stopped.spec.source.kind == .weather && stopped.spec.source.metric == .temperature, "weather source and metric decode")
        let completed = try card(.completed)
        try check(completed.spec.source.kind == .search && completed.spec.condition.kind == .newItem, "search source and hyphenated condition decode")
        try check(completed.current?.value == .items(["https://example.org/result"]), "list observation decodes")
        let expired = try card(.expired)
        try check(expired.spec.source.kind == .run && expired.spec.source.runId != nil && expired.offer == .agentInitiated, "run source and hyphenated offer decode")
        try check(expired.current == nil && expired.lastCheckedAt == nil && expired.nextCheckAt == nil, "card decodes without a current value or check time")

        let future = fixtures.future
        try check(future.unknownStatus.status == .unknown && future.unknownStatus.id == active.id, "unknown status preserves the card")
        try check(future.unknownSource.spec.source.kind == .unknown && future.unknownSource.current == proposed.current, "unknown source survives a changed auxiliary field type")
        try check(future.unknownCondition.spec.condition.kind == .unknown && future.unknownCondition.spec.condition.value == .unknown, "unknown condition and structured value decode safely")
        try check(future.unknownFields == active, "extra fields in card and spec are ignored")

        let raw = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        guard let rawList = raw?["list"] as? [String: Any], let rawCards = rawList["monitors"] as? [[String: Any]],
              let variants = raw?["future"] as? [String: Any], let malformed = variants["malformedCard"] as? [String: Any] else {
            throw Failure(description: "Missing mixed-version list fixture")
        }
        let mixed = try JSONSerialization.data(withJSONObject: ["monitors": [malformed] + rawCards])
        try check(try decoder.decode(MonitorList.self, from: mixed).monitors == cards, "unreadable card leaves the rest of the list readable")

        let encoder = JSONEncoder()
        for card in cards {
            let encoded = try encoder.encode(card)
            try check(try decoder.decode(MonitorCard.self, from: encoded) == card, "\(card.status.rawValue) card survives Codable round trip")
        }
        let approvalBody = try encoder.encode(MonitorApprove(proposalId: proposed.id))
        let approval = try JSONSerialization.jsonObject(with: approvalBody) as? [String: String]
        try check(approval == ["proposalId": fixtures.approval.proposalId], "approval body matches MonitorApproveSchema")

        let actions: [(MonitorStatus, [MonitorAction])] = [
            (.proposed, [.approve, .stop]), (.active, [.pause, .stop]), (.paused, [.resume, .stop]),
            (.stopped, []), (.completed, []), (.expired, []), (.unknown, []),
        ]
        for (status, expected) in actions {
            try check(status.actions == expected, "\(status.rawValue) exposes the correct actions")
        }
        try check(!MonitorAction.stop.requiresConfirmation(for: .proposed), "declining a proposal needs no extra confirmation")
        try check(MonitorAction.stop.requiresConfirmation(for: .active) && MonitorAction.stop.requiresConfirmation(for: .paused), "stopping an ongoing monitor asks for confirmation")
        try check(!MonitorAction.pause.requiresConfirmation(for: .active) && !MonitorAction.resume.requiresConfirmation(for: .paused), "pause and resume require no confirmation")
        try check(MonitorDecision.settingsOrder(cards).map(\.status) == [.paused, .active, .proposed, .expired, .completed, .stopped], "settings puts active and paused first while preserving server order within each group")

        let expiredError = MonitorDecision.errorText(status: 409, code: "MONITOR_NOT_PROPOSED", action: .approve)
        let quotaError = MonitorDecision.errorText(status: 409, code: "MONITOR_LIMIT", action: .approve)
        let sourceError = MonitorDecision.errorText(status: 403, code: "MONITOR_URL_DENIED", action: .approve)
        try check(expiredError.contains("انتهت صلاحية الاقتراح"), "expired proposals explain what happened in Arabic")
        try check(quotaError.contains("الحد الأقصى للمراقبات"), "quota errors explain the monitor limit in Arabic")
        try check(sourceError.contains("رفض الخادم هذا المصدر"), "source refusals explain what happened in Arabic")
        try check(MonitorDecision.errorText(status: 429, code: "MONITOR_PREVIEW_LIMIT").contains("الحد اليومي"), "preview quota is distinct from a rate limit")
        try check(MonitorDecision.errorText(status: 502, code: nil).contains("تحميل المراقبات"), "unknown list errors have a generic Arabic fallback")
        try check(MonitorDecision.errorText(status: 502, code: nil, action: .stop).contains("تحديث المراقبة"), "unknown mutation errors have a generic Arabic fallback")

        print("Passed \(checks) monitor contract and decision checks.")
    }
}
