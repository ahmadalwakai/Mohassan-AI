import Foundation
import Security

// The phone is a client of the cloud server, like the web: it signs in with the owner's account and calls the
// same /api routes through the web site's origin. Field names follow packages/contracts/src/command-chat.ts and
// packages/windows/src/index.ts; unknown fields are ignored, so newer servers stay readable.

enum WaslaError: LocalizedError {
    case invalidAddress, invalidResponse, signedOut, invalidCredentials
    /// `code` is the server's error code (`CHAT_REQUEST_IN_PROGRESS`, `WINDOWS_LOCAL_CONSENT_REQUIRED`…), when it sent one.
    case storage(OSStatus), server(Int, String, code: String? = nil), message(String)
    var errorDescription: String? {
        switch self {
        case .invalidAddress: return "عنوان الخادم في هذه النسخة غير صالح."
        case .invalidResponse: return "وصل رد غير متوقع من الخادم."
        case .signedOut: return "انتهت جلستك. سجّل الدخول من جديد."
        case .invalidCredentials: return "البريد أو كلمة المرور غير صحيحة."
        case .storage(let code): return "تعذّر حفظ الجلسة في سلسلة المفاتيح (\(code))."
        case .server(_, let message, _), .message(let message): return message
        }
    }
}

/// An https address that is safe to open: no credentials, backslashes or control characters.
/// The links in Mohassan's replies open only through this check.
enum SafeLink {
    static func https(_ value: String) -> URL? {
        guard let components = URLComponents(string: value), components.scheme?.lowercased() == "https",
              let host = components.host, !host.isEmpty, components.user == nil, components.password == nil,
              !value.contains("\\"), !value.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) || CharacterSet.whitespacesAndNewlines.contains($0) }) else { return nil }
        return components.url
    }
}

/// The web site's origin, bundled in ConnectionDefaults.json. The phone calls `<origin>/api/...` with this Origin header.
enum CloudDefaults {
    static let fallback = "https://www.mohassansy.com"
    private struct File: Decodable { let web_origin: String }

    /// https, a host, nothing else: no port, path, query, credentials or escapes.
    static func origin(_ value: String) throws -> URL {
        let clean = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let parts = URLComponents(string: clean), parts.scheme?.lowercased() == "https",
              let host = parts.host, !host.isEmpty, parts.user == nil, parts.password == nil, parts.port == nil,
              parts.query == nil, parts.fragment == nil, parts.path.isEmpty || parts.path == "/",
              !clean.contains("\\"), !clean.contains("%"),
              !clean.unicodeScalars.contains(where: { CharacterSet.whitespacesAndNewlines.contains($0) }) else { throw WaslaError.invalidAddress }
        var normalized = URLComponents()
        normalized.scheme = "https"
        normalized.host = host.lowercased()
        guard let url = normalized.url else { throw WaslaError.invalidAddress }
        return url
    }
    static func decode(_ data: Data) throws -> URL { try origin(JSONDecoder().decode(File.self, from: data).web_origin) }
    static func load(from bundle: Bundle = .main) -> URL {
        if let url = bundle.url(forResource: "ConnectionDefaults", withExtension: "json"), let data = try? Data(contentsOf: url),
           let origin = try? decode(data) { return origin }
        return URL(string: fallback)!
    }
    /// The Origin header the server accepts for changing calls: scheme and host, no trailing slash.
    static func header(_ origin: URL) -> String { "https://" + (origin.host ?? "") }
}

/// The owner's web session: the cookie better-auth sets at sign-in, sent unchanged on every call.
/// The server ties Windows grants to this exact cookie, so it is never rewritten or re-encoded.
struct SessionCookie: Codable, Equatable {
    let name: String
    let value: String
    var header: String { name + "=" + value }

