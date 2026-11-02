import Foundation
import Security

enum WaslaError: LocalizedError {
    case invalidAddress, invalidFingerprint, invalidPairingCode, invalidResponse
    case notPaired, certificate, storage(OSStatus), server(Int, String), message(String)
    var errorDescription: String? {
        switch self {
        case .invalidAddress: return "أدخل عنوان HTTPS فقط، دون اسم مستخدم أو مسار أو معاملات إضافية."
        case .invalidFingerprint: return "بصمة الشهادة يجب أن تتكون من 64 حرفًا من الأرقام والحروف a–f. انسخها من شاشة الكمبيوتر الموثوقة."
        case .invalidPairingCode: return "أدخل رمز الاقتران الكامل الظاهر على الكمبيوتر."
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
}
struct ChatMessage: Codable, Identifiable {
    var id = UUID()
    let role: String
    let content: String
    enum CodingKeys: String, CodingKey { case role, content }
}
struct ChatRequest: Encodable { let messages: [ChatMessage] }
struct ChatResponse: Decodable { let content: String; let model: String }
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
