import Foundation

// Wire types for packages/contracts/src/monitors.ts. A new discriminator must not
// prevent older versions of the app from reading the rest of the conversation.
protocol MonitorWireEnum: RawRepresentable, Codable where RawValue == String {
    static var unknown: Self { get }
}

extension MonitorWireEnum {
    init(from decoder: Decoder) throws {
        let value = try decoder.singleValueContainer().decode(String.self)
        self = Self(rawValue: value) ?? .unknown
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(rawValue)
    }
}

enum MonitorStatus: String, MonitorWireEnum {
    case proposed, active, paused, stopped, completed, expired, unknown

    var actions: [MonitorAction] {
        switch self {
        case .proposed: return [.approve, .stop]
        case .active: return [.pause, .stop]
        case .paused: return [.resume, .stop]
        case .stopped, .completed, .expired, .unknown: return []
        }
    }

    fileprivate var isOngoing: Bool { self == .active || self == .paused }
}

struct MonitorSource: Codable, Equatable {
    enum Kind: String, MonitorWireEnum { case page, currency, weather, search, run, unknown }
    enum Metric: String, MonitorWireEnum { case temperature, precipitation, wind, unknown }

    let kind: Kind
    let url: String?
    let anchor: String?
    let base: String?
    let quote: String?
    let location: String?
    let latitude: Double?
    let longitude: Double?
    let metric: Metric?
    let query: String?
    let runId: String?

    private enum CodingKeys: String, CodingKey { case kind, url, anchor, base, quote, location, latitude, longitude, metric, query, runId }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        kind = try container.decode(Kind.self, forKey: .kind)
        url = try? container.decode(String.self, forKey: .url)
        anchor = try? container.decode(String.self, forKey: .anchor)
        base = try? container.decode(String.self, forKey: .base)
        quote = try? container.decode(String.self, forKey: .quote)
        location = try? container.decode(String.self, forKey: .location)
        latitude = try? container.decode(Double.self, forKey: .latitude)
        longitude = try? container.decode(Double.self, forKey: .longitude)
        metric = try? container.decode(Metric.self, forKey: .metric)
        query = try? container.decode(String.self, forKey: .query)
        runId = try? container.decode(String.self, forKey: .runId)
    }
}

struct MonitorRead: Codable, Equatable {
    enum Kind: String, MonitorWireEnum { case main, number, status, date, phrase, items, unknown }

    let kind: Kind
    let label: String?
    let phrase: String?

    private enum CodingKeys: String, CodingKey { case kind, label, phrase }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        kind = try container.decode(Kind.self, forKey: .kind)
        label = try? container.decode(String.self, forKey: .label)
        phrase = try? container.decode(String.self, forKey: .phrase)
    }
}

struct MonitorCondition: Codable, Equatable {
    enum Kind: String, MonitorWireEnum {
        case change, equals, contains, appears, disappears, threshold, crossing, percent, unknown
        case newItem = "new-item"
    }
    enum Direction: String, MonitorWireEnum { case above, below, either, unknown }

    let kind: Kind
    let direction: Direction?
    let value: MonitorValue?
    let hysteresis: Double?

    private enum CodingKeys: String, CodingKey { case kind, direction, value, hysteresis }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        kind = try container.decode(Kind.self, forKey: .kind)
        direction = try? container.decode(Direction.self, forKey: .direction)
        value = try? container.decode(MonitorValue.self, forKey: .value)
        hysteresis = try? container.decode(Double.self, forKey: .hysteresis)
    }
}

struct MonitorTiming: Codable, Equatable {
    enum Urgency: String, MonitorWireEnum { case normal, urgent, unknown }

    let urgency: Urgency
    let lifetimeMs: Int
    let deadline: String?
    let initialIntervalMs: Int
    let maxChecks: Int
    let maxNotifications: Int
}

struct MonitorSpec: Codable, Equatable {
    enum Language: String, MonitorWireEnum { case ar, en, unknown }

    let source: MonitorSource
    let read: MonitorRead
    let condition: MonitorCondition
    let timing: MonitorTiming
    let language: Language
    let message: String
    let title: String
}

enum MonitorValue: Codable, Equatable {
    case text(String), number(Double), boolean(Bool), items([String]), unknown

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if let text = try? container.decode(String.self) { self = .text(text) }
        else if let number = try? container.decode(Double.self) { self = .number(number) }
        else if let boolean = try? container.decode(Bool.self) { self = .boolean(boolean) }
        else if let items = try? container.decode([String].self) { self = .items(items) }
        else { self = .unknown }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .text(let text): try container.encode(text)
        case .number(let number): try container.encode(number)
        case .boolean(let boolean): try container.encode(boolean)
        case .items(let items): try container.encode(items)
        case .unknown: try container.encodeNil()
        }
    }
}

