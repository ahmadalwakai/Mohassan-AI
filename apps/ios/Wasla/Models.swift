import Foundation
import Security

enum WaslaError: LocalizedError {
    case invalidAddress, invalidFingerprint, invalidPairingCode, invalidResponse
    /// `code` is the computer's or Mohassan's error code (`CHAT_BUSY`, `CLIENT_REQUEST_UNKNOWN`…), when it sent one.
    case notPaired, certificate, storage(OSStatus), server(Int, String, code: String? = nil), message(String)
    var errorDescription: String? {
        switch self {
        case .invalidAddress: return "أدخل عنوان HTTPS فقط، دون اسم مستخدم أو مسار أو معاملات إضافية."
        case .invalidFingerprint: return "بصمة الشهادة يجب أن تتكون من 64 حرفًا من الأرقام والحروف a–f. انسخها من شاشة الكمبيوتر الموثوقة."
        case .invalidPairingCode: return "أدخل رمز الربط من ٨ أرقام كما يظهر على الكمبيوتر."
        case .invalidResponse: return "وصل رد غير متوقع من الكمبيوتر."
        case .notPaired: return "اربط الكمبيوتر أولًا."
        case .certificate: return "تعذّر التحقق من هوية الكمبيوتر أو صلاحية شهادته. راجع العنوان والبصمة والوقت على الجهازين."
        case .storage(let code): return "تعذّر حفظ بيانات الاقتران في سلسلة المفاتيح (\(code))."
        case .server(_, let message, _), .message(let message): return message
        }
    }
}

/// An https address that is safe to open: no credentials, backslashes or control characters.
/// Search results and the links in Mohassan's replies open only through this check.
enum SafeLink {
    static func https(_ value: String) -> URL? {
        guard let components = URLComponents(string: value), components.scheme?.lowercased() == "https",
              let host = components.host, !host.isEmpty, components.user == nil, components.password == nil,
              !value.contains("\\"), !value.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) || CharacterSet.whitespacesAndNewlines.contains($0) }) else { return nil }
        return components.url
    }
}

struct ServerIdentity: Codable, Sendable {
    let baseURL: URL
    let fingerprint: String
    let deviceID: String
    let name: String

    static func validate(address: String, fingerprint: String, deviceID: String = "", name: String = "الكمبيوتر") throws -> ServerIdentity {
        let clean = address.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let parts = URLComponents(string: clean), parts.scheme?.lowercased() == "https",
              let host = parts.host, !host.isEmpty, parts.user == nil, parts.password == nil,
              parts.query == nil, parts.fragment == nil, parts.path.isEmpty || parts.path == "/",
              !clean.contains("\\"), !clean.contains("%"),
              !clean.unicodeScalars.contains(where: { CharacterSet.whitespacesAndNewlines.contains($0) }),
              parts.port == nil || (1...65535).contains(parts.port!), let url = parts.url else { throw WaslaError.invalidAddress }
        let pin = fingerprint.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard pin.utf8.count == 64, pin.utf8.allSatisfy({ (48...57).contains($0) || (97...102).contains($0) }) else { throw WaslaError.invalidFingerprint }
        var normalized = parts
        normalized.scheme = "https"
        normalized.path = ""
        return ServerIdentity(baseURL: normalized.url ?? url, fingerprint: pin, deviceID: deviceID, name: name)
    }
}

struct BundledConnection: Decodable {
    let server_url: String
    let certificate_sha256: String
    let computer_name: String

    static func load(from bundle: Bundle = .main) -> ServerIdentity? {
        guard let url = bundle.url(forResource: "ConnectionDefaults", withExtension: "json"),
              let data = try? Data(contentsOf: url) else { return nil }
        return try? decodeIdentity(from: data)
    }

    static func decodeIdentity(from data: Data) throws -> ServerIdentity {
        let settings = try JSONDecoder().decode(Self.self, from: data)
        return try ServerIdentity.validate(address: settings.server_url, fingerprint: settings.certificate_sha256, name: settings.computer_name)
    }
}

enum PairingCode {
    private static let localizedDigits = Dictionary(uniqueKeysWithValues: zip("٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹", "01234567890123456789"))

    static func normalized(_ value: String) -> String {
        String(value.trimmingCharacters(in: .whitespacesAndNewlines).map { localizedDigits[$0] ?? $0 })
    }

    static func isValid(_ value: String) -> Bool {
        let code = normalized(value)
        if code.utf8.count == 8, code.utf8.allSatisfy({ (48...57).contains($0) }) { return true }
        return (16...512).contains(code.utf8.count) && code.utf8.allSatisfy { (33...126).contains($0) }
    }
}