    static let names: Set<String> = ["__Secure-better-auth.session_token", "better-auth.session_token"]
    private static let finder = try! NSRegularExpression(pattern: #"(?:^|[\s,;])((?:__Secure-)?better-auth\.session_token)=([A-Za-z0-9._~%+/=-]+)"#)
    private static let allowed = Set("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._~%+/=-".utf8)

    var valid: Bool { Self.names.contains(name) && (16...4096).contains(value.utf8.count) && value.utf8.allSatisfy { Self.allowed.contains($0) } }

    /// Finds the session cookie in a Set-Cookie value. Several cookies may arrive joined by ", "; a cleared cookie
    /// (`name=; Max-Age=0`) is not a session.
    static func from(setCookie header: String) -> SessionCookie? {
        let source = header as NSString
        for match in finder.matches(in: header, range: NSRange(location: 0, length: source.length)) {
            let cookie = SessionCookie(name: source.substring(with: match.range(at: 1)), value: source.substring(with: match.range(at: 2)))
            if cookie.valid { return cookie }
        }
        return nil
    }
}

struct SignInBody: Encodable { let email: String; let password: String; let rememberMe: Bool }
struct SignInReply: Decodable {
    struct User: Decodable { let email: String?; let name: String? }
    let user: User?
}
struct EmptyBody: Encodable {}
struct OkReply: Decodable { let ok: Bool? }

/// The server's error body: `{"error":{"code","message"}}`, or better-auth's own `{"code","message"}`.
struct ServerFault: Decodable {
    private struct Detail: Decodable { let code: String?; let message: String? }
    private enum Keys: String, CodingKey { case error, code, message }
    let code: String?
    let message: String?
    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: Keys.self)
        let detail = try? container.decodeIfPresent(Detail.self, forKey: .error)
        let flatCode = try? container.decodeIfPresent(String.self, forKey: .code)
        let flatMessage = try? container.decodeIfPresent(String.self, forKey: .message)
        code = detail?.code ?? flatCode
        message = detail?.message ?? flatMessage
    }
    static func error(status: Int, data: Data) -> WaslaError {
        let fault = try? JSONDecoder().decode(ServerFault.self, from: data)
        let fallback = (300...399).contains(status) ? "رفض التطبيق إعادة توجيه الاتصال." : status == 429 ? "طلبات كثيرة في وقت قصير. انتظر قليلًا ثم أعد المحاولة." : "تعذّر إكمال الطلب (\(status))."
        let sent = fault?.message ?? ""
        let message = sent.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? fallback : sent
        return .server(status, message, code: fault?.code)
    }
}

// MARK: - The chat (/api/chat/*)

