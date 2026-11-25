import Foundation
import SwiftUI

struct MonitorApprovalCard: View {
    let monitor: MonitorCard
    let busy: Bool
    let problem: String?
    let onAction: (MonitorAction) -> Void

    var body: some View {
        let spec = monitor.spec
        Card {
            Label("مقترح مراقبة", systemImage: "waveform.path")
                .font(Forest.font(.headline, weight: .semibold))
                .accessibilityAddTraits(.isHeader)
            Text(spec.title).font(Forest.font(.body, weight: .medium))
            VStack(alignment: .leading, spacing: 9) {
                MonitorFact(label: "المصدر", value: MonitorCopy.source(spec.source))
                MonitorFact(label: "ما يُراقَب", value: MonitorCopy.reading(spec))
                MonitorFact(label: "القراءة الحالية", value: MonitorCopy.observation(monitor.current),
                            detail: monitor.current.map { MonitorCopy.date($0.observedAt) })
                MonitorFact(label: "شرط التنبيه", value: MonitorCopy.condition(spec))
                MonitorFact(label: "الفاصل الأول بين الفحوص", value: MonitorCopy.duration(spec.timing.initialIntervalMs))
                MonitorFact(label: "مدة المراقبة", value: MonitorCopy.duration(spec.timing.lifetimeMs))
                if let deadline = spec.timing.deadline {
                    MonitorFact(label: "الموعد النهائي", value: MonitorCopy.date(deadline))
                }
            }
            if busy { MonitorSaving() }
            if let problem { MonitorProblem(message: problem) }
            MonitorButtonRow {
                Button("ابدأ المراقبة") { onAction(.approve) }
                    .buttonStyle(ForestButton())
                Button("لا، شكرًا") { onAction(.stop) }
                    .buttonStyle(ForestButton(prominent: false))
            }
            .disabled(busy)
        }
    }
}

struct ConversationMonitorCard: View {
    let monitor: MonitorCard
    let busy: Bool
    let problem: String?
    let onAction: (MonitorAction) -> Void

    var body: some View {
        Card {
            MonitorHeading(monitor: monitor)
            VStack(alignment: .leading, spacing: 9) {
                MonitorFact(label: "المصدر", value: MonitorCopy.source(monitor.spec.source))
                MonitorFact(label: "آخر فحص", value: MonitorCopy.date(monitor.lastCheckedAt))
                MonitorFact(label: "القراءة الحالية", value: MonitorCopy.observation(monitor.current))
                MonitorFact(label: "الفحص التالي", value: MonitorCopy.date(monitor.nextCheckAt))
            }
            if let note = monitor.note?.nonEmpty {
                Text(note).font(Forest.font(.footnote)).foregroundStyle(Forest.softText)
            }
            MonitorControls(monitor: monitor, busy: busy, problem: problem, onAction: onAction)
        }
    }
}

private struct MonitorHeading: View {
    let monitor: MonitorCard

    var body: some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 8) {
                title
                Spacer(minLength: 0)
                statusChip
            }
            VStack(alignment: .leading, spacing: 6) {
                title
                statusChip
            }
        }
    }

    private var title: some View {
        Text(monitor.spec.title)
            .font(Forest.font(.subheadline, weight: .semibold))
            .fixedSize(horizontal: false, vertical: true)
            .accessibilityAddTraits(.isHeader)
    }

    private var statusChip: some View {
        let highlighted = monitor.status == .active || monitor.status == .completed
        return Text(MonitorCopy.status(monitor.status))
            .font(Forest.font(.caption, weight: .semibold))
            .padding(.horizontal, 10).padding(.vertical, 5)
            .foregroundStyle(highlighted ? Forest.accent : Forest.softText)
            .background(highlighted ? Forest.accentSoft : Forest.soft, in: Capsule())
    }
}

private struct MonitorControls: View {
    @State private var stopConfirm = false
    let monitor: MonitorCard
    let busy: Bool
    let problem: String?
    let onAction: (MonitorAction) -> Void