struct PairRequest: Encodable { let code: String; let device_name: String }
struct PairResponse: Decodable { let token: String; let device_id: String; let name: String }
struct EmptyBody: Encodable {}
struct EmptyResponse: Decodable {}
struct ServerFault: Decodable { struct Detail: Decodable { let code: String; let message: String }; let error: Detail }

enum BusyState: Decodable {
    case idle, working(String)
    init(from decoder: Decoder) throws {
        let value = try decoder.singleValueContainer()
        if value.decodeNil() { self = .idle }
        else if let flag = try? value.decode(Bool.self) { self = flag ? .working("الجهاز مشغول") : .idle }
        else if let name = try? value.decode(String.self) { self = name.isEmpty ? .idle : .working(name) }
        else { self = .working("الجهاز مشغول") }
    }
    var isBusy: Bool { if case .idle = self { return false }; return true }
    var label: String { if case .working(let name) = self { return name }; return "جاهز" }
}
struct DesktopInfo: Decodable { let width: Int; let height: Int; let monitor: String?; let error: String? }
/// One function the computer can or cannot offer right now, with the reason when it cannot.
struct CapabilityState: Decodable {
    let ready: Bool
    let reason: String?
    let code: String?
}
/// Absent on older computer services; each key is absent when the service does not know.
struct ServerCapabilities: Decodable {
    let chat: CapabilityState?
    let search: CapabilityState?
    let images: CapabilityState?
    let desktop: CapabilityState?
}
struct ServerStatus: Decodable {
    let name: String
    let model: String
    let busy: BusyState
    let desktop_enabled: Bool
    let desktop: DesktopInfo?
    let app_actions_enabled: Bool?
    let capabilities: ServerCapabilities?
    /// The reason a function is not ready, or nil when it is ready or unknown.
    func unavailableReason(_ pick: (ServerCapabilities) -> CapabilityState?) -> String? {
        guard let capabilities, let state = pick(capabilities), !state.ready else { return nil }
        return state.reason ?? "غير متاح الآن."
    }
}

// MARK: - Where the phone stands with the computer and with Mohassan (plan phase 2, seven states).

enum ConnectionState: Equatable {
    /// The saved pairing is being checked; nothing is known yet.
    case checking
    /// 1. The computer does not answer: network, Tailscale, the service or sleep.
    case unreachable
    /// 2. The computer answered with a certificate that is not the pinned one.
    case certificateMismatch
    /// 3. The computer no longer trusts this phone: the pairing was revoked or expired.
    case trustRevoked
    /// 4. The service runs, but it is not linked to Mohassan.
    case notLinked
    /// 5. The service is linked, but Mohassan is not running on the computer.
    case mohassanDown
    /// 6. Mohassan refused the link: it was revoked there.
    case linkRevoked(String)
    /// 7. Everything answers.
    case ready

    var canSend: Bool { self == .ready }

    var title: String {
        switch self {
        case .checking: return "جارٍ التحقق من الكمبيوتر…"
        case .unreachable: return "تعذّر الوصول إلى الكمبيوتر"
        case .certificateMismatch: return "هوية الكمبيوتر لا تطابق"
        case .trustRevoked: return "أُلغيت ثقة هذا الهاتف"
        case .notLinked: return "وصلة غير مربوط بموحسن"
        case .mohassanDown: return "موحسن متوقف على الكمبيوتر"
        case .linkRevoked: return "أُلغي ربط وصلة من موحسن"
        case .ready: return "متصل بموحسن"
        }
    }

    /// What to do about it, in the owner's words.
    var advice: String {
        switch self {
        case .checking: return "لحظة من فضلك."
        case .unreachable: return "شغّل Tailscale على الهاتف والكمبيوتر، وتأكد أن خدمة موحسن تعمل على الكمبيوتر وأنه غير نائم."
        case .certificateMismatch: return "تغيّرت شهادة الكمبيوتر. أعد الاقتران بالبصمة الظاهرة على شاشة الكمبيوتر."
        case .trustRevoked: return "أعد اقتران الهاتف برمز جديد من الكمبيوتر."
        case .notLinked: return "من ويب موحسن على الكمبيوتر: «الاتصالات» ← «ربط الآيفون»، ثم نفّذ أمر الربط على الكمبيوتر."
        case .mohassanDown: return "شغّل موحسن على الكمبيوتر، ثم اسحب للتحديث."
        case .linkRevoked(let code): return "أنشئ ربطًا جديدًا من ويب موحسن (\(code))."
        case .ready: return ""
        }
    }