enum ChatStatus {
    static let idle = "idle"
    static let running = "running"
    static let waitingUser = "waiting_user"
    static let waitingInput = "waiting_input"
    static let waitingApproval = "waiting_approval"
    static let failed = "failed"
    static let cancelled = "cancelled"
    static func title(_ status: String) -> String {
        switch status {
        case running: return "موحسن يعمل…"
        case waitingUser: return "ينتظر إجابتك"
        case waitingInput: return "ينتظر خطوة منك"
        case waitingApproval: return "ينتظر موافقتك"
        case failed: return "تعذّر الإكمال"
        case cancelled: return "أُوقف"
        default: return "جاهز"
        }
    }
}
struct ChatOption: Codable, Identifiable, Hashable { let id: String; let label: String }
/// One suggested answer, taken by the brain from the owner's own site or sentence.
struct ChatSuggestion: Decodable, Hashable { let label: String; let reason: String? }
/// One of several questions asked together (ChatQuestionFieldSchema).
struct ChatField: Decodable, Identifiable {
    let id: String
    let prompt: String
    let suggestions: [ChatSuggestion]
    let multiple: Bool?
    let multiline: Bool?
    let initialValue: String?
    let selected: [Int]?
    let placeholder: String?
    var allowsSeveral: Bool { multiple == true }
    var keepsLines: Bool { multiline == true }
    /// The suggestions the brain is confident in, chosen in advance; indexes out of range are ignored.
    var preselected: Set<Int> { Set((selected ?? []).filter { suggestions.indices.contains($0) }) }
}
struct ChatQuestion: Decodable {
    let id: String
    let prompt: String
    let options: [ChatOption]
    let action: String?
    /// Several questions in one card; the answers go back together, with this question's id.
    let fields: [ChatField]?
    /// Google's consent page opens on the web; that one option stays there.
    var phoneOptions: [ChatOption] { action == "google_ads_connect" ? options.filter { $0.id != "connect" } : options }
    var phoneFields: [ChatField] { fields ?? [] }
    /// The «stop» option a field card offers beside its questions.
    var stopOption: ChatOption? { options.first { $0.id == "stop" } }
}
struct ChatApproval: Decodable {
    let id: String
    let prompt: String
    let detail: String
    /// What the server's permission gate bound this approval to; absent from older servers.
    let target: String?
    let consequence: String?
    let reversible: Bool?
}
struct ChatSecureField: Decodable, Identifiable { let id: String; let label: String; let type: String }
/// A credential or a step for the owner's own hands. Values go straight to the page; the model never sees them.
struct ChatSecure: Decodable {
    let id: String
    let kind: String
    let site: String
    let prompt: String
    let note: String?
    let fields: [ChatSecureField]
    var handsOn: Bool { kind == "hands_on" }
}
struct ChatImageRef: Decodable, Identifiable, Hashable { let id: String; let width: Int; let height: Int }
struct ChatMessage: Decodable, Identifiable {
    let id: String
    let role: String
    let text: String
    let createdAt: String?
    let images: [ChatImageRef]?
    var mine: Bool { role == "user" }
}
struct ChatStep: Decodable, Identifiable { let id: String; let text: String }
/// The browser the brain works in, on the server. `screenUrl` is a path on this site.
struct ChatBrowser: Decodable {
    let url: String
    let title: String
    let live: Bool
    let screenUrl: String
    /// The screenshot's path and query, only when it is this conversation's own screen route.
    func screen(conversation: String) -> (path: String, query: [URLQueryItem])? {
        guard let parts = URLComponents(string: screenUrl), parts.scheme == nil, parts.host == nil,
              parts.path == "/api/chat/conversations/\(conversation)/screen" else { return nil }
        return (parts.path, (parts.queryItems ?? []).filter { $0.name == "v" })
    }
    var host: String { URLComponents(string: url)?.host ?? url }
}
/// What this account can do without a language model (ChatCapabilitiesSchema).
struct ChatCapabilities: Decodable, Equatable {
    let chatModel: Bool
    let available: [String]
    static let labels: [String: String] = [
        "computation": "الحساب", "web": "البحث في الويب", "browser": "فتح الصفحات وقراءتها", "memory": "الذاكرة", "knowledge": "مستنداتك المحفوظة",
        "documents": "ملفات PDF", "sites": "بناء المواقع", "skills": "المهارات المفعّلة", "planner": "تخطيط الأسبوع", "letters": "قوالب الرسائل",
        "imageReading": "قراءة النص في الصور", "ads": "إعلانات Google", "pc": "التحكم بالكمبيوتر",
    ]
    /// The web's banner when no language model is connected; nil when one is.
    var localModeText: String? {
        guard !chatModel else { return nil }
        let names = available.compactMap { Self.labels[$0] }
        let head = "لا يتصل بهذه الجلسة نموذج لغوي، فالردود الحرة غير متاحة."
        return names.isEmpty ? head : head + " ما يعمل الآن دون نموذج: " + names.joined(separator: "، ") + "."
    }
}
struct ChatSummary: Decodable, Identifiable { let id: String; let title: String; let status: String; let updatedAt: String }
struct ChatList: Decodable {
    let conversations: [ChatSummary]
    let capabilities: ChatCapabilities?
    /// The server honours an Idempotency-Key on its changing routes, so a resend with the same key runs once.
    let requestKeys: Bool?
}
struct ChatConversation: Decodable, Identifiable {
    let id: String
    let title: String
    let status: String
    let updatedAt: String
    let messages: [ChatMessage]
    let question: ChatQuestion?
    let approval: ChatApproval?
    let secure: ChatSecure?
    let browser: ChatBrowser?
    let progress: String?
    let steps: [ChatStep]
    let error: String?
    let capabilities: ChatCapabilities?
    /// A mark of this view; `?since=<version>&wait=<ms>` answers once it changes. Absent from older servers.
    let version: String?
    let olderMessages: Int?
    var working: Bool { status == ChatStatus.running }
    /// A card answers the assistant now: a question, an approval or a secure step.
    var waiting: Bool { [ChatStatus.waitingUser, ChatStatus.waitingApproval, ChatStatus.waitingInput].contains(status) }
    /// The several-questions card, when the assistant waits for it.
    var fieldsQuestion: ChatQuestion? {
        guard status == ChatStatus.waitingUser, let question, !question.phoneFields.isEmpty else { return nil }
        return question
    }
}
struct ChatCreate: Encodable { let goal: String?; let images: [String]? }
struct ChatFieldAnswer: Codable, Equatable { let fieldId: String; let value: String }
struct ChatSend: Encodable { let text: String; let questionId: String?; let answers: [ChatFieldAnswer]?; let images: [String]? }
struct ChatRespond: Encodable { let questionId: String; let optionId: String }
struct ChatApprove: Encodable { let approvalId: String; let approved: Bool }
struct ChatSecureSubmit: Encodable { let requestId: String; let action: String; let values: [String: String]? }
struct ChatFeedback: Encodable { let messageId: String; let verdict: String }
struct ChatImageUpload: Encodable { let mimeType: String; let data: String }
struct ChatImageAvailability: Decodable { let available: Bool }
struct ChatImageUploaded: Decodable { let id: String; let width: Int; let height: Int }
/// A photo the owner attached, uploaded and waiting to go with the next message.
struct ChatAttachment: Codable, Equatable, Identifiable { let id: String; let preview: Data }

// MARK: - Requests with keys
// Every create, message, answer and approval carries a fresh Idempotency-Key. The server runs at most one effect per
// key: a resend after a lost reply returns the first result instead of running the work twice.