    var body: some View {
        let actions = monitor.status.actions
        if busy { MonitorSaving() }
        if let problem { MonitorProblem(message: problem) }
        if monitor.status == .active || monitor.status == .paused {
            MonitorButtonRow {
                if actions.contains(.pause) {
                    Button("إيقاف مؤقت") { onAction(.pause) }
                        .buttonStyle(ForestButton(prominent: false))
                }
                if actions.contains(.resume) {
                    Button("استئناف") { onAction(.resume) }
                        .buttonStyle(ForestButton(prominent: false))
                }
                if actions.contains(.stop) {
                    Button("إيقاف المراقبة", role: .destructive) {
                        if MonitorAction.stop.requiresConfirmation(for: monitor.status) {
                            stopConfirm = true
                        } else {
                            onAction(.stop)
                        }
                    }
                    .buttonStyle(ForestButton(prominent: false))
                    .confirmationDialog("إيقاف هذه المراقبة؟", isPresented: $stopConfirm, titleVisibility: .visible) {
                        Button("إيقاف المراقبة", role: .destructive) { onAction(.stop) }
                    } message: {
                        Text(monitor.spec.title)
                    }
                }
            }
            .disabled(busy)
        }
    }
}

private struct MonitorButtonRow<Content: View>: View {
    @Environment(\.dynamicTypeSize) private var typeSize
    @ViewBuilder var content: Content

    var body: some View {
        let layout = typeSize.isAccessibilitySize
            ? AnyLayout(VStackLayout(spacing: 8))
            : AnyLayout(HStackLayout(spacing: 8))
        layout { content }
    }
}

private struct MonitorFact: View {
    let label: String
    let value: String
    var detail: String? = nil

    var body: some View {
        ViewThatFits(in: .horizontal) {
            HStack(alignment: .firstTextBaseline, spacing: 12) {
                name
                Spacer(minLength: 0)
                reading
            }
            VStack(alignment: .leading, spacing: 3) {
                name
                reading
            }
        }
        .accessibilityElement(children: .combine)
    }

    private var name: some View {
        Text(label).font(Forest.font(.footnote)).foregroundStyle(Forest.softText)
    }

    private var reading: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(value).font(Forest.font(.subheadline, weight: .medium))
                .fixedSize(horizontal: false, vertical: true)
            if let detail {
                Text(detail).font(Forest.font(.caption)).foregroundStyle(Forest.softText)
            }
        }
    }
}

private struct MonitorSaving: View {
    var body: some View {
        ProgressView("جارٍ حفظ المراقبة…")
            .font(Forest.font(.footnote))
            .tint(Forest.accent)
            .foregroundStyle(Forest.softText)
    }
}

private struct MonitorProblem: View {
    let message: String

    var body: some View {
        Label(message, systemImage: "exclamationmark.circle")
            .font(Forest.font(.footnote))
            .foregroundStyle(Forest.alert)
            .fixedSize(horizontal: false, vertical: true)
    }
}

private enum MonitorCopy {
    static let unavailable = "غير متاح"
    private static let arabic = Locale(identifier: "ar")

    static func status(_ status: MonitorStatus) -> String {
        switch status {
        case .proposed: return "بانتظار الموافقة"
        case .active: return "نشطة"
        case .paused: return "متوقفة مؤقتًا"
        case .stopped: return "متوقفة"
        case .completed: return "تحقّق الشرط"
        case .expired: return "انتهت المدة"
        case .unknown: return "حالة غير معروفة"
        }
    }

    static func source(_ source: MonitorSource) -> String {
        switch source.kind {
        case .page:
            return [source.url, source.anchor].compactMap { $0 }.joined(separator: " · ").nonEmpty ?? "صفحة عامة"
        case .currency:
            guard let base = source.base, let quote = source.quote else { return "سعر صرف" }
            return "\(base)/\(quote)"
        case .weather: return source.location ?? "بيانات الطقس"
        case .search: return source.query ?? "بحث عام"
        case .run: return "مهمة في الخلفية"
        case .unknown: return "مصدر محدّد على الخادم"
        }
    }