    /// Derives the state from the last status read and the last Mohassan link read.
    static func derive(status: ServerStatus?, statusError: WaslaError?, link: MohassanLink?) -> ConnectionState {
        if let statusError {
            switch statusError {
            case .certificate: return .certificateMismatch
            case .server(401, _, _): return .trustRevoked
            default: return .unreachable
            }
        }
        guard status != nil else { return .checking }
        guard let link else { return .notLinked }
        if !link.linked { return .notLinked }
        if !link.reachable { return .mohassanDown }
        if let error = link.error, !error.isEmpty { return error == "mohassan_unavailable" ? .mohassanDown : .linkRevoked(error) }
        return .ready
    }
}
struct ImagePreparation: Encodable { let description: String; let style: String }
struct PreparedImage: Codable, Identifiable {
    var id = UUID()
    var prompt: String
    var negative_prompt: String
    var seed: Int64
    enum CodingKeys: String, CodingKey { case prompt, negative_prompt, seed }
}
struct ImageRequest: Codable { let prompt: String; let negative_prompt: String; let seed: Int64; let request_id: String }
struct ImageJob: Decodable {
    let request_id: String?
    let status: String
    let image_url: String?
    let error: String?
}
struct SearchRequest: Encodable { let query: String }
struct SearchResult: Decodable, Identifiable {
    var id = UUID()
    let title: String
    let url: String
    let snippet: String
    enum CodingKeys: String, CodingKey { case title, url, snippet }
    var safeURL: URL? { SafeLink.https(url) }
}
/// Mohassan's search engine through the computer. `notice` explains an empty result; `limitations`
/// says what these sources cannot prove. Both are absent on older computer services.
struct SearchResponse: Decodable {
    let query: String
    let results: [SearchResult]
    let provider: String
    let notice: String?
    let limitations: [String]?
}
// MARK: - Mohassan, through the Wasla service on the computer (/v1/mohassan/*)
// Field names follow Mohassan's contract (packages/contracts/src/command-chat.ts).
// Unknown fields are ignored, so newer servers stay readable.

struct MohassanLink: Decodable { let linked: Bool; let reachable: Bool; let error: String? }

enum MohassanStatus {
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
struct MohassanOption: Decodable, Identifiable, Hashable { let id: String; let label: String }
struct MohassanClarification: Decodable { let reason: String; let recommendedOptionId: String?; let allowText: Bool }
/// One suggested answer, taken by the brain from the owner's own site or sentence.
struct MohassanSuggestion: Decodable, Hashable { let label: String; let reason: String? }
/// One of several questions asked together (ChatQuestionFieldSchema in packages/contracts).
struct MohassanField: Decodable, Identifiable {
    let id: String
    let prompt: String
    let suggestions: [MohassanSuggestion]
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
struct MohassanQuestion: Decodable {
    let id: String
    let prompt: String
    let options: [MohassanOption]
    let action: String?
    let clarification: MohassanClarification?
    /// Several questions in one card; the answers go back together, with this question's id.
    let fields: [MohassanField]?
    /// Google's consent page cannot open from the phone; that option stays on the web.
    var phoneOptions: [MohassanOption] { action == "google_ads_connect" ? options.filter { $0.id != "connect" } : options }
    var phoneFields: [MohassanField] { fields ?? [] }
    /// The «stop» option a field card offers beside its questions.
    var stopOption: MohassanOption? { options.first { $0.id == "stop" } }
    /// A typed answer is taken when the question asks for words: no choices, or only «stop».
    /// Older servers state it in `clarification`.
    var acceptsText: Bool { clarification?.allowText ?? options.allSatisfy { $0.id == "stop" } }
}
struct MohassanApproval: Decodable { let id: String; let prompt: String; let detail: String }
struct MohassanSecure: Decodable { let id: String; let kind: String; let site: String; let prompt: String }
struct MohassanMessage: Decodable, Identifiable { let id: String; let role: String; let text: String }
struct MohassanStep: Decodable, Identifiable { let id: String; let text: String }
struct MohassanSummary: Decodable, Identifiable { let id: String; let title: String; let status: String; let updatedAt: String }
/// Mohassan wraps the list: `{"conversations": [...]}`.
struct MohassanList: Decodable { let conversations: [MohassanSummary] }
struct MohassanConversation: Decodable, Identifiable {
    let id: String
    let title: String
    let status: String
    let messages: [MohassanMessage]
    let question: MohassanQuestion?
    let approval: MohassanApproval?
    let secure: MohassanSecure?
    let progress: String?
    let steps: [MohassanStep]
    let error: String?
    var working: Bool { status == MohassanStatus.running }
}
struct MohassanCreated: Decodable { let id: String }

// MARK: - Phone requests with keys (plan phase 3)
// Every create, message, answer and approval carries a fresh `clientRequestId`. Mohassan's gateway
// runs at most one effect per key: a double tap, or a resend after a lost reply, returns the first
// result instead of starting the work twice. Nothing is ever sent again without the owner's tap.

struct MohassanCreate: Encodable { let goal: String; let clientRequestId: String }
/// A message from the composer.
struct MohassanSend: Encodable { let text: String; let clientRequestId: String }
/// A typed answer to the pending question: a message that names the question, so a stale answer is refused.
struct MohassanReply: Encodable { let text: String; let questionId: String; let clientRequestId: String }
struct MohassanFieldAnswer: Codable, Equatable { let fieldId: String; let value: String }
/// The answers of a several-questions card, in the card's order.
struct MohassanFieldsReply: Encodable { let questionId: String; let answers: [MohassanFieldAnswer]; let clientRequestId: String }
/// One option of the pending question (Mohassan's `respond` takes an option only).
struct MohassanRespond: Encodable { let questionId: String; let optionId: String; let clientRequestId: String }
struct MohassanApprove: Encodable { let approvalId: String; let approved: Bool; let clientRequestId: String }

/// One phone request as it was sent: its key, where it went and its exact body, so the screen can say
/// what is still unconfirmed and the owner can send the very same request again.
struct MohassanRequest: Codable, Equatable {
    enum Kind: String, Codable { case create, message, reply, fields, option, approve }
    enum Phase: String, Codable {
        /// On its way; no reply yet.
        case sending
        /// The reply was lost, or the work failed midway: it may or may not have happened.
        case unknown
        /// A check found that Mohassan never received it.
        case notReceived
    }
    let key: String
    let kind: Kind
    /// The conversation it goes to; nil for a new conversation.
    let conversationId: String?
    /// What the owner sent, as the screen shows it.
    let text: String
    /// The JSON body, key included, exactly as first sent.
    let body: Data
    var phase: Phase
    var note: String?

