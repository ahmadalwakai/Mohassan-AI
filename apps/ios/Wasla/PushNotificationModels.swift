import Foundation

struct PushDeviceRegistration: Encodable {
    enum Environment: String, Encodable {
        case sandbox, production

        static var current: Self {
            #if DEBUG
            return .sandbox
            #else
            return .production
            #endif
        }
    }

    let platform = "ios"
    let token: String
    let environment: Environment
    let appVersion: String

    static func hexToken(_ data: Data) -> String {
        data.map { String(format: "%02x", $0) }.joined()
    }
}

struct PushNotificationRoute: Equatable, Sendable {
    enum Kind: String, Sendable {
        case completed = "run-completed"
        case blocked = "run-blocked"
        case failed = "run-failed"
    }

    let conversationID: String
    let runID: String
    let kind: Kind
    let monitorID: String?

    static func decode(_ userInfo: [AnyHashable: Any]) -> Self? {
        guard let conversationID = userInfo["conversationId"] as? String,
              !conversationID.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              let runID = userInfo["runId"] as? String,
              !runID.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              let value = userInfo["kind"] as? String,
              let kind = Kind(rawValue: value) else { return nil }
        let monitorID: String? = (userInfo["monitorId"] as? String).flatMap { id in
            id.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : id
        }
        return Self(conversationID: conversationID, runID: runID, kind: kind, monitorID: monitorID)
    }

    func monitorScrollTarget(assistantMessageIDs: [String], visibleMonitorIDs: [String]) -> String? {
        guard let monitorID else { return nil }
        // The server uses the monitor event ID for both the result message and the push run ID.
        if assistantMessageIDs.contains(runID) { return runID }
        return visibleMonitorIDs.contains(monitorID) ? monitorID : nil
    }

    func showsForegroundBanner(notificationsEnabled: Bool, visibleConversationID: String?) -> Bool {
        notificationsEnabled && conversationID != visibleConversationID
    }
}
