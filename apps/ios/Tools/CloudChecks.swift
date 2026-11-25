import Foundation

// Compiled with apps/ios/Wasla/Models.swift and run by Codemagic before every build:
//   cloud-checks <apps/ios/Wasla/ConnectionDefaults.json> <tests/fixtures/cloud-phone>
// The fixtures are real exchanges with the cloud server (scripts/cloud-phone-fixtures.ts on the server branch);
// every model the app decodes is decoded here from them, so a shape the server stopped sending fails the build.

private struct Envelope<Body: Decodable>: Decodable {
    struct Response: Decodable { let status: Int; let body: Body; let headers: [String: [String]]? }
    let response: Response
}

@main
enum CloudChecks {
    struct CheckFailure: Error, CustomStringConvertible { let description: String }

    static func main() throws {
        let arguments = CommandLine.arguments
        guard arguments.count == 3 else { throw CheckFailure(description: "usage: cloud-checks <ConnectionDefaults.json> <fixtures directory>") }
        let defaultsFile = URL(fileURLWithPath: arguments[1])
        let fixtures = URL(fileURLWithPath: arguments[2], isDirectory: true)
        var checks = 0
        func check(_ condition: Bool, _ label: String) throws {
            guard condition else { throw CheckFailure(description: "FAILED: " + label) }
            checks += 1
        }
        func rejects(_ label: String, _ operation: () throws -> Void) throws {
            var rejected = false
            do { try operation() } catch { rejected = true }
            try check(rejected, label)
        }
        func file(_ name: String) throws -> Data { try Data(contentsOf: fixtures.appendingPathComponent(name + ".json")) }
        func load<Body: Decodable>(_ name: String, as type: Body.Type) throws -> (status: Int, body: Body, headers: [String: [String]]) {
            let envelope = try JSONDecoder().decode(Envelope<Body>.self, from: try file(name))
            return (envelope.response.status, envelope.response.body, envelope.response.headers ?? [:])
        }
        func raw(_ name: String) throws -> [String: Any] {
            guard let object = try JSONSerialization.jsonObject(with: try file(name)) as? [String: Any] else { throw CheckFailure(description: "\(name): not an object") }
            return object
        }
        /// The recorded response body as the bytes the app would receive.
        func responseBody(_ name: String) throws -> (status: Int, data: Data) {
            let envelope = try raw(name)
            guard let response = envelope["response"] as? [String: Any], let status = response["status"] as? Int, let body = response["body"] else {
                throw CheckFailure(description: "\(name): no response")
            }
            return (status, try JSONSerialization.data(withJSONObject: body, options: [.fragmentsAllowed]))
        }
        func requestBody(_ name: String) throws -> NSDictionary {
            guard let request = try raw(name)["request"] as? [String: Any], let body = request["body"] as? [String: Any] else { throw CheckFailure(description: "\(name): no request body") }
            return body as NSDictionary
        }
        func dictionary(_ data: Data) throws -> NSDictionary {
            guard let object = try JSONSerialization.jsonObject(with: data) as? NSDictionary else { throw CheckFailure(description: "not a JSON object") }
            return object
        }
        func sorted<Body: Encodable>(_ body: Body) throws -> Data {
            let encoder = JSONEncoder()
            encoder.outputFormatting = [.sortedKeys]
            return try encoder.encode(body)
        }
        func code(_ error: WaslaError) -> String? { if case .server(_, _, let code) = error { return code }; return nil }
        func message(_ error: WaslaError) -> String? { if case .server(_, let message, _) = error { return message }; return nil }

        // 1. The bundled server address: https and a host only.
        let origin = try CloudDefaults.decode(try Data(contentsOf: defaultsFile))
        try check(origin.absoluteString == "https://www.mohassansy.com", "bundled origin is https://www.mohassansy.com, got \(origin.absoluteString)")
        try check(CloudDefaults.header(origin) == "https://www.mohassansy.com", "Origin header has no trailing slash")
        try check(try CloudDefaults.origin(" https://WWW.mohassansy.com/ ").absoluteString == "https://www.mohassansy.com", "origin normalizes case and a bare slash")
        for bad in ["http://www.mohassansy.com", "https://www.mohassansy.com/app", "https://www.mohassansy.com:8443", "https://user@www.mohassansy.com",
                    "https://www.mohassansy.com?x=1", "https://www.mohassansy.com#top", "https://", "", "www.mohassansy.com", "https://www.moha%73sansy.com"] {
            try rejects("origin refuses \(bad)") { _ = try CloudDefaults.origin(bad) }
        }

        // 2. Signing in: the session cookie from Set-Cookie, sent back unchanged.
        let signIn = try load("auth-sign-in", as: SignInReply.self)
        try check(signIn.status == 200 && signIn.body.user?.email == "phone-owner@example.test", "sign-in reply names the user")
        let recordedCookie = signIn.headers["set-cookie"]?.first ?? ""
        guard let cookie = SessionCookie.from(setCookie: recordedCookie) else { throw CheckFailure(description: "FAILED: session cookie in the recorded Set-Cookie: \(recordedCookie)") }
        try check(cookie.name == "better-auth.session_token" && cookie.value.hasSuffix("%3D") && cookie.valid, "recorded cookie keeps its name and encoded value")
        try check(cookie.header == "better-auth.session_token=" + cookie.value, "cookie header is name=value")
        let value = String(repeating: "A", count: 32) + "." + String(repeating: "b", count: 43) + "%3D"
        let production = "__Secure-better-auth.session_token=\(value); Max-Age=604800; Path=/; HttpOnly; Secure; SameSite=Lax"
        try check(SessionCookie.from(setCookie: production) == SessionCookie(name: "__Secure-better-auth.session_token", value: value), "production __Secure- cookie is read")
        try check(SessionCookie.from(setCookie: "theme=dark; Path=/, " + production)?.value == value, "session cookie found among several joined cookies")
        try check(SessionCookie.from(setCookie: "better-auth.session_token=; Max-Age=0; Path=/") == nil, "a cleared cookie is no session")
        try check(SessionCookie.from(setCookie: "better-auth.session_token=short; Path=/") == nil, "a short value is no session")
        try check(SessionCookie.from(setCookie: "evil-better-auth.session_token=\(value)") == nil, "a cookie that only ends with the name is not taken")
        try check(SessionCookie.from(setCookie: "better-auth.session_data=\(value)") == nil, "another better-auth cookie is not the session")
        let stored = try JSONDecoder().decode(SessionCookie.self, from: try JSONEncoder().encode(cookie))
        try check(stored == cookie, "cookie survives the Keychain's JSON")

        // 3. Errors in the server's two shapes, and what each means for a request.
        let wrong = try responseBody("auth-sign-in-wrong-password")
        let wrongError = ServerFault.error(status: wrong.status, data: wrong.data)
        try check(code(wrongError) == "INVALID_EMAIL_OR_PASSWORD" && wrong.status == 401, "better-auth's flat error is read")
        let signedOut = try responseBody("error-signed-out")
        try check(code(ServerFault.error(status: signedOut.status, data: signedOut.data)) == "UNAUTHORIZED" && signedOut.status == 401, "signed-out error is read")
        let reused = try responseBody("error-request-reused")
        let reusedError = ServerFault.error(status: reused.status, data: reused.data)
        try check(code(reusedError) == "CHAT_REQUEST_KEY_REUSED", "reused key error is read")
        if case .notDone = SendOutcome.of(reusedError) { checks += 1 } else { throw CheckFailure(description: "FAILED: a reused key means nothing happened") }
        let invalid = try responseBody("error-invalid-body")
        if case .notDone = SendOutcome.of(ServerFault.error(status: invalid.status, data: invalid.data)) { checks += 1 } else { throw CheckFailure(description: "FAILED: a refused body means nothing happened") }
        try check(SendOutcome.of(WaslaError.server(409, "running", code: "CHAT_REQUEST_IN_PROGRESS")) == .inProgress("running"), "the same key still running waits")
        try check(SendOutcome.of(WaslaError.server(503, "down", code: "SERVICE_UNAVAILABLE")) == .unknown("down"), "a 503 may have happened")
        try check(SendOutcome.of(WaslaError.server(429, "slow", code: nil)) == .notDone("slow"), "a rate limit refused it")
        try check(SendOutcome.of(WaslaError.signedOut) == .signedOut, "a lost session is its own outcome")
        if case .notDone = SendOutcome.of(URLError(.notConnectedToInternet)) { checks += 1 } else { throw CheckFailure(description: "FAILED: no connection means never sent") }
        if case .unknown = SendOutcome.of(URLError(.timedOut)) { checks += 1 } else { throw CheckFailure(description: "FAILED: a timeout may have arrived") }
        if case .unknown = SendOutcome.of(URLError(.networkConnectionLost)) { checks += 1 } else { throw CheckFailure(description: "FAILED: a lost connection may have arrived") }
        try check(message(ServerFault.error(status: 502, data: Data("<html>bad gateway</html>".utf8))) == "تعذّر إكمال الطلب (502).", "a non-JSON error gets the status sentence")
        try check(message(ServerFault.error(status: 404, data: Data(#"{"error":{"code":"X","message":"  "}}"#.utf8))) == "تعذّر إكمال الطلب (404).", "a blank message falls back")

        // 4. The list: request keys and what works without a model.
        let list = try load("list", as: ChatList.self).body
        try check(list.requestKeys == true, "the server says it honours request keys")
        try check(!list.conversations.isEmpty && list.conversations.allSatisfy { UUID(uuidString: $0.id) != nil }, "list has conversations with uuid ids")
        guard let capabilities = list.capabilities else { throw CheckFailure(description: "FAILED: list carries capabilities") }
        try check(capabilities.chatModel == false && capabilities.available.contains("computation"), "capabilities read")
        try check(capabilities.localModeText?.hasPrefix("لا يتصل بهذه الجلسة نموذج لغوي، فالردود الحرة غير متاحة. ما يعمل الآن دون نموذج: الحساب") == true, "local-mode sentence matches the web's")
        try check(ChatCapabilities(chatModel: true, available: []).localModeText == nil, "no banner with a model")
        try check(ChatCapabilities(chatModel: false, available: ["unknown"]).localModeText == "لا يتصل بهذه الجلسة نموذج لغوي، فالردود الحرة غير متاحة.", "unknown ids are left out")
        try check(try load("list-empty", as: ChatList.self).body.conversations.isEmpty, "empty list")
        try check(try load("images-available", as: ChatImageAvailability.self).body.available, "image upload availability read")

        // 5. Every conversation reply decodes; the states the cards depend on are where the app expects them.
        let conversationFiles = ["create", "create-replayed", "detail-completed", "detail-held-unchanged", "messages-text", "detail-completed-follow-up",
                                 "feedback", "detail-question-fields", "messages-field-answers", "detail-completed-letter", "detail-question-before-stop",
                                 "respond-stop", "detail-stopped", "detail-approval", "approve-refused", "detail-approval-refused",
                                 "detail-approval-before-cancel", "cancel", "detail-cancelled", "detail-sign-in", "detail-failed-blocked-address",
                                 "create-greeting", "detail-greeting"]
        var conversations: [String: ChatConversation] = [:]
        for name in conversationFiles {
            let reply = try load(name, as: ChatConversation.self)
            try check(reply.status == 200 && UUID(uuidString: reply.body.id) != nil, "\(name) decodes as a conversation")
            conversations[name] = reply.body
            for message in reply.body.messages where !message.mine {
                try check(!ReplyMarkdown.plainText(message.text).contains("**"), "\(name): the copied reply has no ** marks")
            }
        }
        func conversation(_ name: String) throws -> ChatConversation {
            guard let found = conversations[name] else { throw CheckFailure(description: "missing \(name)") }
            return found
        }
        let created = try conversation("create"), completed = try conversation("detail-completed")
        try check(created.working && created.id == completed.id, "create answers while the brain works")
        try check(try conversation("create-replayed").id == created.id, "the replayed key returns the same conversation")
        try check(completed.status == ChatStatus.idle && completed.messages.count >= 2 && completed.messages.last?.text.contains("345") == true, "the calculator's answer arrives")
        guard let version = completed.version else { throw CheckFailure(description: "FAILED: the server sends a version for long-poll") }
        try check(version.count == 24 && version.allSatisfy { $0.isHexDigit }, "version is 24 hex")
        try check(try conversation("detail-held-unchanged").version == version, "a held read with no change returns the same version")
        try check(try conversation("messages-text").working, "a message starts work")
        try check(try conversation("detail-failed-blocked-address").status == ChatStatus.failed && !(try conversation("detail-failed-blocked-address").error ?? "").isEmpty, "a failure carries its reason")

        // 6. The several-questions card, answered exactly as the recorded request did.
        let letter = try conversation("detail-question-fields")
        guard let question = letter.fieldsQuestion else { throw CheckFailure(description: "FAILED: the letter waits on a field card") }
        try check(letter.waiting && question.phoneFields.map(\.id) == ["to", "kind", "details", "from"], "field card ids in order")
        try check(question.stopOption?.id == "stop" && question.phoneOptions.contains { $0.id == "stop" }, "the card offers «stop»")
        let typed = ["to": "الأستاذ خالد", "details": "تأخر التسليم يومين بسبب الشحن، وسيصل الطلب يوم الأحد", "from": "موحسن"]
        let answers = question.phoneFields.map { field in
            ChatFieldAnswer(fieldId: field.id, value: FieldAnswers.answer(field, chosen: field.preselected, typed: typed[field.id] ?? ""))
        }
        try check(FieldAnswers.ready(answers.map(\.value)), "the composed answers are ready")
        let fieldsBody = try sorted(ChatSend(text: "", questionId: question.id, answers: answers, images: nil))
        try check(try dictionary(fieldsBody) == (try requestBody("messages-field-answers")), "field answers match the recorded request body")
        try check(try conversation("messages-field-answers").working, "answers start the writer")
        try check(!(try conversation("detail-completed-letter").waiting), "the letter finishes")
        try check(!(try conversation("detail-stopped").waiting), "stopping ends the question")
        if let kind = question.phoneFields.first(where: { $0.id == "kind" }) {
            try check(FieldAnswers.answer(kind, chosen: [0], typed: "بديل") == "بديل", "a typed answer replaces a single choice")
        }

        // 7. The approval card with what the permission gate bound it to.
        let approval = try conversation("detail-approval")
        guard approval.status == ChatStatus.waitingApproval, let gate = approval.approval else { throw CheckFailure(description: "FAILED: the cookie wall waits for approval") }
        try check(gate.target?.hasPrefix("POST ") == true && gate.consequence?.isEmpty == false, "approval names its target and consequence")
        try check(try dictionary(try sorted(ChatApprove(approvalId: gate.id, approved: false))) == (try requestBody("approve-refused")), "approve body matches the recorded request")
        guard let browser = approval.browser, let screen = browser.screen(conversation: approval.id) else { throw CheckFailure(description: "FAILED: the approval shows the browser's screen route") }
        try check(screen.path == "/api/chat/conversations/\(approval.id)/screen" && screen.query.count == 1, "screen route is this conversation's own")
        try check(browser.screen(conversation: created.id) == nil, "another conversation's screen is refused")
        try check(ChatBrowser(url: "https://x.test", title: "", live: true, screenUrl: "https://evil.test/api/chat/conversations/\(approval.id)/screen").screen(conversation: approval.id) == nil, "an absolute screen address is refused")
        try check(!(try conversation("detail-approval-refused").waiting) && !(try conversation("detail-cancelled").waiting), "refusing or cancelling ends the wait")
        let changed = try responseBody("error-approval-changed")
        if case .notDone = SendOutcome.of(ServerFault.error(status: changed.status, data: changed.data)) { checks += 1 } else { throw CheckFailure(description: "FAILED: a stale approval is refused, not retried") }

        // 8. Requests with keys: their bodies, paths and resend rules.
        let create = try PendingRequest.make(.create, conversationId: nil, text: "مرحبا", body: ChatCreate(goal: "مرحبا", images: nil))
        try check(PendingRequest.validKey(create.key) && create.key == create.key.lowercased() && create.key.count == 36, "a fresh key is a lowercase uuid")
        try check(String(data: create.body, encoding: .utf8) == #"{"goal":"مرحبا"}"#, "create body omits empty fields")
        try check(create.path == "/api/chat/conversations" && create.fromComposer && create.belongs(to: nil) && !create.belongs(to: created.id), "create goes to the list route")
        let photo = try PendingRequest.make(.message, conversationId: created.id, text: "", body: ChatSend(text: "", questionId: nil, answers: nil, images: [created.id]))
        try check(String(data: photo.body, encoding: .utf8) == #"{"images":["\#(created.id)"],"text":""}"#, "a photo-only message keeps an empty text")
        try check(photo.path == "/api/chat/conversations/\(created.id)/messages" && photo.belongs(to: created.id), "message path")
        try check(try dictionary(try sorted(ChatSend(text: "و 40 ضرب 3؟", questionId: nil, answers: nil, images: nil))) == (try requestBody("messages-text")), "message body matches the recorded request")
        let option = try PendingRequest.make(.option, conversationId: created.id, text: "توقف", body: ChatRespond(questionId: created.id, optionId: "stop"))
        try check(option.path.hasSuffix("/respond") && !option.fromComposer, "option path")
        let approve = try PendingRequest.make(.approve, conversationId: created.id, text: "موافق", body: ChatApprove(approvalId: created.id, approved: true))
        try check(approve.path.hasSuffix("/approve"), "approve path")
        try check([1, 2, 3, 4, 5, 9].map(PendingRequest.backoff) == [1, 2, 4, 8, 8, 8], "backoff 1, 2, 4, 8 s")
        try check(PendingRequest.validKey("phone-create-0001") && !PendingRequest.validKey("short") && !PendingRequest.validKey("bad key!") && !PendingRequest.validKey(String(repeating: "a", count: 129)), "key rules match the server")
        var saved = photo
        saved.phase = .unconfirmed
        saved.attempts = 3
        let restored = try JSONDecoder().decode(PendingRequest.self, from: try JSONEncoder().encode(saved))
        try check(restored == saved && restored.body == photo.body, "an unconfirmed request survives a restart byte for byte")
        try check(saved.resendable() && !saved.resendable(now: saved.createdAt.addingTimeInterval(13 * 3600)), "only a young request goes again by itself")

        // 9. Windows remote control: the switch's states from real replies.
        let empty = try load("windows-empty", as: WindowsOverview.self).body
        try check(RemoteReadiness.of(empty) == .noDevice, "no PC linked")
        let viewOnly = try load("windows-view-only", as: WindowsOverview.self).body
        try check(RemoteReadiness.of(viewOnly) == .needsLocalControl("Office PC") && !RemoteReadiness.of(viewOnly).canTurnOn, "view allowed, control not")
        let notAllowed = try responseBody("error-windows-control-not-allowed")
        try check(code(ServerFault.error(status: notAllowed.status, data: notAllowed.data)) == "WINDOWS_LOCAL_CONSENT_REQUIRED", "control without local consent is refused")
        let ready = try load("windows-ready", as: WindowsOverview.self).body
        guard case .ready(let device) = RemoteReadiness.of(ready) else { throw CheckFailure(description: "FAILED: the allowed PC is ready") }
        try check(device.name == "Office PC" && RemoteReadiness.of(ready).canTurnOn && !RemoteReadiness.of(ready).on, "ready turns on")
        guard let state = device.state, let target = state.target else { throw CheckFailure(description: "FAILED: ready PC has a target") }
        let grantBody = WindowsGrantRequest(scope: "control", durationSeconds: 120, targetKey: target.key, approvalNonce: state.approvalNonce)
        try check(try dictionary(try sorted(grantBody)) == (try requestBody("windows-grant")), "grant body matches the recorded request")
        let grant = try load("windows-grant", as: WindowsGrant.self).body
        try check(grant.controls && grant.expiry != nil, "grant read with its expiry")
        let active = try load("windows-active", as: WindowsOverview.self).body
        guard case .active(_, let held) = RemoteReadiness.of(active) else { throw CheckFailure(description: "FAILED: the granted PC is active") }
        try check(held == grant && RemoteReadiness.of(active).on, "this session's grant shows as on")
        let frame = try load("windows-frame", as: WindowsFrameReply.self).body
        try check(frame.frame.imageData != nil && UUID(uuidString: frame.frame.id) != nil && frame.grant == grant, "frame is a JPEG under this grant")
        try check(WindowsFrame(id: frame.frame.id, targetKey: target.key, capturedAt: frame.frame.capturedAt, width: 1, height: 1, jpeg: "aGVsbG8gd29ybGQ=").imageData == nil, "a non-JPEG frame is refused")
        let actionBody = try requestBody("windows-action")
        guard let recordedAction = actionBody["action"] as? NSDictionary else { throw CheckFailure(description: "FAILED: recorded action") }
        try check(try dictionary(try sorted(WindowsAction.click(x: 0.5, y: 0.25, right: false))) == recordedAction, "click matches the recorded action")
        try check(try load("windows-action", as: WindowsActionReply.self).body.status == "queued", "action is queued")
        try check(String(data: try sorted(WindowsAction.click(x: 1.4, y: -0.2, right: true)), encoding: .utf8) == #"{"button":"right","type":"click","x":1,"y":0}"#, "click clamps to the frame")
        try check(String(data: try sorted(WindowsAction.scroll(9)), encoding: .utf8) == #"{"delta":3,"type":"scroll"}"#, "scroll clamps to 3")
        try check(String(data: try sorted(WindowsAction.key("Enter")), encoding: .utf8) == #"{"key":"Enter","type":"key"}"#, "key shape")
        try check(String(data: try sorted(WindowsAction.text("مرحبا")), encoding: .utf8) == #"{"text":"مرحبا","type":"text"}"#, "text shape")
        try check(WindowsAction.textFits("a") && WindowsAction.textFits(String(repeating: "ب", count: 120)) && !WindowsAction.textFits("") &&
                  !WindowsAction.textFits(String(repeating: "ب", count: 121)) && !WindowsAction.textFits("a\nb"), "text limits match the server")
        try check(try load("windows-stop", as: OkReply.self).body.ok == true, "stop answers ok")
        try check(try load("windows-stopped", as: WindowsOverview.self).body.devices.first?.grant == nil, "after STOP the session holds no grant")
        let frameGone = try responseBody("error-windows-frame")
        try check(code(ServerFault.error(status: frameGone.status, data: frameGone.data)) == "WINDOWS_FRAME_UNAVAILABLE", "no frame without a grant")
        let pairing = try load("windows-pairing", as: WindowsPairing.self).body
        try check(pairing.code.count == 16 && pairing.code.allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-" || $0 == "_") } && WindowsClock.date(pairing.expiresAt) != nil, "pairing code is 16 characters with an expiry")
        try check(RemoteReadiness.of(WindowsOverview(enabled: false, devices: ready.devices)) == .disabled, "a server with Windows control off")
        let offline = WindowsDevice(id: device.id, name: "Home PC", revoked: false, online: false, lastSeenAt: nil, state: device.state, grant: nil)
        try check(RemoteReadiness.of(WindowsOverview(enabled: true, devices: [offline])) == .offline("Home PC"), "an offline PC")
        let locked = WindowsDevice(id: device.id, name: "Home PC", revoked: false, online: true, lastSeenAt: nil,
                                   state: WindowsState(approvalNonce: state.approvalNonce, safeDesktop: false, localView: true, localControl: true, target: target, status: ""), grant: nil)
        try check(RemoteReadiness.of(WindowsOverview(enabled: true, devices: [locked])) == .unsafe("Home PC"), "a locked PC")
        let revoked = WindowsDevice(id: device.id, name: "Old", revoked: true, online: true, lastSeenAt: nil, state: device.state, grant: nil)
        try check(RemoteReadiness.of(WindowsOverview(enabled: true, devices: [revoked])) == .noDevice, "a revoked PC is not linked")
        let second = WindowsDevice(id: UUID().uuidString.lowercased(), name: "Second", revoked: false, online: true, lastSeenAt: nil, state: device.state, grant: nil)
        try check(RemoteReadiness.device(in: WindowsOverview(enabled: true, devices: [second, device]), preferred: device.id)?.name == "Office PC", "the PC used last stays chosen")
        try check(RemoteReadiness.device(in: WindowsOverview(enabled: true, devices: [offline, second]), preferred: nil)?.name == "Second", "else the first PC online")

        // 10. Replies render Markdown; only https links open.
        let blocks = ReplyMarkdown.blocks("# عنوان\n\n- أ\n- ب\n\n> اقتباس\n\n```\ncode\n```\nنص **عريض**")
        try check(blocks.count == 5 && blocks.first == .heading("عنوان") && blocks[1] == .list(ordered: false, items: ["أ", "ب"]), "markdown blocks")
        let table = "قبل الجدول\r\n| الاسم | الملاحظات |\r\n| :--- | ---: |\r\n| أ | أ \\| ب |\r\n| ج |\r\nبعد الجدول"
        try check(ReplyMarkdown.blocks(table) == [.paragraph("قبل الجدول"), .table(headers: ["الاسم", "الملاحظات"], rows: [["أ", "أ | ب"], ["ج", ""]]), .paragraph("بعد الجدول")], "markdown table keeps cells, surrounding text and escaped pipes")
        try check(ReplyMarkdown.blocks("أ | ب\nهذا | نص") == [.paragraph("أ | ب\nهذا | نص")], "prose with pipes stays a paragraph")
        try check(SafeLink.https("https://example.com/a") != nil && SafeLink.https("http://example.com") == nil && SafeLink.https("https://user@example.com") == nil, "only plain https links open")
        try check(ReplyMarkdown.plainText("[موقع](https://example.com) و **مهم**") == "موقع (https://example.com) و مهم", "plain copy keeps titles and addresses")

        print("cloud checks passed: \(checks)")
    }
}