    static func reading(_ spec: MonitorSpec) -> String {
        let read = spec.read
        switch read.kind {
        case .main: return "المحتوى الرئيسي"
        case .number:
            if let label = read.label { return label }
            if spec.source.kind == .currency { return "سعر الصرف" }
            if spec.source.kind == .weather {
                switch spec.source.metric {
                case .temperature?: return "درجة الحرارة"
                case .precipitation?: return "كمية الهطول"
                case .wind?: return "سرعة الرياح"
                default: return "قراءة الطقس"
                }
            }
            return "القيمة الرقمية"
        case .status: return read.label ?? "الحالة"
        case .date: return read.label ?? "التاريخ"
        case .phrase: return read.phrase.map { "عبارة «\($0)»" } ?? "عبارة محدّدة"
        case .items: return "قائمة النتائج"
        case .unknown: return "قراءة محدّدة على الخادم"
        }
    }

    static func condition(_ spec: MonitorSpec) -> String {
        let condition = spec.condition
        let generic = "عند تحقّق الشرط المحدّد على الخادم"
        switch condition.kind {
        case .change: return "عند تغيّر القراءة"
        case .equals, .contains:
            guard case let .text(value)? = condition.value else { return generic }
            return condition.kind == .equals ? "عندما تصبح القراءة «\(value)»" : "عندما تتضمّن القراءة «\(value)»"
        case .appears, .disappears:
            let target = spec.read.phrase ?? spec.title
            let verb = condition.kind == .appears ? "ظهور" : "اختفاء"
            return "عند \(verb) «\(target)»"
        case .threshold, .crossing:
            guard case let .number(value)? = condition.value, let direction = condition.direction,
                  direction == .above || direction == .below else { return generic }
            let verb = condition.kind == .crossing ? "تنتقل" : "تصبح"
            return "عندما \(verb) القراءة \(direction == .below ? "دون" : "فوق") \(number(value))"
        case .percent:
            guard case let .number(value)? = condition.value else { return generic }
            let verb: String
            switch condition.direction {
            case .above?: verb = "ترتفع"
            case .below?: verb = "تنخفض"
            case .either?: verb = "تتغيّر"
            default: return generic
            }
            let percentage = (value / 100).formatted(.percent.precision(.fractionLength(0...10)).locale(arabic))
            return "عندما \(verb) القراءة بنسبة \(percentage) على الأقل"
        case .newItem: return "عند ظهور نتيجة جديدة"
        case .unknown: return generic
        }
    }

    static func observation(_ current: MonitorObservation?) -> String {
        guard let current else { return unavailable }
        let reading: String
        switch current.value {
        case .text(let text): reading = current.excerpt.nonEmpty ?? text
        case .number(let value): reading = number(value)
        case .boolean(let present): reading = present ? "موجود" : "غير موجود"
        case .items(let items):
            reading = current.excerpt.nonEmpty ?? (items.isEmpty ? "لا نتائج" : items.prefix(3).joined(separator: "، "))
        case .unknown: reading = current.excerpt
        }
        guard let reading = reading.nonEmpty else { return unavailable }
        return reading.count > 240 ? String(reading.prefix(240)) + "…" : reading
    }

    static func date(_ iso: String?) -> String {
        guard let iso,
              let date = (try? Date.ISO8601FormatStyle(includingFractionalSeconds: true).parse(iso))
                ?? (try? Date.ISO8601FormatStyle().parse(iso)) else { return unavailable }
        return date.formatted(.dateTime.day().month(.abbreviated).hour().minute().locale(arabic))
    }

    static func duration(_ milliseconds: Int) -> String {
        var calendar = Calendar.current
        calendar.locale = arabic
        let formatter = DateComponentsFormatter()
        formatter.calendar = calendar
        formatter.allowedUnits = [.day, .hour, .minute, .second]
        formatter.unitsStyle = .full
        formatter.maximumUnitCount = 2
        return formatter.string(from: Double(milliseconds) / 1_000) ?? unavailable
    }

    private static func number(_ number: Double) -> String {
        number.formatted(.number.precision(.fractionLength(0...10)).locale(arabic))
    }
}

private extension String {
    var nonEmpty: String? {
        let trimmed = trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
}