    static func make<Body: Encodable>(_ kind: Kind, conversationId: String?, text: String, body: (String) -> Body) throws -> MohassanRequest {
        let key = UUID().uuidString.lowercased()
        return MohassanRequest(key: key, kind: kind, conversationId: conversationId, text: text, body: try JSONEncoder().encode(body(key)), phase: .sending, note: nil)
    }

    var path: String {
        let conversation = "/v1/mohassan/conversations/\(conversationId ?? "")"
        switch kind {
        case .create: return "/v1/mohassan/conversations"
        case .message, .reply, .fields: return conversation + "/messages"
        case .option: return conversation + "/respond"
        case .approve: return conversation + "/approve"
        }
    }
    /// The composer's own text. A card's answer or approval is never resent: the owner answers the fresh card.
    var fromComposer: Bool { kind == .create || kind == .message }
    /// Whether it belongs to what the screen shows: the new-chat screen, or that conversation.
    func belongs(to current: String?) -> Bool { kind == .create ? current == nil : conversationId == current }
}

/// What Mohassan's gateway knows about one key (GET /v1/mohassan/requests/{key}).
struct MohassanRequestStatus: Decodable {
    let known: Bool
    let kind: String?
    let state: String?
    let conversationId: String?

    enum Verdict: Equatable {
        /// It happened; the conversation it went to, when the gateway recorded one.
        case done(String?)
        /// Mohassan never received it (or refused it, which changed nothing).
        case notReceived
        /// Mohassan is still taking it in.
        case inProgress
        /// It failed midway on the computer; only the conversation can show what happened.
        case undetermined
    }
    var verdict: Verdict {
        guard known else { return .notReceived }
        switch state {
        case "done": return .done(conversationId)
        case "pending": return .inProgress
        default: return .undetermined
        }
    }
}

/// What a failed send means for the request. Only a refusal, or a call that never left the phone,
/// proves that nothing happened; anything else may have reached Mohassan.
enum SendOutcome: Equatable {
    /// Refused, or never sent: nothing happened. The reason is the owner's to read.
    case notDone(String)
    /// It may have reached Mohassan; a check can tell.
    case unknown(String)
    /// The first request with this key is still running on the computer.
    case inProgress(String)
    /// The first request with this key failed midway on the computer.
    case undetermined(String)