struct MonitorObservation: Codable, Equatable {
    let value: MonitorValue
    let excerpt: String
    let observedAt: String
}

struct MonitorCard: Codable, Equatable, Identifiable {
    enum Offer: String, MonitorWireEnum {
        case explicit, implicit, unknown
        case agentInitiated = "agent-initiated"
    }

    let id: String
    let conversationId: String
    let spec: MonitorSpec
    let status: MonitorStatus
    let current: MonitorObservation?
    let lastCheckedAt: String?
    let nextCheckAt: String?
    let expiresAt: String
    let offer: Offer?
    let note: String?
}

struct MonitorList: Decodable {
    let monitors: [MonitorCard]

    private enum CodingKeys: String, CodingKey { case monitors }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        monitors = try container.decodeMonitorCards(forKey: .monitors)
    }
}

/// An unreadable card must not discard the other cards or their conversation.
private struct MonitorCardElement: Decodable {
    let card: MonitorCard?

    init(from decoder: Decoder) {
        card = try? MonitorCard(from: decoder)
    }
}

extension KeyedDecodingContainer {
    func decodeMonitorCards(forKey key: Key) throws -> [MonitorCard] {
        try decode([MonitorCardElement].self, forKey: key).compactMap(\.card)
    }
}

struct MonitorApprove: Encodable { let proposalId: String }

enum MonitorAction: String {
    case approve, pause, resume, stop

    func requiresConfirmation(for status: MonitorStatus) -> Bool {
        self == .stop && status.isOngoing
    }
}

enum MonitorDecision {
    static func settingsOrder(_ monitors: [MonitorCard]) -> [MonitorCard] {
        monitors.filter { $0.status.isOngoing } + monitors.filter { !$0.status.isOngoing }
    }

    static func errorText(status: Int, code: String?, action: MonitorAction? = nil) -> String {
        switch code {
        case "MONITOR_NOT_PROPOSED":
            return "انتهت صلاحية الاقتراح أو جرى الرد عليه. اطلب اقتراحًا جديدًا."
        case "MONITOR_DEADLINE_PASSED":
            return "انقضى الموعد المحدد للمراقبة. اختر موعدًا جديدًا."
        case "MONITOR_LIMIT":
            return "بلغت الحد الأقصى للمراقبات. أوقف إحدى المراقبات لإفساح المجال."
        case "MONITOR_PREVIEW_LIMIT", "MEMBER_DAILY_LIMIT":
            return "بلغت الحد اليومي للطلبات. حاول مجددًا لاحقًا."
        case "MONITOR_URL_DENIED", "MONITOR_QUERY_DENIED", "RESEARCH_ROBOTS_DENIED",
             "BROWSER_URL_INVALID", "BROWSER_URL_DENIED", "BROWSER_NETWORK_DENIED", "BROWSER_SCOPE_DENIED",
             "BROWSER_CONTENT_DENIED":
            return "رفض الخادم هذا المصدر. اختر مصدرًا عامًا يسمح بالقراءة."
        case "MONITOR_PREVIEW_REQUIRED":
            return "تعذّرت قراءة القيمة الحالية. اطلب معاينة جديدة قبل بدء المراقبة."
        case "MONITOR_RESUME_LIMIT":
            return "يتعذّر الاستئناف الآن. قد يكون هناك تنبيه قيد الإرسال أو نفدت حصة هذه المراقبة."
        case "MONITOR_STATUS_CONFLICT":
            return "تغيّرت حالة المراقبة. حدّث المحادثة ثم حاول مجددًا."
        case "MONITOR_FORBIDDEN":
            return "المراقبات غير متاحة لهذا الحساب."
        case "MONITOR_NOT_FOUND", "MONITOR_CONVERSATION_NOT_FOUND":
            return "تعذّر العثور على هذه المراقبة أو محادثتها."
        default:
            if status == 429 { return "كثرت الطلبات. انتظر قليلًا ثم حاول مجددًا." }
            if action == nil { return "تعذّر تحميل المراقبات. حاول مجددًا." }
            return "تعذّر تحديث المراقبة. حاول مجددًا."
        }
    }
}
