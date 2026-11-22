import Foundation
import Security

enum WaslaError: LocalizedError {
    case invalidAddress, invalidFingerprint, invalidPairingCode, invalidResponse
    case notPaired, certificate, storage(OSStatus), server(Int, String), message(String)
    var errorDescription: String? {
        switch self {
        case .invalidAddress: return "أدخل عنوان HTTPS فقط، دون اسم مستخدم أو مسار أو معاملات إضافية."
        case .invalidFingerprint: return "بصمة الشهادة يجب أن تتكون من 64 حرفًا من الأرقام والحروف a–f. انسخها من شاشة الكمبيوتر الموثوقة."
        case .invalidPairingCode: return "أدخل رمز الربط من ٨ أرقام كما يظهر على الكمبيوتر."
        case .invalidResponse: return "وصل رد غير متوقع من الكمبيوتر."
        case .notPaired: return "اربط الكمبيوتر أولًا."
        case .certificate: return "تعذّر التحقق من هوية الكمبيوتر أو صلاحية شهادته. راجع العنوان والبصمة والوقت على الجهازين."
        case .storage(let code): return "تعذّر حفظ بيانات الاقتران في سلسلة المفاتيح (\(code))."
        case .server(_, let message), .message(let message): return message
        }
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
            case .server(401, _): return .trustRevoked
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
    var safeURL: URL? {
        guard let components = URLComponents(string: url), components.scheme?.lowercased() == "https",
              let host = components.host, !host.isEmpty, components.user == nil, components.password == nil,
              !url.contains("\\"), !url.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }) else { return nil }
        return components.url
    }
}
struct SearchResponse: Decodable { let query: String; let results: [SearchResult]; let provider: String }
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
struct MohassanQuestion: Decodable {
    let id: String
    let prompt: String
    let options: [MohassanOption]
    let action: String?
    let clarification: MohassanClarification?
    /// Google's consent page cannot open from the phone; that option stays on the web.
    var phoneOptions: [MohassanOption] { action == "google_ads_connect" ? options.filter { $0.id != "connect" } : options }
    var acceptsText: Bool { clarification?.allowText ?? options.isEmpty }
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
struct MohassanCreate: Encodable { let goal: String }
struct MohassanSend: Encodable { let text: String }
/// Absent values are left out, as Mohassan expects either an option or a typed answer.
struct MohassanRespond: Encodable { let questionId: String; let optionId: String?; let text: String? }
struct MohassanApprove: Encodable { let approvalId: String; let approved: Bool }

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