    static func of(_ error: Error) -> SendOutcome {
        if let failure = error as? WaslaError {
            switch failure {
            case .server(let status, let message, let code):
                if status == 409, code == "CLIENT_REQUEST_IN_PROGRESS" { return .inProgress(message) }
                if status == 409, code == "CLIENT_REQUEST_UNKNOWN" { return .undetermined(message) }
                if (400...499).contains(status) { return .notDone(message) }
                return .unknown(message)
            case .certificate, .invalidAddress, .notPaired, .invalidFingerprint, .invalidPairingCode, .storage:
                return .notDone(failure.localizedDescription)
            case .invalidResponse, .message:
                return .unknown(failure.localizedDescription)
            }
        }
        if let failure = error as? URLError {
            // No connection or no trusted handshake: the request itself was never sent.
            let neverSent: [URLError.Code] = [.cannotConnectToHost, .cannotFindHost, .notConnectedToInternet, .dnsLookupFailed,
                                              .internationalRoamingOff, .dataNotAllowed, .callIsActive, .secureConnectionFailed,
                                              .serverCertificateUntrusted, .serverCertificateHasBadDate, .serverCertificateNotYetValid,
                                              .serverCertificateHasUnknownRoot, .clientCertificateRejected, .badURL, .unsupportedURL]
            if neverSent.contains(failure.code) { return .notDone("تعذّر الوصول إلى الكمبيوتر، فلم يُرسل الطلب.") }
            return .unknown("انقطع الاتصال قبل وصول الرد.")
        }
        return .unknown("وصل رد غير متوقع.")
    }
}

/// Composes the answers of a field card exactly as the web's QuestionPanel does.
enum FieldAnswers {
    /// One field's answer: the chosen suggestions in their order, and the typed text. In a
    /// single-answer field a typed answer replaces the choice; a multi-line answer keeps its lines.
    static func answer(_ field: MohassanField, chosen: Set<Int>, typed supplied: String) -> String {
        let picked = chosen.sorted().compactMap { field.suggestions.indices.contains($0) ? field.suggestions[$0].label : nil }
        let typed = field.keepsLines ? supplied : supplied.trimmingCharacters(in: .whitespacesAndNewlines)
        let hasTyped = !typed.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        let parts = field.allowsSeveral ? picked + (hasTyped ? [typed] : []) : (hasTyped ? [typed] : picked)
        return parts.joined(separator: ", ")
    }
    /// The length Mohassan counts: the answers, and for several the «1. » numbers and line breaks.
    static func length(_ answers: [String]) -> Int {
        answers.reduce(0) { $0 + $1.utf16.count } + (answers.count > 1 ? answers.count * 4 - 1 : 0)
    }
    static let limit = 4_000
    static func ready(_ answers: [String]) -> Bool {
        !answers.isEmpty && answers.allSatisfy { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty } && length(answers) <= limit
    }
}

// MARK: - Reply text: the web's Markdown subset (apps/web/components/markdown.tsx)

/// Headings, lists, quotes, code blocks, **bold**, `code` and links, read the way the web reads them.
/// Only https links become tappable, and they open inside the app.
@available(iOS 15.0, macOS 12.0, *)
enum ReplyMarkdown {
    enum Block: Equatable {
        case paragraph(String)
        case heading(String)
        case quote([String])
        case list(ordered: Bool, items: [String])
        case code(String)
    }

    private static let orderedItem = #"^\s*\d+[.)]\s+"#
    private static let bulletItem = #"^\s*[-*•]\s+"#
    private static let quoteLine = #"^\s*>"#
    private static let headingLine = #"^#{1,3}\s+\S"#

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
                blocks.append(.heading(line.replacingOccurrences(of: #"^#{1,3}\s+"#, with: "", options: .regularExpression)))
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
            // A paragraph runs to the next blank line or block; it always takes at least this line.
            var paragraph = [line]
            index += 1
            while index < lines.count, !blank(lines[index]), !fence(lines[index]), !matches(lines[index], headingLine),
                  !matches(lines[index], orderedItem), !matches(lines[index], bulletItem), !matches(lines[index], quoteLine) {
                paragraph.append(lines[index]); index += 1
            }
            blocks.append(.paragraph(paragraph.joined(separator: "\n")))
        }
        return blocks
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

struct DesktopSession: Decodable { let session_id: String; let expires_at: Double }
struct DesktopCommand: Encodable {
    let action: String
    var x: Double? = nil
    var y: Double? = nil
    var button: String? = nil
    var dy: Int? = nil
    var key: String? = nil
    var text: String? = nil
}
