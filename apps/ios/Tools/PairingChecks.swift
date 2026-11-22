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
        // Search through Mohassan's engine: an empty answer carries its notice; older services send neither field.
        let emptySearch = try JSONDecoder().decode(SearchResponse.self, from: Data("""
        {"query":"Tailscale","results":[],"provider":"Wikipedia / Stack Exchange","limitations":["مصادر متخصصة"],"notice":"لم تجد مصادر موحسن نتيجة لهذا البحث."}
        """.utf8))
        try check(emptySearch.results.isEmpty && emptySearch.notice?.isEmpty == false && emptySearch.limitations?.count == 1, "An empty search explains itself")
        let oldSearch = try JSONDecoder().decode(SearchResponse.self, from: Data("{\"query\":\"q\",\"results\":[],\"provider\":\"DuckDuckGo HTML\"}".utf8))
        try check(oldSearch.notice == nil && oldSearch.limitations == nil, "An older search reply stays readable")
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
        let stopOnly = try JSONDecoder().decode(MohassanQuestion.self, from: Data("{\"id\":\"\(questionID)\",\"prompt\":\"ما الذي ينقص؟\",\"options\":[{\"id\":\"stop\",\"label\":\"توقف هنا\"}]}".utf8))
        try check(stopOnly.acceptsText && stopOnly.stopOption?.id == "stop" && stopOnly.phoneFields.isEmpty, "A question whose only option is «stop» takes a typed answer")
        let choices = try JSONDecoder().decode(MohassanQuestion.self, from: Data("{\"id\":\"\(questionID)\",\"prompt\":\"كيف أتابع؟\",\"options\":[{\"id\":\"retry\",\"label\":\"حاول بطريقة أخرى\"},{\"id\":\"stop\",\"label\":\"توقف هنا\"}]}".utf8))
        try check(!choices.acceptsText, "A question with real choices is answered by its options")

        // Plan phase 3: every request that changes something carries its own key and the body Mohassan expects.
        func sent(_ request: MohassanRequest) throws -> [String: Any] { try JSONSerialization.jsonObject(with: request.body) as! [String: Any] }
        let created = try MohassanRequest.make(.create, conversationId: nil, text: "مرحبا") { MohassanCreate(goal: "مرحبا", clientRequestId: $0) }
        let createdBody = try sent(created)
        try check(Set(createdBody.keys) == Set(["goal", "clientRequestId"]) && createdBody["clientRequestId"] as? String == created.key, "A new conversation carries its key")
        try check(UUID(uuidString: created.key) != nil && created.key == created.key.lowercased() && created.phase == .sending, "Keys are lowercase UUIDs, as the computer's lookup route reads them")
        try check(created.path == "/v1/mohassan/conversations" && created.fromComposer && created.belongs(to: nil) && !created.belongs(to: conversationID), "A new conversation belongs to the new-chat screen")
        let again = try MohassanRequest.make(.create, conversationId: nil, text: "مرحبا") { MohassanCreate(goal: "مرحبا", clientRequestId: $0) }
        try check(again.key != created.key, "Each request gets a fresh key")
        let message = try MohassanRequest.make(.message, conversationId: conversationID, text: "و 40 ضرب 3؟") { MohassanSend(text: "و 40 ضرب 3؟", clientRequestId: $0) }
        let messageBody = try sent(message)
        try check(Set(messageBody.keys) == Set(["text", "clientRequestId"]) && message.path == "/v1/mohassan/conversations/\(conversationID)/messages" && message.belongs(to: conversationID), "A message goes to its own conversation")
        let typedReply = try MohassanRequest.make(.reply, conversationId: conversationID, text: "١٠٠ جنيه") { MohassanReply(text: "١٠٠ جنيه", questionId: questionID, clientRequestId: $0) }
        let typedBody = try sent(typedReply)
        try check(Set(typedBody.keys) == Set(["text", "questionId", "clientRequestId"]) && typedReply.path.hasSuffix("/messages") && !typedReply.fromComposer, "A typed answer is a message that names its question")
        let option = try MohassanRequest.make(.option, conversationId: conversationID, text: "لاحقًا") { MohassanRespond(questionId: questionID, optionId: "later", clientRequestId: $0) }
        let optionBody = try sent(option)
        try check(Set(optionBody.keys) == Set(["questionId", "optionId", "clientRequestId"]) && option.path.hasSuffix("/respond"), "An option goes through respond, with no text")
        let refusal = try MohassanRequest.make(.approve, conversationId: conversationID, text: "رفض") { MohassanApprove(approvalId: questionID, approved: false, clientRequestId: $0) }
        let refusalBody = try sent(refusal)
        try check(refusalBody["approved"] as? Bool == false && Set(refusalBody.keys) == Set(["approvalId", "approved", "clientRequestId"]) && refusal.path.hasSuffix("/approve"), "A refusal is sent as approved false")
        try check(!refusal.fromComposer && !option.fromComposer, "An approval or a card's answer is never offered for resending")
        let saved = try JSONDecoder().decode(MohassanRequest.self, from: JSONEncoder().encode(message))
        try check(saved == message && saved.body == message.body, "A saved request comes back byte for byte, so «send again» repeats the same body and key")

        // What a failure means: only a refusal or a call that never left the phone proves nothing happened.
        func outcome(_ error: Error) -> String {
            switch SendOutcome.of(error) {
            case .notDone: return "notDone"
            case .unknown: return "unknown"
            case .inProgress: return "inProgress"
            case .undetermined: return "undetermined"
            }
        }
        try check(outcome(WaslaError.server(409, "x", code: "CHAT_BUSY")) == "notDone" && outcome(WaslaError.server(400, "x", code: "invalid_request")) == "notDone" && outcome(WaslaError.server(401, "x")) == "notDone", "A refusal changed nothing")
        try check(outcome(WaslaError.server(409, "x", code: "CLIENT_REQUEST_REUSED")) == "notDone", "A key reused for another request is a refusal")
        try check(outcome(WaslaError.server(409, "x", code: "CLIENT_REQUEST_IN_PROGRESS")) == "inProgress", "The same key still running is not a refusal")
        try check(outcome(WaslaError.server(409, "x", code: "CLIENT_REQUEST_UNKNOWN")) == "undetermined", "A key that failed midway stays undetermined")
        try check(outcome(WaslaError.server(502, "x", code: "mohassan_unavailable")) == "unknown" && outcome(WaslaError.server(500, "x")) == "unknown", "A failure after the request left may have happened")
        try check(outcome(URLError(.timedOut)) == "unknown" && outcome(URLError(.networkConnectionLost)) == "unknown" && outcome(WaslaError.invalidResponse) == "unknown", "A lost reply is not proof that nothing happened")
        try check(outcome(URLError(.cannotConnectToHost)) == "notDone" && outcome(URLError(.notConnectedToInternet)) == "notDone" && outcome(WaslaError.certificate) == "notDone", "No connection, or no trusted handshake, means it was never sent")
        try check(outcome(DecodingError.dataCorrupted(.init(codingPath: [], debugDescription: "x"))) == "unknown", "A reply the phone cannot read leaves the outcome open")
        func lookup(_ json: String) throws -> MohassanRequestStatus.Verdict { try JSONDecoder().decode(MohassanRequestStatus.self, from: Data(json.utf8)).verdict }
        try check(try lookup("{\"known\":false}") == .notReceived, "An unknown key was never received")
        try check(try lookup("{\"known\":true,\"kind\":\"messages\",\"state\":\"done\",\"conversationId\":\"\(conversationID)\"}") == .done(conversationID), "A done key names its conversation")
        try check(try lookup("{\"known\":true,\"kind\":\"create\",\"state\":\"pending\",\"conversationId\":null}") == .inProgress, "A pending key is still being taken in")
        try check(try lookup("{\"known\":true,\"kind\":\"approve\",\"state\":\"unknown\",\"conversationId\":\"\(conversationID)\"}") == .undetermined, "A key that failed midway is undetermined")

        // A field card's answers, composed as the web's QuestionPanel composes them.
        let fieldsJSON = """
        [{"id":"to","prompt":"لمن الرسالة؟","suggestions":[],"placeholder":"مثلاً: الأستاذ خالد"},
         {"id":"kind","prompt":"ما نوعها؟","suggestions":[{"label":"اعتذار"},{"label":"طلب"},{"label":"شكر","reason":"من موقعك"}],"selected":[0,9]},
         {"id":"places","prompt":"أين؟","suggestions":[{"label":"دمشق"},{"label":"حلب"}],"multiple":true},
         {"id":"details","prompt":"ماذا تريد أن تقول؟","suggestions":[],"multiline":true}]
        """
        let fields = try JSONDecoder().decode([MohassanField].self, from: Data(fieldsJSON.utf8))
        try check(fields[1].preselected == Set([0]) && fields[1].suggestions[2].reason == "من موقعك" && fields[2].allowsSeveral && fields[3].keepsLines && fields[0].placeholder != nil, "Read a field card: suggestions, reasons, choices made in advance (in range), several answers, kept lines")
        try check(FieldAnswers.answer(fields[0], chosen: [], typed: "  الأستاذ خالد ") == "الأستاذ خالد", "A one-line answer is trimmed")
        try check(FieldAnswers.answer(fields[1], chosen: fields[1].preselected, typed: "") == "اعتذار", "The brain's confident choice stands until changed")
        try check(FieldAnswers.answer(fields[1], chosen: [0], typed: "شكوى") == "شكوى", "In a single-answer question a typed answer replaces the choice")
        try check(FieldAnswers.answer(fields[2], chosen: [1, 0], typed: " اللاذقية ") == "دمشق, حلب, اللاذقية", "Several choices keep their order, and a typed one is added")
        try check(FieldAnswers.answer(fields[3], chosen: [], typed: "سطر أول\nسطر ثان") == "سطر أول\nسطر ثان", "A multi-line answer keeps its lines")
        try check(FieldAnswers.answer(fields[3], chosen: [], typed: " \n ") == "", "Blank lines are no answer")
        try check(FieldAnswers.length(["أ", "ب"]) == 9 && FieldAnswers.length(["أ"]) == 1, "Several answers count their «1. » numbers and line breaks")
        try check(!FieldAnswers.ready(["أ", ""]) && FieldAnswers.ready(["أ", "ب"]), "Every question needs an answer")
        try check(FieldAnswers.ready([String(repeating: "a", count: 3_992), "b"]) && !FieldAnswers.ready([String(repeating: "a", count: 3_994), "b"]), "The answers stay within Mohassan's 4,000 characters")

        // Replies in the web's Markdown subset; only https links open.
        if #available(macOS 12.0, *) {
            let source = "المصدر: [موسوعة](https://ar.wikipedia.org/wiki/%D8%AF%D9%85%D8%B4%D9%82) و https://example.com/docs/page_name.html ثم http://10.0.0.9/x و [سيئ](javascript:alert(1))"
            let reply = "## الخطة\nأولًا **مهم** و`code`.\n\n- بند أول\n- بند ثان\n\n1. واحد\n2) اثنان\n\n> اقتباس\n\n```\nlet x = 1\n```\n" + source
            try check(ReplyMarkdown.blocks(reply) == [.heading("الخطة"), .paragraph("أولًا **مهم** و`code`."), .list(ordered: false, items: ["بند أول", "بند ثان"]),
                                                    .list(ordered: true, items: ["واحد", "اثنان"]), .quote(["اقتباس"]), .code("let x = 1"), .paragraph(source)], "Read headings, lists, quotes, code and paragraphs as the web does")
            let linked = ReplyMarkdown.inline(source)
            try check(linked.runs.compactMap { $0.link?.absoluteString } == ["https://ar.wikipedia.org/wiki/%D8%AF%D9%85%D8%B4%D9%82", "https://example.com/docs/page_name.html"], "Only https links are tappable")
            try check(String(linked.characters) == "المصدر: موسوعة و example.com › page name ثم http://10.0.0.9/x و [سيئ](javascript:alert(1))", "A link shows its title or a short address; others stay plain, in full")
            let styled = ReplyMarkdown.inline("أولًا **مهم** و`code`.")
            let bold = styled.runs.filter { $0.inlinePresentationIntent == .stronglyEmphasized }.map { String(styled[$0.range].characters) }
            let code = styled.runs.filter { $0.inlinePresentationIntent == .code }.map { String(styled[$0.range].characters) }
            try check(String(styled.characters) == "أولًا مهم وcode." && bold == ["مهم"] && code == ["code"], "Bold and code marks become styles, not stars")
            try check(ReplyMarkdown.blocks("# \nنص") == [.paragraph("# \nنص")], "A lone # never stalls the reader")
            try check(ReplyMarkdown.plainText("> **مهم**: [المصدر](https://example.com)\n\n\n\nتم") == "مهم: المصدر (https://example.com)\n\nتم", "Copying gives plain text with each link's address")
            try check(ReplyMarkdown.shortLink("https://www.example.com/") == "example.com" && ReplyMarkdown.shortLink("https://ar.wikipedia.org/wiki/%D8%AF%D9%85%D8%B4%D9%82") == "ar.wikipedia.org › دمشق", "A bare address reads as the site and the page name")
            try check(ReplyMarkdown.withoutQuestionList("أحتاج بعض التفاصيل:\nلمن الرسالة؟\nما نوعها؟\n\nسأكتبها بعدها.") == "سأكتبها بعدها.", "With a field card open, the reply drops the questions it lists")
            try check(ReplyMarkdown.withoutQuestionList("الملخص:\n- بند\n- بند") == "الملخص:\n- بند\n- بند", "A summary list after a colon stays")
        }
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
            try check(completed.messages.last?.text.contains("345") == true, "The brain's own answer reaches the phone")
            let asking = try fixture("detail-question-fields.json", as: MohassanConversation.self).response.body
            try check(asking.status == MohassanStatus.waitingUser && asking.question?.stopOption?.id == "stop", "A question card with several fields offers its stop option")
            let card = asking.question?.phoneFields ?? []
            try check(card.map(\.id) == ["to", "kind", "details", "from"] && card[1].suggestions.count >= 2 && !card[1].preselected.isEmpty && card[2].keepsLines && card.allSatisfy { $0.placeholder != nil || !$0.suggestions.isEmpty }, "The phone reads the card's fields: suggestions, the brain's choice, kept lines, placeholders")
            // The very request Mohassan accepted for that card: the phone composes and encodes the same body.
            let answeredURL = URL(fileURLWithPath: directory).appendingPathComponent("messages-field-answers.json")
            let answered = try JSONSerialization.jsonObject(with: Data(contentsOf: answeredURL)) as! [String: Any]
            let recordedBody = (answered["request"] as! [String: Any])["body"] as! [String: Any]
            let recordedAnswers = (recordedBody["answers"] as! [[String: String]]).map { MohassanFieldAnswer(fieldId: $0["fieldId"]!, value: $0["value"]!) }
            let composed = card.indices.map { index in
                FieldAnswers.answer(card[index], chosen: card[index].suggestions.isEmpty ? [] : card[index].preselected, typed: card[index].suggestions.isEmpty ? recordedAnswers[index].value : "")
            }
            try check(composed == recordedAnswers.map(\.value) && recordedAnswers.map(\.fieldId) == card.map(\.id), "The card composes the recorded answers: typed ones as typed, the brain's choice as chosen")
            let phoneBody = try JSONSerialization.jsonObject(with: JSONEncoder().encode(MohassanFieldsReply(questionId: asking.question!.id, answers: recordedAnswers, clientRequestId: recordedBody["clientRequestId"] as! String))) as! [String: Any]
            try check(NSDictionary(dictionary: phoneBody).isEqual(to: recordedBody), "The phone's field answers are the very body Mohassan accepted")
            let afterAnswers = try fixture("messages-field-answers.json", as: MohassanConversation.self).response
            try check(afterAnswers.status == 200 && afterAnswers.body.status != MohassanStatus.waitingUser, "Mohassan took the answers and went on")
            let done = try fixture("request-done.json", as: MohassanRequestStatus.self).response.body
            try check(done.verdict == .done(asking.id), "A delivered request reads as done, with its conversation")
            let neverSeen = try fixture("request-unknown.json", as: MohassanRequestStatus.self).response.body
            try check(neverSeen.verdict == .notReceived, "A key Mohassan never saw reads as not received")
            let first = try fixture("create.json", as: MohassanConversation.self).response.body
            let replayed = try fixture("create-replayed.json", as: MohassanConversation.self).response
            try check(replayed.status == 200 && replayed.body.id == first.id, "Sending a create again with its key returns the same conversation, not a second one")
            for name in ["error-request-reused.json", "error-question-changed.json", "error-approval-changed.json"] {
                let refused = try fixture(name, as: ServerFault.self).response
                try check(outcome(WaslaError.server(refused.status, refused.body.error.message, code: refused.body.error.code)) == "notDone", "A recorded refusal (\(name)) hands the text back: nothing ran")
            }
            let approval = try fixture("detail-approval.json", as: MohassanConversation.self).response.body
            try check(approval.status == MohassanStatus.waitingApproval && approval.approval?.detail.contains("POST /consent") == true, "An approval is readable with its detail")
            let failed = try fixture("detail-failed-blocked-address.json", as: MohassanConversation.self).response.body
            try check(failed.status == MohassanStatus.failed && !(failed.error ?? "").isEmpty, "A failed conversation carries its error text")
        }
        print("Pairing and hybrid contract checks passed: \(checks)")
    }
}
