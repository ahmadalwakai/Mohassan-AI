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
struct ServerStatus: Decodable {
    let name: String
    let model: String
    let busy: BusyState
    let desktop_enabled: Bool
    let desktop: DesktopInfo?
    let app_actions_enabled: Bool?
}
struct ChatMessage: Codable, Identifiable {
    var id = UUID()
    let role: String
    let content: String
    enum CodingKeys: String, CodingKey { case role, content }
}
enum ChatMode: String, CaseIterable, Identifiable {
    case automatic = "auto", liveWeb = "live_web", local
    var id: String { rawValue }
    var title: String {
        switch self { case .automatic: return "تلقائي"; case .liveWeb: return "بحث مباشر"; case .local: return "محلي" }
    }
}
struct ChatRequest: Encodable {
    let messages: [ChatMessage]
    let request_id: String
    let mode: String
    let remember: Bool
    let use_memory: Bool
    let conversation_id: String?
}
struct ChatSource: Decodable, Identifiable {
    let id: String
    let title: String
    let url: String?
    let snippet: String?
    var safeURL: URL? {
        guard let url, let parts = URLComponents(string: url), parts.scheme?.lowercased() == "https",
              let host = parts.host, !host.isEmpty, parts.user == nil, parts.password == nil,
              !url.contains("\\"), !url.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }) else { return nil }
        return parts.url
    }
}
struct ChatEvidence: Decodable {
    let level: String
    let note: String?
    var title: String {
        switch level { case "grounded": return "مستندة إلى أدلة"; case "limited": return "أدلة محدودة"; case "unverified": return "تحتاج تحققًا"; default: return "حالة الأدلة غير محددة" }
    }
}
struct ChatResponse: Decodable {
    let content: String
    let model: String
    let route: String?
    let sources: [ChatSource]?
    let evidence: ChatEvidence?
    let warnings: [String]?
    let timing_ms: Double?
    let cache_hit: Bool?
    let memory_saved: Bool?
    let conversation_id: String?
    var routeTitle: String? {
        guard let route else { return nil }
        switch route {
        case "calculator": return "حساب مباشر"
        case "unit_conversion": return "تحويل وحدات"
        case "knowledge": return "المعرفة المحفوظة"
        case "research", "live_web": return "بحث بمصادر"
        case "local": return "النموذج المحلي"
        case "actions": return "إجراء في التطبيق"
        case "cloud": return "محرك سحابي"
        default: return route
        }
    }
    static func warningMessage(_ code: String) -> String {
        switch code {
        case "source_instructions_ignored": return "استُبعدت تعليمات غير مرتبطة بسؤالك وردت داخل بعض المصادر."
        case "duplicate_or_similar_sources_omitted": return "استُبعدت المصادر المكررة أو شديدة التشابه."
        case "knowledge_version_unavailable": return "تعذّر التأكد من آخر تحديث للمعرفة المحفوظة."
        case "invalid_conversion": return "تعذّر تحويل هذه الوحدات. راجع الوحدات والقيمة."
        case "invalid_calculation": return "تعذّر حساب هذا التعبير. راجع الأرقام والعمليات المطلوبة."
        case "knowledge_unavailable": return "تعذّر الوصول إلى معرفتك المحفوظة لهذه الإجابة."
        case "knowledge_not_configured": return "استخدام المعرفة المحفوظة غير مهيأ في اتصالك الحالي."
        case "search_query_truncated_to_400_characters": return "استخدم البحث الجزء الأول من سؤالك الطويل."
        case "search_query_simplified": return "بُسّطت صياغة البحث للتركيز على موضوع سؤالك."
        case "search_unavailable": return "تعذّر البحث في الإنترنت الآن. لم يتأكد الحصول على معلومات حديثة."
        case "possible_source_conflict": return "قد توجد أرقام غير متفقة في المقتطفات؛ لم يتأكد سبب الاختلاف."
        case "summary_unavailable": return "تعذّر إعداد ملخص. يمكنك مراجعة مقتطفات المصادر المعروضة."
        case "draft_rejected_or_insufficient_evidence": return "تعذّر تقديم خلاصة مدعومة بما يكفي، لذا عُرضت مقتطفات المصادر."
        case "search_total_cost_not_determined_from_usage": return "التكلفة الإجمالية للبحث السحابي غير متاحة في بيانات الاستخدام."
        case "unsupported_links_rejected": return "لم تُعرض إجابة احتوت على روابط لم تُرجعها خدمة البحث."
        case "insufficient_web_citations": return "لم تتوفر استشهادات ويب كافية لدعم الإجابة."
        case "memory_save_failed": return "وصلت الإجابة، لكن لم يتأكد حفظ المحادثة."
        case "usage_record_failed": return "لم يتأكد تحديث إحصاءات الاستخدام لهذه الإجابة."
        default: return "تفاصيل الأدلة محدودة. راجع المصادر قبل الاعتماد على الإجابة."
        }
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
