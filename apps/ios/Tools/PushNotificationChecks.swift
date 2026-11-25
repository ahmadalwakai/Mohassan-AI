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
        try check(route == PushNotificationRoute(conversationID: "conversation-1", runID: "run-1", kind: .completed),
                  "completed route uses top-level conversation and run IDs")

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