/// One changing request as it was sent: its key, where it went and its exact body, so the very same request can go again.
struct PendingRequest: Codable, Equatable {
    enum Kind: String, Codable { case create, message, fields, option, approve }
    enum Phase: String, Codable {
        /// On its way, or being sent again with the same key.
        case sending
        /// The reply was lost and the phone stopped trying: it may or may not have happened.
        case unconfirmed
    }
    let key: String
    let kind: Kind
    /// The conversation it goes to; nil for a new conversation.
    let conversationId: String?
    /// What the owner sent, as the screen shows it.
    let text: String
    /// The JSON body exactly as first sent.
    let body: Data
    var attachments: [ChatAttachment]
    var phase: Phase
    var attempts: Int
    var note: String?
    /// When it was first sent. The server keeps keys for a day, so only a younger request may go again by itself.
    let createdAt: Date

    static func make<Body: Encodable>(_ kind: Kind, conversationId: String?, text: String, attachments: [ChatAttachment] = [], body: Body) throws -> PendingRequest {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        return PendingRequest(key: UUID().uuidString.lowercased(), kind: kind, conversationId: conversationId, text: text,
                              body: try encoder.encode(body), attachments: attachments, phase: .sending, attempts: 0, note: nil, createdAt: Date())
    }
    var path: String {
        let conversation = "/api/chat/conversations/" + (conversationId ?? "")
        switch kind {
        case .create: return "/api/chat/conversations"
        case .message, .fields: return conversation + "/messages"
        case .option: return conversation + "/respond"
        case .approve: return conversation + "/approve"
        }
    }
    /// The composer's own text, which comes back to the box when the server refuses it.
    var fromComposer: Bool { kind == .create || kind == .message }
    /// Whether it belongs to what the screen shows: the new-chat screen, or that conversation.
    func belongs(to current: String?) -> Bool { kind == .create ? current == nil : conversationId == current }
    /// Young enough to go again by itself: well inside the day the server keeps its key.
    func resendable(now: Date = Date()) -> Bool { now.timeIntervalSince(createdAt) < 12 * 3600 }
    /// Seconds before the next automatic resend with the same key: 1, 2, 4, 8.
    static func backoff(_ attempt: Int) -> Int { 1 << min(max(attempt - 1, 0), 3) }
    /// The Idempotency-Key the server accepts: 8–128 of a–z, A–Z, 0–9, '-' and '_'.
    static func validKey(_ key: String) -> Bool {
        (8...128).contains(key.utf8.count) && key.utf8.allSatisfy { (48...57).contains($0) || (65...90).contains($0) || (97...122).contains($0) || $0 == 45 || $0 == 95 }
    }
}

/// What a failed call means for its request. Only a refusal, or a call that never left the phone, proves that
/// nothing happened; anything else may have reached the server, and only the same key can be sent again.
enum SendOutcome: Equatable {
    case signedOut
    /// Refused, or never sent: nothing happened. The reason is the owner's to read.
    case notDone(String)
    /// The first call with this key is still running on the server.
    case inProgress(String)
    /// It may have reached the server.
    case unknown(String)

    static func of(_ error: Error) -> SendOutcome {
        if let failure = error as? WaslaError {
            switch failure {
            case .signedOut: return .signedOut
            case .server(let status, let message, let code):
                if status == 409, code == "CHAT_REQUEST_IN_PROGRESS" { return .inProgress(message) }
                if (400...499).contains(status), status != 408, status != 499 { return .notDone(message) }
                return .unknown(message)
            case .invalidAddress, .invalidCredentials, .storage: return .notDone(failure.localizedDescription)
            case .invalidResponse, .message: return .unknown(failure.localizedDescription)
            }
        }
        if let failure = error as? URLError {
            // No connection or no trusted handshake: the request itself was never sent.
            let neverSent: [URLError.Code] = [.cannotConnectToHost, .cannotFindHost, .notConnectedToInternet, .dnsLookupFailed,
                                              .internationalRoamingOff, .dataNotAllowed, .callIsActive, .secureConnectionFailed,
                                              .serverCertificateUntrusted, .serverCertificateHasBadDate, .serverCertificateNotYetValid,
                                              .serverCertificateHasUnknownRoot, .clientCertificateRejected, .badURL, .unsupportedURL, .appTransportSecurityRequiresSecureConnection]
            if neverSent.contains(failure.code) { return .notDone("تعذّر الوصول إلى الخادم، فلم يُرسل الطلب.") }
            return .unknown("انقطع الاتصال قبل وصول الرد.")
        }
        return .unknown("وصل رد غير متوقع.")
    }
}

