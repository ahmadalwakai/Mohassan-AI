import Foundation

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
        let requestID = UUID().uuidString.lowercased()
        let chat = ChatRequest(messages: [ChatMessage(role: "user", content: "افتح المتصفح")], request_id: requestID, mode: "auto", remember: false, use_memory: false, conversation_id: nil)
        let encodedChat = try JSONSerialization.jsonObject(with: JSONEncoder().encode(chat)) as! [String: Any]
        try check(encodedChat["request_id"] as? String == requestID, "Preserve the command request identifier")
        try check(encodedChat["remember"] as? Bool == false && encodedChat["use_memory"] as? Bool == false, "Memory remains explicitly off")
        try check(encodedChat["conversation_id"] == nil, "Do not send an absent conversation identifier")
        let encodedMessages = encodedChat["messages"] as! [[String: Any]]
        try check(Set(encodedMessages[0].keys) == Set(["role", "content"]), "Message metadata never enters the API prompt")
        let oldAnswer = try JSONDecoder().decode(ChatResponse.self, from: Data("{\"content\":\"hello\",\"model\":\"local\"}".utf8))
        try check(oldAnswer.route == nil && oldAnswer.sources == nil, "Legacy chat answers remain readable")
        let noteSource = try JSONDecoder().decode(ChatSource.self, from: Data("{\"id\":\"K1\",\"title\":\"Note\",\"url\":null}".utf8))
        try check(noteSource.safeURL == nil && noteSource.title == "Note", "Saved notes need no fabricated URL")
        for link in ["javascript:alert(1)", "http://example.com", "https://user:secret@example.com"] {
            let sourceData = try JSONSerialization.data(withJSONObject: ["id": "S1", "title": "Source", "url": link])
            let source = try JSONDecoder().decode(ChatSource.self, from: sourceData)
            try check(source.safeURL == nil, "Reject unsafe source links")
        }
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
        print("Pairing and hybrid contract checks passed: \(checks)")
    }
}
