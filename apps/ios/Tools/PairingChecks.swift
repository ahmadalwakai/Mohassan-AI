import Foundation

/// One recorded exchange in tests/fixtures/phone: only the response matters to the phone.
private struct FixtureEnvelope<Body: Decodable>: Decodable {
    struct Response: Decodable { let status: Int; let body: Body }
    let response: Response
}

@main
enum PairingChecks {
    struct CheckFailure: Error, CustomStringConvertible {
        let description: String
    }

    static func main() throws {
        var checks = 0
        func check(_ condition: Bool, _ label: String) throws {
            guard condition else { throw CheckFailure(description: label) }
            checks += 1
        }
        func rejects(_ label: String, _ operation: () throws -> Void) throws {
            var rejected = false
            do { try operation() } catch { rejected = true }
            try check(rejected, label)
        }

        try check(PairingCode.isValid("00123456"), "Accept eight ASCII digits with leading zeros")
        try check(PairingCode.normalized("00123456") == "00123456", "Preserve leading zeros")
        try check(PairingCode.normalized("٠٠١٢٣٤٥٦") == "00123456", "Normalize Arabic digits without losing zeros")
        try check(PairingCode.isValid("٠٠١٢٣٤٥٦"), "Accept Arabic digits")
        try check(PairingCode.normalized("۰۰۱۲۳۴۵۶") == "00123456", "Normalize Persian digits without losing zeros")
        try check(PairingCode.isValid("۰۰۱۲۳۴۵۶"), "Accept Persian digits")
        try check(PairingCode.normalized(" \n٠٠١٢٣٤٥٦\t") == "00123456", "Trim only outer whitespace")
        try check(PairingCode.normalized("0٠۱23456") == "00123456", "Accept mixed supported digit forms")
        let legacy = "AbCdef0123_-XYZab"
        try check(PairingCode.isValid(legacy) && PairingCode.normalized(legacy) == legacy, "Preserve legacy token unchanged")
        try check(PairingCode.isValid(String(repeating: "a", count: 512)), "Accept legacy maximum length")
        for invalid in ["", "1234567", "123456789", "1234567a", "１２３４５６７８", "0012 3456", "0012\n3456", "AbCdef0123_\tXYZab", String(repeating: "a", count: 513)] {
            try check(!PairingCode.isValid(invalid), "Reject invalid code length, characters or whitespace")
        }

        let pin = String(repeating: "a", count: 64)
        func preset(address: String = "https://100.72.126.108:47621", fingerprint: String? = nil) throws -> Data {
            try JSONSerialization.data(withJSONObject: [
                "server_url": address,
                "certificate_sha256": fingerprint ?? pin,
                "computer_name": "Test computer"
            ])
        }
        let identity = try BundledConnection.decodeIdentity(from: preset())
        try check(identity.baseURL.absoluteString == "https://100.72.126.108:47621" && identity.fingerprint == pin && identity.deviceID.isEmpty && identity.name == "Test computer", "Decode preset into validated unpaired identity")
        let normalized = try BundledConnection.decodeIdentity(from: preset(address: "https://100.72.126.108:47621/", fingerprint: pin.uppercased()))
        try check(normalized.baseURL.path.isEmpty && normalized.fingerprint == pin, "Normalize root path and fingerprint")
        for address in ["http://100.72.126.108:47621", "https://user:password@example.com", "https://example.com/path", "https://example.com?token=bad", "https://example.com#fragment", "https://example.com:70000", ""] {
            try rejects("Reject unsafe preset address") { _ = try BundledConnection.decodeIdentity(from: preset(address: address)) }
        }
        for fingerprint in ["", String(repeating: "a", count: 63), String(repeating: "g", count: 64)] {
            try rejects("Reject malformed preset fingerprint") { _ = try BundledConnection.decodeIdentity(from: preset(fingerprint: fingerprint)) }
        }
        for malformed in ["{}", "not json", "{\"server_url\": 42, \"certificate_sha256\": \"bad\", \"computer_name\": \"Test\"}"] {
            try rejects("Reject malformed preset JSON") { _ = try BundledConnection.decodeIdentity(from: Data(malformed.utf8)) }
        }
        if CommandLine.arguments.count > 1 {
            let bundledData = try Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1]))
            let bundled = try BundledConnection.decodeIdentity(from: bundledData)
            try check(bundled.deviceID.isEmpty && !bundled.name.isEmpty, "Validate actual bundled preset without a device credential")
            let raw = try JSONSerialization.jsonObject(with: bundledData) as? [String: Any]
            try check(Set(raw?.keys.map { $0 } ?? []) == Set(["server_url", "certificate_sha256", "computer_name"]), "Bundled preset contains only public connection settings")
        }
        for link in ["javascript:alert(1)", "http://example.com", "https://user:secret@example.com"] {
            let resultData = try JSONSerialization.data(withJSONObject: ["title": "Result", "url": link, "snippet": ""])
            let result = try JSONDecoder().decode(SearchResult.self, from: resultData)
            try check(result.safeURL == nil, "Reject unsafe result links")
        }
        // The computer's status, with and without the capability block (older services).
        let richStatus = try JSONDecoder().decode(ServerStatus.self, from: Data("""
        {"name":"Wasla Windows","model":"Mohassan","busy":null,"desktop_enabled":false,"desktop":null,"app_actions_enabled":false,
         "capabilities":{"chat":{"ready":true},"search":{"ready":false,"reason":"لم يُجرَّب البحث بعد"},"images":{"ready":false,"reason":"محرك الصور غير موجود","code":"image_engine_missing"},"desktop":{"ready":false,"reason":"غير مفعّل"}}}
        """.utf8))
        try check(richStatus.unavailableReason { $0.chat } == nil && richStatus.unavailableReason { $0.images } == "محرك الصور غير موجود", "Read each function's readiness and reason")
        let plainStatus = try JSONDecoder().decode(ServerStatus.self, from: Data("{\"name\":\"Wasla Windows\",\"model\":\"x\",\"busy\":false,\"desktop_enabled\":true,\"desktop\":null}".utf8))
        try check(plainStatus.capabilities == nil && plainStatus.unavailableReason { $0.images } == nil, "An older service without capabilities stays readable")
        // The seven connection states, from what the phone last read.
        let linked = MohassanLink(linked: true, reachable: true, error: nil)
        try check(ConnectionState.derive(status: nil, statusError: nil, link: nil) == .checking, "Nothing read yet is «checking»")
        try check(ConnectionState.derive(status: nil, statusError: .message("timeout"), link: nil) == .unreachable, "A failed status read is «unreachable»")
        try check(ConnectionState.derive(status: nil, statusError: .certificate, link: nil) == .certificateMismatch, "A certificate failure is its own state")
        try check(ConnectionState.derive(status: nil, statusError: .server(401, "x"), link: linked) == .trustRevoked, "401 from the computer means the phone is no longer trusted")
        try check(ConnectionState.derive(status: richStatus, statusError: nil, link: nil) == .notLinked, "No Mohassan link read means not linked")
        try check(ConnectionState.derive(status: richStatus, statusError: nil, link: MohassanLink(linked: false, reachable: false, error: nil)) == .notLinked, "An unlinked service is «not linked»")
        try check(ConnectionState.derive(status: richStatus, statusError: nil, link: MohassanLink(linked: true, reachable: false, error: "mohassan_unavailable")) == .mohassanDown, "Linked but unreachable means Mohassan is down")
        try check(ConnectionState.derive(status: richStatus, statusError: nil, link: MohassanLink(linked: true, reachable: true, error: "WASLA_GATEWAY_UNAUTHORIZED")) == .linkRevoked("WASLA_GATEWAY_UNAUTHORIZED"), "A refused key means the link was revoked")
        try check(ConnectionState.derive(status: richStatus, statusError: nil, link: linked) == .ready, "Linked and reachable is ready")
        try check(ConnectionState.ready.canSend && !ConnectionState.mohassanDown.canSend && !ConnectionState.checking.canSend, "Only the ready state lets the composer send")
        // Mohassan conversation, as Mohassan's server returns it through the computer service.
        let conversationID = "8f2c1a9e-4b7d-4c3e-9a1f-2d5e6b7c8a90", questionID = "1a2b3c4d-5e6f-4a1b-8c2d-3e4f5a6b7c8d"
        // A literal JSON reply keeps the fixture free of heterogeneous Swift collection literals.
        let conversationJSON = """
        {"id":"\(conversationID)","title":"حملة","status":"waiting_user","updatedAt":"2026-11-10T20:00:00.000Z","browserAccount":null,
         "messages":[{"id":"0b1c2d3e-4f5a-4b6c-8d7e-9f0a1b2c3d4e","role":"user","text":"أنشئ حملة","createdAt":"2026-11-10T20:00:00.000Z"}],
         "question":{"id":"\(questionID)","prompt":"ما الميزانية؟","action":"google_ads_connect",
                     "options":[{"id":"connect","label":"اربط"},{"id":"later","label":"لاحقًا"}],
                     "clarification":{"reason":"تحدد الحملة","recommendedOptionId":null,"allowText":true,"slots":["budget"],"goalVersion":1,"readiness":"needs_input"}},
         "approval":null,"secure":null,"browser":null,"progress":null,"steps":[],"error":null,"configured":true,
         "campaign":null,"decisions":{"lastSeq":3,"events":[]}}
        """
        let conversation = try JSONDecoder().decode(MohassanConversation.self, from: Data(conversationJSON.utf8))
        try check(conversation.id == conversationID && conversation.messages.first?.text == "أنشئ حملة" && !conversation.working, "Read a Mohassan conversation and ignore fields the phone does not use")
        try check(conversation.question?.phoneOptions.map(\.id) == ["later"], "Google's consent option stays on the web")
        try check(conversation.question?.acceptsText == true && conversation.question?.clarification?.recommendedOptionId == nil, "Typed answers follow the clarification setting")
        let plainQuestion = try JSONDecoder().decode(MohassanQuestion.self, from: Data("{\"id\":\"\(questionID)\",\"prompt\":\"ما اسم الموقع؟\",\"options\":[]}".utf8))
        try check(plainQuestion.acceptsText && plainQuestion.phoneOptions.isEmpty, "A question without options takes a typed answer")
        let choice = try JSONSerialization.jsonObject(with: JSONEncoder().encode(MohassanRespond(questionId: questionID, optionId: "later", text: nil))) as! [String: Any]
        try check(Set(choice.keys) == Set(["questionId", "optionId"]), "An option answer leaves out the absent text")
        let typed = try JSONSerialization.jsonObject(with: JSONEncoder().encode(MohassanRespond(questionId: questionID, optionId: nil, text: "١٠٠ جنيه"))) as! [String: Any]
        try check(Set(typed.keys) == Set(["questionId", "text"]), "A typed answer leaves out the absent option")
        let approval = try JSONSerialization.jsonObject(with: JSONEncoder().encode(MohassanApprove(approvalId: questionID, approved: false))) as! [String: Any]
        try check(approval["approved"] as? Bool == false && Set(approval.keys) == Set(["approvalId", "approved"]), "A refusal is sent as approved false")
        let summaries = try JSONDecoder().decode(MohassanList.self, from: Data("{\"conversations\":[{\"id\":\"\(conversationID)\",\"title\":\"\",\"status\":\"running\",\"updatedAt\":\"now\",\"browserAccount\":null}]}".utf8)).conversations
        try check(summaries.first?.status == "running" && MohassanStatus.title("running") == "موحسن يعمل…", "Read the conversation list")
        let link = try JSONDecoder().decode(MohassanLink.self, from: Data("{\"linked\":false,\"reachable\":false}".utf8))
        try check(!link.linked && link.error == nil, "An unlinked computer service is readable")

        // Real exchanges recorded from Mohassan's server (tests/fixtures/phone, scripts/phone-fixtures.ts).
        // The same files drive the server's and the computer service's tests, so the phone reads what they send.
        if CommandLine.arguments.count > 2 {
            let directory = CommandLine.arguments[2]
            let names = try FileManager.default.contentsOfDirectory(atPath: directory).filter { $0.hasSuffix(".json") && $0 != "index.json" }.sorted()
            func fixture<Body: Decodable>(_ name: String, as type: Body.Type) throws -> FixtureEnvelope<Body> {
                try JSONDecoder().decode(FixtureEnvelope<Body>.self, from: Data(contentsOf: URL(fileURLWithPath: directory).appendingPathComponent(name)))
            }
            var conversations = 0, lists = 0, faults = 0
            for name in names {
                if name.hasPrefix("detail-") || ["create.json", "cancel.json"].contains(name) || name.hasPrefix("messages-") || name.hasPrefix("approve-") || name.hasPrefix("respond-") {
                    let envelope = try fixture(name, as: MohassanConversation.self)
                    try check(envelope.response.status == 200 && UUID(uuidString: envelope.response.body.id) != nil, "Read the recorded conversation \(name)")
                    conversations += 1
                } else if name.hasPrefix("list") {
                    _ = try fixture(name, as: MohassanList.self)
                    lists += 1
                } else if name.hasPrefix("error-") {
                    let envelope = try fixture(name, as: ServerFault.self)
                    try check(envelope.response.status >= 400 && !envelope.response.body.error.code.isEmpty, "Read the recorded error \(name)")
                    faults += 1
                }
            }
            try check(conversations >= 10 && lists >= 2 && faults >= 4, "Enough recorded exchanges were read (\(conversations) conversations, \(lists) lists, \(faults) errors)")
            let completed = try fixture("detail-completed.json", as: MohassanConversation.self).response.body
            try check(completed.status == "idle" && !completed.working, "A finished conversation is idle, not working")
            try check(completed.messages.last?.text == "15 × 23 = **345**", "The brain's own answer reaches the phone")
            let asking = try fixture("detail-question-fields.json", as: MohassanConversation.self).response.body
            try check(asking.status == MohassanStatus.waitingUser && asking.question != nil && asking.question?.options.map(\.id) == ["stop"], "A question card with several fields is readable; the phone shows its stop option (fields arrive in plan phase 3)")
            let approval = try fixture("detail-approval.json", as: MohassanConversation.self).response.body
            try check(approval.status == MohassanStatus.waitingApproval && approval.approval?.detail.contains("POST /consent") == true, "An approval is readable with its detail")
            let failed = try fixture("detail-failed-no-model.json", as: MohassanConversation.self).response.body
            try check(failed.status == MohassanStatus.failed && !(failed.error ?? "").isEmpty, "A failed conversation carries its error text")
        }
        print("Pairing and hybrid contract checks passed: \(checks)")
    }
}