/// Composes the answers of a field card exactly as the web's QuestionPanel does.
enum FieldAnswers {
    /// One field's answer: the chosen suggestions in their order, and the typed text. In a
    /// single-answer field a typed answer replaces the choice; a multi-line answer keeps its lines.
    static func answer(_ field: ChatField, chosen: Set<Int>, typed supplied: String) -> String {
        let picked = chosen.sorted().compactMap { field.suggestions.indices.contains($0) ? field.suggestions[$0].label : nil }
        let typed = field.keepsLines ? supplied : supplied.trimmingCharacters(in: .whitespacesAndNewlines)
        let hasTyped = !typed.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        let parts = field.allowsSeveral ? picked + (hasTyped ? [typed] : []) : (hasTyped ? [typed] : picked)
        return parts.joined(separator: ", ")
    }
    /// The length the server counts: the answers, and for several the «1. » numbers and line breaks.
    static func length(_ answers: [String]) -> Int {
        answers.reduce(0) { $0 + $1.utf16.count } + (answers.count > 1 ? answers.count * 4 - 1 : 0)
    }
    static let limit = 4_000
    static func ready(_ answers: [String]) -> Bool {
        !answers.isEmpty && answers.allSatisfy { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty } && length(answers) <= limit
    }
}

// MARK: - Reply text: the web's Markdown subset (apps/web/components/markdown.tsx)

/// Headings, lists, quotes, fenced code, pipe tables, bold, inline code and links in a chat reply.
/// Only https links become tappable, and they open inside the app.
@available(iOS 15.0, macOS 12.0, *)
enum ReplyMarkdown {
    enum Block: Equatable {
        case paragraph(String)
        case heading(String)
        case quote([String])
        case list(ordered: Bool, items: [String])
        case code(String)
        case table(headers: [String], rows: [[String]])
    }

    private static let orderedItem = #"^\s*\d+[.)]\s+"#
    private static let bulletItem = #"^\s*[-+*•]\s+"#
    private static let quoteLine = #"^\s*>"#
    private static let headingLine = #"^#{1,6}\s+\S"#
    private static let tableRule = #"^:?-+:?$"#

