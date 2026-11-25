import Foundation

@main
enum PushNotificationChecks {
    struct Failure: Error, CustomStringConvertible { let description: String }

    static func main() throws {
        var checks = 0
        func check(_ condition: Bool, _ label: String) throws {
            guard condition else { throw Failure(description: "FAILED: " + label) }
            checks += 1
        }

        let token = PushDeviceRegistration.hexToken(Data([0x00, 0x09, 0x0f, 0x10, 0xa5, 0xff]))
        try check(token == "00090f10a5ff", "token is lowercase hex with two digits per byte")
        try check(PushDeviceRegistration.hexToken(Data()).isEmpty, "empty data has no token bytes")
        for environment in [PushDeviceRegistration.Environment.sandbox, .production] {
            let registration = PushDeviceRegistration(token: token, environment: environment, appVersion: "1.0")
            let data = try JSONEncoder().encode(registration)
            let body = try JSONSerialization.jsonObject(with: data) as? [String: String]
            try check(body == ["platform": "ios", "token": token, "environment": environment.rawValue, "appVersion": "1.0"],
                      "registration sends exactly the four contract fields for \(environment.rawValue)")
        }
        #if DEBUG
        try check(PushDeviceRegistration.Environment.current == .sandbox, "Debug selects sandbox")
        #else
        try check(PushDeviceRegistration.Environment.current == .production, "Release selects production")
        #endif

        let data = Data(#"{"aps":{"alert":{"title":"موحسن","body":"اكتملت المهمة"},"sound":"mohassan-done.caf","thread-id":"conversation-1"},"conversationId":"conversation-1","runId":"run-1","kind":"run-completed"}"#.utf8)
        guard let payload = try JSONSerialization.jsonObject(with: data) as? [AnyHashable: Any],
              let route = PushNotificationRoute.decode(payload) else {
            throw Failure(description: "FAILED: completed APNs fixture did not decode")
        }
        try check(route == PushNotificationRoute(conversationID: "conversation-1", runID: "run-1", kind: .completed, monitorID: nil),
                  "completed route uses top-level conversation and run IDs")
        try check(route.monitorScrollTarget(assistantMessageIDs: ["run-1"], visibleMonitorIDs: []) == nil,
                  "a regular run keeps the existing scroll behavior")

        var monitor = payload
        monitor["monitorId"] = "monitor-1"
        monitor["kind"] = "run-blocked"
        guard let monitorRoute = PushNotificationRoute.decode(monitor) else {
            throw Failure(description: "FAILED: monitor APNs fixture did not decode")
        }
        try check(monitorRoute.monitorID == "monitor-1" && monitorRoute.kind == .blocked,
                  "a monitor ID is optional top-level metadata for an existing kind")
        try check(monitorRoute.monitorScrollTarget(assistantMessageIDs: ["run-1", "result-newer"], visibleMonitorIDs: ["monitor-1"]) == "run-1",
                  "monitor alert targets the exact result when newer messages exist")
        try check(monitorRoute.monitorScrollTarget(assistantMessageIDs: ["result-newer"], visibleMonitorIDs: ["other-monitor", "monitor-1"]) == "monitor-1",
                  "the matching visible card is the fallback when the result is missing")
        try check(monitorRoute.monitorScrollTarget(assistantMessageIDs: ["result-newer"], visibleMonitorIDs: ["other-monitor"]) == nil,
                  "missing result and card leave the existing fallback in place")
        var invalidMonitor = payload
        invalidMonitor["monitorId"] = " \n"
        try check(PushNotificationRoute.decode(invalidMonitor) == route, "blank monitor ID is ignored")
        invalidMonitor["monitorId"] = 123
        try check(PushNotificationRoute.decode(invalidMonitor) == route, "non-string monitor ID is ignored")
        monitor.removeValue(forKey: "runId")
        try check(PushNotificationRoute.decode(monitor) == nil, "monitor ID does not replace the required run ID")

        var blocked = payload
        blocked["kind"] = "run-blocked"
        try check(PushNotificationRoute.decode(blocked)?.kind == .blocked, "blocked route decodes")
        var failed = payload
        failed["kind"] = "run-failed"
        try check(PushNotificationRoute.decode(failed)?.kind == .failed, "failed route decodes")
        var unknown = payload
        unknown["kind"] = "run-interrupted"
        try check(PushNotificationRoute.decode(unknown) == nil, "unknown kind does not navigate")
        var missing = payload
        missing.removeValue(forKey: "conversationId")
        try check(PushNotificationRoute.decode(missing) == nil, "APS thread ID alone does not navigate")
        var invalid = payload
        invalid["runId"] = " "
        try check(PushNotificationRoute.decode(invalid) == nil, "blank run ID does not navigate")

        try check(route.showsForegroundBanner(notificationsEnabled: true, visibleConversationID: nil),
                  "a banner is shown outside chat")
        try check(route.showsForegroundBanner(notificationsEnabled: true, visibleConversationID: "conversation-2"),
                  "a banner is shown in a different conversation")
        try check(!route.showsForegroundBanner(notificationsEnabled: true, visibleConversationID: "conversation-1"),
                  "the visible conversation updates in chat only")
        try check(!route.showsForegroundBanner(notificationsEnabled: false, visibleConversationID: nil),
                  "a disabled app shows no foreground banner")
        print("Push notification checks: \(checks) passed")
    }
}