    private static func matches(_ line: String, _ pattern: String) -> Bool { line.range(of: pattern, options: .regularExpression) != nil }
    private static func blank(_ line: String) -> Bool { line.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    private static func fence(_ line: String) -> Bool { line.drop(while: { $0 == " " || $0 == "\t" }).hasPrefix("```") }

    static func blocks(_ text: String) -> [Block] {
        let lines = text.replacingOccurrences(of: "\r\n", with: "\n").components(separatedBy: "\n")
        var blocks: [Block] = []
        var index = 0
        while index < lines.count {
            let line = lines[index]
            if blank(line) { index += 1; continue }
            if fence(line) {
                var code: [String] = []
                index += 1
                while index < lines.count, !fence(lines[index]) { code.append(lines[index]); index += 1 }
                index += 1
                blocks.append(.code(code.joined(separator: "\n")))
                continue
            }
            if matches(line, headingLine) {
                blocks.append(.heading(line.replacingOccurrences(of: #"^#{1,6}\s+"#, with: "", options: .regularExpression)))
                index += 1
                continue
            }
            if matches(line, quoteLine) {
                var quoted: [String] = []
                while index < lines.count, matches(lines[index], quoteLine) {
                    quoted.append(lines[index].replacingOccurrences(of: #"^\s*>\s?"#, with: "", options: .regularExpression)); index += 1
                }
                // Blank lines (spaces allowed) separate the quote's paragraphs.
                let parts = quoted.joined(separator: "\n").replacingOccurrences(of: #"\n\s*\n"#, with: "\u{0}", options: .regularExpression)
                    .components(separatedBy: "\u{0}").map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }
                blocks.append(.quote(parts))
                continue
            }
            if matches(line, orderedItem) || matches(line, bulletItem) {
                let pattern = matches(line, orderedItem) ? orderedItem : bulletItem
                var items: [String] = []
                while index < lines.count, matches(lines[index], pattern) {
                    items.append(lines[index].replacingOccurrences(of: pattern, with: "", options: .regularExpression)); index += 1
                }
                blocks.append(.list(ordered: pattern == orderedItem, items: items))
                continue
            }
            if let headers = tableHeader(lines, at: index) {
                var rows: [[String]] = []
                index += 2
                while index < lines.count, !startsBlock(lines[index]),
                      let cells = tableCells(lines[index]), cells.count <= headers.count {
                    rows.append(cells + Array(repeating: "", count: headers.count - cells.count))
                    index += 1
                }
                blocks.append(.table(headers: headers, rows: rows))
                continue
            }
            // A paragraph runs to the next blank line or block; it always takes at least this line.
            var paragraph = [line]
            index += 1
            while index < lines.count, !blank(lines[index]), !startsBlock(lines[index]), tableHeader(lines, at: index) == nil {
                paragraph.append(lines[index]); index += 1
            }
            blocks.append(.paragraph(paragraph.joined(separator: "\n")))
        }
        return blocks
    }

    private static func startsBlock(_ line: String) -> Bool {
        fence(line) || matches(line, headingLine) || matches(line, orderedItem) || matches(line, bulletItem) || matches(line, quoteLine)
    }

    private static func tableHeader(_ lines: [String], at index: Int) -> [String]? {
        guard index + 1 < lines.count, let header = tableCells(lines[index]), header.contains(where: { !$0.isEmpty }),
              let rules = tableCells(lines[index + 1]), rules.count == header.count,
              rules.allSatisfy({ matches($0, tableRule) }) else { return nil }
        return header
    }

    private static func tableCells(_ line: String) -> [String]? {
        guard line.contains("|") else { return nil }
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        var cells: [String] = []
        var cell = ""
        var escaped = false
        for character in trimmed {
            if escaped {
                if character != "|" { cell.append("\\") }
                cell.append(character)
                escaped = false
            } else if character == "\\" {
                escaped = true
            } else if character == "|" {
                cells.append(cell.trimmingCharacters(in: .whitespaces))
                cell = ""
            } else {
                cell.append(character)
            }
        }
        guard !cells.isEmpty else { return nil }
        if escaped { cell.append("\\") }
        if !cell.isEmpty { cells.append(cell.trimmingCharacters(in: .whitespaces)) }
        if trimmed.first == "|" { cells.removeFirst() }
        return cells.isEmpty ? nil : cells
    }

    private static let inlinePattern = try! NSRegularExpression(pattern: #"(\*\*[^*\n]+\*\*|`[^`\n]+`|\[[^\]\n]+\]\(https?://[^\s)]+\)|https?://[^\s<>()]+[^\s<>().,،])"#)
    private static let titledLink = try! NSRegularExpression(pattern: #"^\[([^\]]+)\]\((https?://[^\s)]+)\)$"#)

    /// One line or paragraph with bold, code and links.
    static func inline(_ text: String) -> AttributedString {
        let source = text as NSString
        var out = AttributedString()
        var cursor = 0
        for match in inlinePattern.matches(in: text, range: NSRange(location: 0, length: source.length)) {
            if match.range.location > cursor { out.append(AttributedString(source.substring(with: NSRange(location: cursor, length: match.range.location - cursor)))) }
            out.append(token(source.substring(with: match.range)))
            cursor = match.range.location + match.range.length
        }
        if cursor < source.length { out.append(AttributedString(source.substring(from: cursor))) }
        return out
    }

    private static func token(_ part: String) -> AttributedString {
        if part.hasPrefix("**"), part.hasSuffix("**"), part.count > 4 {
            var run = AttributedString(String(part.dropFirst(2).dropLast(2)))
            run.inlinePresentationIntent = .stronglyEmphasized
            return run
        }
        if part.hasPrefix("`"), part.hasSuffix("`"), part.count > 2 {
            var run = AttributedString(String(part.dropFirst().dropLast()))
            run.inlinePresentationIntent = .code
            return run
        }
        let source = part as NSString
        if let link = titledLink.firstMatch(in: part, range: NSRange(location: 0, length: source.length)) {
            return linked(title: source.substring(with: link.range(at: 1)), address: source.substring(with: link.range(at: 2)))
        }
        if part.hasPrefix("https://") || part.hasPrefix("http://") { return linked(title: nil, address: part) }
        return AttributedString(part)
    }

    /// An https link shows its title (or a short readable address) and opens; any other address stays plain text, in full.
    private static func linked(title: String?, address: String) -> AttributedString {
        guard let url = SafeLink.https(address) else {
            return AttributedString(title.map { "\($0) (\(address))" } ?? address)
        }
        var run = AttributedString(title ?? shortLink(address))
        run.link = url
        return run
    }

    /// A bare address as people read it: the site and the decoded page name, never %D8%A7…
    static func shortLink(_ address: String) -> String {
        guard let parts = URLComponents(string: address), let host = parts.host, !host.isEmpty else {
            return address.count > 50 ? String(address.prefix(49)) + "…" : address
        }
        let site = host.lowercased().hasPrefix("www.") ? String(host.dropFirst(4)) : host
        guard let last = parts.percentEncodedPath.split(separator: "/").last.map(String.init), !last.isEmpty else { return site }
        let name = (last.removingPercentEncoding ?? last)
            .replacingOccurrences(of: "_", with: " ").replacingOccurrences(of: "+", with: " ")
            .replacingOccurrences(of: #"\.(html?|php|aspx?)$"#, with: "", options: [.regularExpression, .caseInsensitive])
        return "\(site) › \(name.count > 40 ? String(name.prefix(39)) + "…" : name)"
    }

    /// While a field card holds the questions, the message above it need not list them again: drops the
    /// block a line ending in ":" opens, up to the next blank line. A "- " list after the colon is a
    /// summary, not questions, and stays (withoutQuestionList in apps/web/components/question-card.tsx).
    static func withoutQuestionList(_ text: String) -> String {
        let lines = text.components(separatedBy: "\n")
        func trimmed(_ index: Int) -> String { lines[index].trimmingCharacters(in: .whitespacesAndNewlines) }
        guard let start = lines.indices.first(where: { index in
            index + 1 < lines.count && trimmed(index).hasSuffix(":") && !trimmed(index + 1).isEmpty && !trimmed(index + 1).hasPrefix("- ")
        }) else { return text }
        var end = start + 1
        while end < lines.count, !trimmed(end).isEmpty { end += 1 }
        let kept = Array(lines[..<start]) + Array(lines[min(end + 1, lines.count)...])
        return kept.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// The reply as plain text for the clipboard: no ** or >, links as «title (address)».
    static func plainText(_ text: String) -> String {
        let unquoted = text.components(separatedBy: "\n").map { $0.replacingOccurrences(of: #"^\s*>\s?"#, with: "", options: .regularExpression) }.joined(separator: "\n")
        return unquoted
            .replacingOccurrences(of: #"\[([^\]\n]+)\]\((https?://[^\s)]+)\)"#, with: "$1 ($2)", options: .regularExpression)
            .replacingOccurrences(of: #"\*\*([^*\n]+)\*\*"#, with: "$1", options: .regularExpression)
            .replacingOccurrences(of: #"\n{3,}"#, with: "\n\n", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

// MARK: - Windows remote control (/api/windows/*)
// The Windows companion on the PC sends its live state; a short grant from this session lets the owner (and
// Mohassan, when the owner chats from this phone) see and control the one window the owner allowed on the PC.

struct WindowsTarget: Decodable, Equatable { let key: String; let mode: String; let title: String; let width: Int; let height: Int }
struct WindowsState: Decodable, Equatable {
    let approvalNonce: String
    let safeDesktop: Bool
    let localView: Bool
    let localControl: Bool
    let target: WindowsTarget?
    let status: String
}
struct WindowsGrant: Decodable, Equatable {
    let id: String
    let scope: String
    let targetKey: String
    let approvalNonce: String
    let expiresAt: String
    var controls: Bool { scope == "control" }
    var expiry: Date? { WindowsClock.date(expiresAt) }
}
struct WindowsDevice: Decodable, Identifiable, Equatable {
    let id: String
    let name: String
    let revoked: Bool
    let online: Bool
    let lastSeenAt: String?
    let state: WindowsState?
    /// This session's grant, when it is valid now.
    let grant: WindowsGrant?
}
struct WindowsOverview: Decodable, Equatable { let enabled: Bool; let devices: [WindowsDevice] }
struct WindowsPairing: Decodable, Equatable { let id: String; let code: String; let expiresAt: String }
struct WindowsGrantRequest: Encodable { let scope: String; let durationSeconds: Int; let targetKey: String; let approvalNonce: String }
struct WindowsFrame: Decodable {
    let id: String
    let targetKey: String
    let capturedAt: String
    let width: Int
    let height: Int
    let jpeg: String
    /// The JPEG bytes, only when they start and end like a JPEG.
    var imageData: Data? {
        guard let data = Data(base64Encoded: jpeg), data.count >= 4 else { return nil }
        let bytes = [UInt8](data)
        guard bytes[0] == 0xFF, bytes[1] == 0xD8, bytes[bytes.count - 2] == 0xFF, bytes[bytes.count - 1] == 0xD9 else { return nil }
        return data
    }
}
struct WindowsFrameReply: Decodable { let frame: WindowsFrame; let grant: WindowsGrant }
/// One input on the allowed window. Coordinates are 0…1 of the frame.
enum WindowsAction: Encodable, Equatable {
    case click(x: Double, y: Double, right: Bool)
    case text(String)
    case key(String)
    case scroll(Int)
    private enum Keys: String, CodingKey { case type, x, y, button, text, key, delta }
    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: Keys.self)
        switch self {
        case .click(let x, let y, let right):
            try container.encode("click", forKey: .type)
            try container.encode(min(1, max(0, x)), forKey: .x)
            try container.encode(min(1, max(0, y)), forKey: .y)
            try container.encode(right ? "right" : "left", forKey: .button)
        case .text(let value):
            try container.encode("text", forKey: .type)
            try container.encode(value, forKey: .text)
        case .key(let value):
            try container.encode("key", forKey: .type)
            try container.encode(value, forKey: .key)
        case .scroll(let delta):
            try container.encode("scroll", forKey: .type)
            try container.encode(min(3, max(-3, delta)), forKey: .delta)
        }
    }
    /// The server takes 1–120 characters with no control characters per text input.
    static func textFits(_ value: String) -> Bool {
        (1...120).contains(value.count) && !value.unicodeScalars.contains { $0.value < 0x20 || $0.value == 0x7F }
    }
    static let keys = ["Enter", "Tab", "Escape", "Backspace", "Delete", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown", "Space"]
}
struct WindowsActionRequest: Encodable { let grantId: String; let nonce: String; let frameId: String; let action: WindowsAction }
struct WindowsActionReply: Decodable { let id: String; let status: String }

enum WindowsClock {
    static func date(_ value: String) -> Date? {
        let precise = ISO8601DateFormatter()
        precise.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = precise.date(from: value) { return date }
        let plain = ISO8601DateFormatter()
        plain.formatOptions = [.withInternetDateTime]
        return plain.date(from: value)
    }
}

/// Where remote control of the PC stands for this session, from one GET /api/windows. The toggle shows it.
enum RemoteReadiness: Equatable {
    /// The server has Windows control switched off.
    case disabled
    /// No PC is linked to this account.
    case noDevice
    /// The PC's companion is not connected now.
    case offline(String)
    /// The PC is locked or on a protected screen.
    case unsafe(String)
    /// The owner has not allowed viewing a window on the PC.
    case needsLocalView(String)
    /// Viewing is allowed on the PC, control is not.
    case needsLocalControl(String)
    /// Everything is allowed on the PC; this session holds no control grant.
    case ready(WindowsDevice)
    /// This session controls the PC now.
    case active(WindowsDevice, WindowsGrant)

    /// The device the phone works with: the one it used last when still linked, else the first one online.
    static func device(in overview: WindowsOverview, preferred: String?) -> WindowsDevice? {
        let linked = overview.devices.filter { !$0.revoked }
        if let preferred, let match = linked.first(where: { $0.id == preferred }) { return match }
        return linked.first(where: { $0.online }) ?? linked.first
    }

    static func of(_ overview: WindowsOverview, preferred: String? = nil) -> RemoteReadiness {
        guard overview.enabled else { return .disabled }
        guard let device = device(in: overview, preferred: preferred) else { return .noDevice }
        guard device.online else { return .offline(device.name) }
        guard let state = device.state, state.safeDesktop else { return .unsafe(device.name) }
        guard state.localView, state.target != nil else { return .needsLocalView(device.name) }
        guard state.localControl else { return .needsLocalControl(device.name) }
        if let grant = device.grant, grant.controls { return .active(device, grant) }
        return .ready(device)
    }

    var on: Bool { if case .active = self { return true }; return false }
    var canTurnOn: Bool {
        switch self {
        case .ready, .active: return true
        default: return false
        }
    }
    var title: String {
        switch self {
        case .disabled: return "التحكم بـ Windows متوقف على الخادم"
        case .noDevice: return "لا يوجد كمبيوتر مرتبط"
        case .offline(let name): return "\(name) غير متصل الآن"
        case .unsafe(let name): return "\(name) مقفل أو على شاشة محمية"
        case .needsLocalView(let name), .needsLocalControl(let name): return "يلزم السماح على \(name)"
        case .ready(let device): return "جاهز: \(device.name)"
        case .active(let device, _): return "التحكم مفعّل: \(device.name)"
        }
    }
    var advice: String {
        switch self {
        case .disabled: return "يُفعَّل من إعدادات الخادم (WINDOWS_REMOTE_ENABLED=true)."
        case .noDevice: return "اضغط «ربط كمبيوتر»، ثم ألصق الرمز في برنامج Mohassan Companion على الكمبيوتر خلال دقيقتين."
        case .offline: return "شغّل Mohassan Companion على الكمبيوتر وتأكد من اتصاله بالإنترنت."
        case .unsafe: return "افتح قفل الكمبيوتر. يتوقف التحكم تلقائيًا عند القفل، ويلزم السماح من جديد بعده."
        case .needsLocalView: return "في Mohassan Companion على الكمبيوتر اختر النافذة، ثم فعّل «أوافق محليًا على مشاهدة النطاق المحدد» و«أوافق محليًا على الإدخال ضمن هذا النطاق»."
        case .needsLocalControl: return "في Mohassan Companion فعّل «أوافق محليًا على الإدخال ضمن هذا النطاق»."
        case .ready: return "شغّل المفتاح ليتحكم هذا الهاتف وموحسن بالنافذة المسموحة على الكمبيوتر."
        case .active: return "يتجدد الإذن كل دقيقتين ما دام المفتاح مشغّلًا والتطبيق مفتوحًا. الإيقاف يلغي التحكم فورًا."
        }
    }
}
