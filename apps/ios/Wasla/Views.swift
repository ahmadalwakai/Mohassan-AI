import SwiftUI
import UserNotifications
import UIKit
import SafariServices

// Forest pairs use the same teal hue in both appearances.
enum Forest {
    private static func pair(_ light: UInt32, _ dark: UInt32) -> Color {
        Color(uiColor: UIColor { $0.userInterfaceStyle == .dark ? UIColor(hex: dark) : UIColor(hex: light) })
    }
    static let background = pair(0xF7F6F2, 0x141816)
    static let panel = pair(0xEEEFE9, 0x1A201D)
    static let surface = pair(0xFFFFFF, 0x212925)
    static let ink = pair(0x202823, 0xF2F4F0)
    static let softText = pair(0x53625B, 0xACB9B1)
    static let faint = softText
    static let line = pair(0xD2DCD5, 0x3A4A42)
    static let controlBorder = pair(0x78877F, 0x718379)
    static let soft = pair(0xE8EEE8, 0x26332D)
    static let accent = pair(0x216852, 0x72CBB0)
    static let accentSoft = pair(0xDFEEE6, 0x23453A)
    static let onAccent = pair(0xFFFFFF, 0x10291F)
    static let alert = pair(0xA33A2C, 0xEE9383)

    static func font(_ style: Font.TextStyle = .body, weight: Font.Weight = .regular) -> Font {
        let name: String
        switch weight {
        case .bold, .heavy, .black: name = "Alexandria-Bold"
        case .semibold: name = "Alexandria-SemiBold"
        case .medium: name = "Alexandria-Medium"
        default: name = "Alexandria-Regular"
        }

        let size: CGFloat
        switch style {
        case .largeTitle: size = 32
        case .title: size = 27
        case .title2: size = 22
        case .title3: size = 19
        case .headline, .body: size = 16
        case .callout: size = 15
        case .subheadline: size = 14
        case .footnote: size = 13
        case .caption: size = 12
        case .caption2: size = 11
        default: size = 16
        }

        guard UIFont(name: name, size: size) != nil else { return .system(style, weight: weight) }
        return .custom(name, size: size, relativeTo: style)
    }
}
extension UIColor {
    convenience init(hex: UInt32) {
        self.init(red: CGFloat((hex >> 16) & 0xFF) / 255, green: CGFloat((hex >> 8) & 0xFF) / 255, blue: CGFloat(hex & 0xFF) / 255, alpha: 1)
    }
}
func dismissKeyboard() { UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil) }

struct ForestButton: ButtonStyle {
    var prominent = true
    @Environment(\.isEnabled) private var enabled
    func makeBody(configuration: Configuration) -> some View {
        let labelColor = configuration.role == .destructive ? Forest.alert : Forest.ink
        return configuration.label
            .font(Forest.font(.body, weight: .semibold))
            .padding(.vertical, 11).padding(.horizontal, 16)
            .frame(maxWidth: .infinity, minHeight: 48)
            .background(prominent ? (enabled ? Forest.accent : Forest.soft) : Forest.surface, in: RoundedRectangle(cornerRadius: 15))
            .overlay {
                if !prominent {
                    RoundedRectangle(cornerRadius: 15).strokeBorder(Forest.controlBorder)
                        .allowsHitTesting(false)
                }
            }
            .foregroundStyle(enabled ? (prominent ? Forest.onAccent : labelColor) : Forest.faint)
            .opacity(configuration.isPressed ? 0.84 : 1)
    }
}
struct Card<Content: View>: View {
    @ViewBuilder var content: Content
    var body: some View {
        VStack(alignment: .leading, spacing: 14) { content }
            .padding(18)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Forest.surface, in: RoundedRectangle(cornerRadius: 20))
            .overlay(RoundedRectangle(cornerRadius: 20).strokeBorder(Forest.line).allowsHitTesting(false))
    }
}
struct ScreenTitle: View {
    let title: String
    let subtitle: String
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title).font(Forest.font(.title, weight: .semibold)).accessibilityAddTraits(.isHeader)
            Text(subtitle).font(Forest.font(.subheadline)).foregroundStyle(Forest.softText).lineSpacing(4)
        }.frame(maxWidth: .infinity, alignment: .leading).padding(.bottom, 4)
    }
}
// MARK: - Chat layout

struct ChatScrollRequest: Equatable {
    let target: String?
    private let id = UUID()
}

/// A thread that scrolls under a composer pinned above the keyboard. Sending clears focus, so the keyboard closes;
/// dragging the thread closes it too. While Mohassan works, an empty box shows «stop» and a typed one shows «send».
struct ChatScaffold<Thread: View>: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @FocusState private var focused: Bool
    @Binding var draft: String
    let placeholder: String
    let tooLong: Bool
    let canSend: Bool
    let working: Bool
    let sending: Bool
    let scrollKey: Int
    let scrollRequest: ChatScrollRequest?
    var showComposer = true
    /// Why sending is off or what it does now; the draft stays in the box.
    var notice: String? = nil
    /// Buttons before the text box (attach a photo).
    var tools: AnyView? = nil
    /// A row above the box (the photos waiting to go).
    var tray: AnyView? = nil
    let onSend: () -> Bool
    var onStop: (() -> Void)? = nil
    let thread: Thread

    init(draft: Binding<String>, placeholder: String, tooLong: Bool, canSend: Bool, working: Bool, sending: Bool, scrollKey: Int,
         scrollRequest: ChatScrollRequest? = nil, showComposer: Bool = true,
         notice: String? = nil, tools: AnyView? = nil, tray: AnyView? = nil, onSend: @escaping () -> Bool, onStop: (() -> Void)? = nil,
         @ViewBuilder thread: () -> Thread) {
        _draft = draft
        self.placeholder = placeholder; self.tooLong = tooLong; self.canSend = canSend; self.working = working
        self.sending = sending
        self.scrollKey = scrollKey; self.scrollRequest = scrollRequest; self.showComposer = showComposer; self.notice = notice; self.tools = tools; self.tray = tray
        self.onSend = onSend; self.onStop = onStop
        self.thread = thread()
    }

    private var empty: Bool { draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    thread
                    Color.clear.frame(height: 1).id("bottom").accessibilityHidden(true)
                }
                .padding(.horizontal, 22).padding(.top, 20).padding(.bottom, 8)
                .frame(maxWidth: 620).frame(maxWidth: .infinity)
            }
            .scrollDismissesKeyboard(.interactively)
            .contentShape(Rectangle())
            .simultaneousGesture(TapGesture().onEnded {
                if focused { focused = false; dismissKeyboard() }
            })
            .onChange(of: scrollKey) { _, _ in scroll(proxy) }
            .task(id: scrollRequest) {
                guard let scrollRequest else { return }
                await Task.yield()
                guard !Task.isCancelled else { return }
                scroll(proxy, to: scrollRequest.target ?? "bottom", anchor: scrollRequest.target == nil ? .bottom : .top)
            }
            .task(id: focused) {
                guard focused else { return }
                do { try await Task.sleep(for: .milliseconds(350)) } catch { return }
                scroll(proxy)
            }
            .safeAreaInset(edge: .bottom, spacing: 0) { if showComposer { composer } }
        }
    }

    private func scroll(_ proxy: ScrollViewProxy, to target: String = "bottom", anchor: UnitPoint = .bottom) {
        withAnimation(reduceMotion ? nil : .easeOut(duration: 0.25)) {
            proxy.scrollTo(target, anchor: anchor)
        }
    }

    private var composer: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let notice {
                Label(notice, systemImage: "info.circle")
                    .font(Forest.font(.footnote)).foregroundStyle(Forest.softText)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.horizontal, 8)
            }
            if let tray { tray }
            HStack(alignment: .bottom, spacing: 6) {
                if let tools { tools }
                TextField(placeholder, text: $draft, prompt: Text(placeholder).foregroundColor(Forest.softText), axis: .vertical)
                    .font(Forest.font(.body))
                    .foregroundStyle(Forest.ink)
                    .lineLimit(1...4)
                    .focused($focused)
                    .submitLabel(.return)
                    .padding(.vertical, 5)
                    .padding(.horizontal, 4)
                    .frame(minHeight: 44)
                    .accessibilityLabel("نص الرسالة")
                if working, empty, let onStop {
                    Button(action: onStop) {
                        composerIcon("stop.fill", foreground: Forest.ink, background: Forest.soft)
                    }
                    .accessibilityLabel("إيقاف")
                    .accessibilityHint("يوقف المهمة الجارية")
                } else {
                    Button {
                        if onSend() { focused = false; dismissKeyboard() }
                    } label: {
                        if sending, !reduceMotion {
                            ProgressView()
                                .tint(Forest.onAccent)
                                .frame(width: 44, height: 44)
                                .background(Forest.accent, in: RoundedRectangle(cornerRadius: 16))
                        } else {
                            let active = canSend || sending
                            composerIcon(sending ? "ellipsis" : "arrow.up",
                                         foreground: active ? Forest.onAccent : Forest.softText,
                                         background: active ? Forest.accent : Forest.soft)
                        }
                    }
                    .disabled(!canSend)
                    .accessibilityLabel(sending ? "جارٍ إرسال الرسالة" : "إرسال الرسالة")
                }
            }
            .buttonStyle(.plain)
            .padding(7)
            .background(Forest.surface.opacity(0.92), in: RoundedRectangle(cornerRadius: 24))
            .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 24))
            .overlay(RoundedRectangle(cornerRadius: 24).strokeBorder(focused ? Forest.accent : Forest.controlBorder).allowsHitTesting(false))
            .shadow(color: .black.opacity(0.14), radius: 12, y: 5)
            if tooLong {
                Text("الرسالة أطول من المسموح. اختصرها قبل الإرسال.")
                    .font(Forest.font(.caption)).foregroundStyle(Forest.alert)
                    .padding(.horizontal, 8)
            }
        }
        .padding(.horizontal, 16).padding(.top, 8).padding(.bottom, 9)
        .frame(maxWidth: 620).frame(maxWidth: .infinity)
    }

    private func composerIcon(_ symbol: String, foreground: Color, background: Color) -> some View {
        Image(systemName: symbol)
            .font(.system(size: 17, weight: .semibold))
            .foregroundStyle(foreground)
            .frame(width: 44, height: 44)
            .background(background, in: RoundedRectangle(cornerRadius: 16))
    }
}

/// The welcome starts a draft from a suggestion and shows the server's local mode note when present.
struct ChatWelcome: View {
    let title: String
    let suggestions: [String]
    var note: String? = nil
    let pick: (String) -> Void
    var body: some View {
        VStack(spacing: 20) {
            Text("م").font(Forest.font(.title2, weight: .semibold))
                .padding(15).frame(minWidth: 56, minHeight: 56)
                .background(Forest.accentSoft, in: RoundedRectangle(cornerRadius: 19))
                .foregroundStyle(Forest.accent)
                .accessibilityHidden(true)
            Text(title).font(Forest.font(.title2, weight: .semibold))
                .multilineTextAlignment(.center)
                .accessibilityAddTraits(.isHeader)
            VStack(alignment: .leading, spacing: 7) {
                ForEach(suggestions, id: \.self) { item in
                    Button { pick(item) } label: {
                        Text(item).font(Forest.font(.subheadline))
                            .foregroundStyle(Forest.ink)
                            .multilineTextAlignment(.leading)
                            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                            .padding(.horizontal, 14)
                            .padding(.vertical, 3)
                            .background(Forest.surface, in: RoundedRectangle(cornerRadius: 14))
                            .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(Forest.line).allowsHitTesting(false))
                    }.buttonStyle(.plain)
                }
            }
            if let note {
                Text(note).font(Forest.font(.footnote)).foregroundStyle(Forest.softText).multilineTextAlignment(.center)
                    .padding(.vertical, 10).padding(.horizontal, 14)
                    .background(Forest.panel, in: RoundedRectangle(cornerRadius: 12))
            }
        }
        .frame(maxWidth: 380).frame(maxWidth: .infinity).padding(.top, 48)
    }
}

/// The user reads their own messages in a bubble on the leading side of the thread.
struct ChatTurn: View {
    let mine: Bool
    let text: String
    var messageId: String? = nil
    var showsActions = true
    @State private var revealedActions = false

    var body: some View {
        if mine {
            HStack {
                let bubble = UnevenRoundedRectangle(
                    topLeadingRadius: 7, bottomLeadingRadius: 19,
                    bottomTrailingRadius: 19, topTrailingRadius: 19
                )
                Text(text)
                    .font(Forest.font())
                    .foregroundStyle(Forest.ink)
                    .lineSpacing(5)
                    .textSelection(.enabled)
                    .padding(.vertical, 10)
                    .padding(.horizontal, 14)
                    .background(Forest.soft, in: bubble)
                    .overlay { bubble.strokeBorder(Forest.line) }
                    .accessibilityLabel(Text("أنت، \(text)"))
                Spacer(minLength: 40)
            }
        } else {
            VStack(alignment: .leading, spacing: 0) {
                ReplyText(text: text) { revealedActions = true }
                    .contentShape(Rectangle())
                    .simultaneousGesture(LongPressGesture().onEnded { _ in revealedActions = true })
                if !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    let visible = showsActions || revealedActions
                    HStack(spacing: 2) {
                        CopyReplyButton(text: text)
                        if let messageId { FeedbackButtons(messageId: messageId) }
                    }
                    .padding(.top, 5)
                    // Keep the rating state when a newer reply arrives.
                    .frame(height: visible ? nil : 0)
                    .opacity(visible ? 1 : 0)
                    .allowsHitTesting(visible)
                    .accessibilityHidden(!visible)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityElement(children: .contain)
            .accessibilityLabel("رد موحسن")
        }
    }
}

/// Reply links open through the screen's https-only openURL action.
struct ReplyText: View {
    private struct Focus: Hashable {
        let block: Int
        var row = 0
        var column = 0
    }

    let text: String
    let onFocus: () -> Void
    @AccessibilityFocusState private var focusedPart: Focus?
    @ScaledMetric(relativeTo: .subheadline) private var columnWidth: CGFloat = 128

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            ForEach(Array(ReplyMarkdown.blocks(text).enumerated()), id: \.offset) { index, block in
                switch block {
                case .paragraph(let paragraph):
                    markdownText(paragraph)
                        .lineSpacing(6)
                        .accessibilityFocused($focusedPart, equals: Focus(block: index))
                case .heading(let heading):
                    markdownText(heading, style: .headline, weight: .semibold)
                        .lineSpacing(5)
                        .accessibilityAddTraits(.isHeader)
                        .accessibilityFocused($focusedPart, equals: Focus(block: index))
                case .quote(let parts):
                    VStack(alignment: .leading, spacing: 8) {
                        ForEach(Array(parts.enumerated()), id: \.offset) { row, part in
                            markdownText(part)
                                .lineSpacing(6)
                                .accessibilityFocused($focusedPart, equals: Focus(block: index, row: row))
                        }
                    }
                    .foregroundStyle(Forest.softText)
                    .padding(.leading, 12)
                    .overlay(alignment: .leading) {
                        Rectangle().fill(Forest.accent).frame(width: 2).accessibilityHidden(true)
                    }
                case .list(let ordered, let items):
                    VStack(alignment: .leading, spacing: 8) {
                        ForEach(Array(items.enumerated()), id: \.offset) { row, item in
                            HStack(alignment: .firstTextBaseline, spacing: 9) {
                                Text(ordered ? "\((row + 1).formatted(.number.locale(Locale(identifier: "ar"))))." : "•")
                                    .font(Forest.font(.subheadline, weight: .semibold))
                                    .foregroundStyle(Forest.accent)
                                    .accessibilityHidden(true)
                                markdownText(item)
                                    .lineSpacing(6)
                                    .accessibilityValue(ordered ? Text("البند \(row + 1)") : Text(""))
                                    .accessibilityFocused($focusedPart, equals: Focus(block: index, row: row))
                            }
                        }
                    }
                case .code(let code):
                    ScrollView(.horizontal) {
                        Text(code)
                            .font(.system(.footnote, design: .monospaced))
                            .lineSpacing(4)
                            .padding(12)
                            .accessibilityLabel(Text("مقطع برمجي، \(code)"))
                            .accessibilityFocused($focusedPart, equals: Focus(block: index))
                    }
                    .background(Forest.soft, in: RoundedRectangle(cornerRadius: 12))
                    .environment(\.layoutDirection, .leftToRight)
                case .table(let headers, let rows):
                    table(headers: headers, rows: rows, block: index)
                }
            }
        }
        .foregroundStyle(Forest.ink)
        .multilineTextAlignment(.leading)
        .textSelection(.enabled)
        .frame(maxWidth: .infinity, alignment: .leading)
        .onChange(of: focusedPart) { _, focused in
            if focused != nil { onFocus() }
        }
    }

    private func table(headers: [String], rows: [[String]], block: Int) -> some View {
        let shape = RoundedRectangle(cornerRadius: 14)
        return ScrollView(.horizontal) {
            Grid(alignment: .topLeading, horizontalSpacing: 0, verticalSpacing: 0) {
                tableRow(headers, headers: headers, block: block, row: 0, lastRow: rows.count)
                ForEach(Array(rows.enumerated()), id: \.offset) { index, values in
                    tableRow(values, headers: headers, block: block, row: index + 1, lastRow: rows.count)
                }
            }
        }
        .background(Forest.surface)
        .clipShape(shape)
        .overlay { shape.strokeBorder(Forest.line).allowsHitTesting(false).accessibilityHidden(true) }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("جدول الرد")
        .accessibilityHint("مرّر أفقيًا لعرض بقية الأعمدة")
    }

    private func tableRow(_ cells: [String], headers: [String], block: Int, row: Int, lastRow: Int) -> some View {
        GridRow {
            ForEach(Array(cells.enumerated()), id: \.offset) { column, cell in
                markdownText(cell.isEmpty ? "—" : cell, style: .subheadline, weight: row == 0 ? .semibold : .regular)
                    .lineSpacing(4)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 10)
                    .frame(width: columnWidth, alignment: .leading)
                    .frame(minHeight: 44, maxHeight: .infinity, alignment: .topLeading)
                    .background(row == 0 ? Forest.accentSoft : Forest.surface)
                    .overlay(alignment: .trailing) {
                        if column < cells.count - 1 { Rectangle().fill(Forest.line).frame(width: 1) }
                    }
                    .overlay(alignment: .bottom) {
                        if row < lastRow { Rectangle().fill(Forest.line).frame(height: 1) }
                    }
                    .accessibilityAddTraits(row == 0 ? .isHeader : [])
                    .accessibilityValue(row == 0 ? Text("") : Text(ReplyMarkdown.plainText(headers[column])))
                    .accessibilityFocused($focusedPart, equals: Focus(block: block, row: row, column: column))
            }
        }
    }

    private func markdownText(_ source: String, style: Font.TextStyle = .body, weight: Font.Weight = .regular) -> Text {
        var content = ReplyMarkdown.inline(source)
        let runs = content.runs.map { (range: $0.range, intent: $0.inlinePresentationIntent, linked: $0.link != nil) }
        for run in runs {
            if run.intent?.contains(.code) == true {
                content[run.range].swiftUI.font = .system(style, design: .monospaced)
            } else if run.intent?.contains(.stronglyEmphasized) == true {
                content[run.range].swiftUI.font = Forest.font(style, weight: .bold)
            }
            if run.linked {
                content[run.range].swiftUI.foregroundColor = Forest.accent
                content[run.range].swiftUI.underlineStyle = .single
            }
        }
        return Text(content).font(Forest.font(style, weight: weight))
    }
}

/// Copies one reply using the same plain-text representation as the web.
struct CopyReplyButton: View {
    let text: String
    @State private var copiedAt: Date?

    var body: some View {
        Button {
            UIPasteboard.general.string = ReplyMarkdown.plainText(text)
            UIImpactFeedbackGenerator(style: .light).impactOccurred()
            copiedAt = Date()
            UIAccessibility.post(notification: .announcement, argument: "تم النسخ")
        } label: {
            HStack(spacing: 4) {
                Image(systemName: copiedAt == nil ? "doc.on.doc" : "checkmark")
                    .font(.callout.weight(.semibold))
                if copiedAt != nil {
                    Text("تم النسخ").font(Forest.font(.caption, weight: .medium))
                }
            }
            .frame(minWidth: 44, minHeight: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .foregroundStyle(copiedAt == nil ? Forest.softText : Forest.accent)
        .accessibilityLabel(copiedAt == nil ? "نسخ الرد" : "تم نسخ الرد")
        .task(id: copiedAt) {
            guard copiedAt != nil else { return }
            do { try await Task.sleep(for: .seconds(1.8)) } catch { return }
            copiedAt = nil
        }
    }
}

/// The same rating choices and request as on the web.
struct FeedbackButtons: View {
    @EnvironmentObject private var store: WaslaStore
    let messageId: String
    @State private var sent = false
    @State private var busy = false

    var body: some View {
        Menu {
            Button("مفيد") { rate("useful") }
            Button("خطأ") { rate("wrong") }
            Button("ناقص") { rate("incomplete") }
        } label: {
            Group {
                if busy {
                    ProgressView().controlSize(.small)
                } else {
                    Image(systemName: sent ? "checkmark" : "hand.thumbsup")
                        .font(.callout.weight(.semibold))
                }
            }
            .frame(minWidth: 44, minHeight: 44)
            .contentShape(Rectangle())
        }
        .foregroundStyle(sent ? Forest.accent : Forest.softText)
        .disabled(busy || sent)
        .accessibilityLabel(sent ? "أُرسل تقييمك" : busy ? "جارٍ إرسال التقييم" : "قيّم هذا الرد")
        .simultaneousGesture(TapGesture().onEnded {
            if !busy && !sent { UIImpactFeedbackGenerator(style: .light).impactOccurred() }
        })
    }

    private func rate(_ verdict: String) {
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        busy = true
        Task {
            sent = await store.feedback(verdict, for: messageId)
            busy = false
        }
    }
}

/// Shows the current phase and, when provided, the server's recent steps.
struct WorkingSteps: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let progress: String
    let steps: [String]
    var typing = false
    @State private var open = false
    /// When the pill appeared; the counter runs from here.
    @State private var since = Date()
    var body: some View {
        VStack(alignment: .leading, spacing: 9) {
            if steps.isEmpty {
                status
            } else {
                Button {
                    withAnimation(reduceMotion ? nil : .easeOut(duration: 0.2)) { open.toggle() }
                } label: {
                    status
                }
                .buttonStyle(.plain)
                .accessibilityHint(open ? "إخفاء خطوات العمل" : "عرض خطوات العمل")
            }
            if open {
                VStack(alignment: .leading, spacing: 9) {
                    ForEach(Array(steps.enumerated()), id: \.offset) { _, step in
                        Text(step).font(Forest.font(.subheadline)).fixedSize(horizontal: false, vertical: true)
                    }
                }
                .foregroundStyle(Forest.softText)
                .padding(.leading, 14)
                .overlay(alignment: .leading) { Rectangle().fill(Forest.line).frame(width: 2) }
                .padding(.leading, 12)
            }
        }
    }

    private var status: some View {
        HStack(spacing: 12) {
            ActivityLine(text: progress, since: since, typing: typing)
            if !steps.isEmpty {
                Image(systemName: open ? "chevron.up" : "chevron.down")
                    .font(.system(size: 11, weight: .semibold))
                    .accessibilityHidden(true)
            }
        }
        .frame(minHeight: 44)
        .padding(.horizontal, 13)
        .padding(.vertical, 3)
        .foregroundStyle(Forest.softText)
        .background(Forest.surface, in: RoundedRectangle(cornerRadius: 16))
        .overlay(RoundedRectangle(cornerRadius: 16).strokeBorder(Forest.line).allowsHitTesting(false))
    }
}

/// The kind of work the live words name; the symbol beside them follows. The same rules as the web's
/// activity-phase.ts, tried in order with the first match winning; anything else is thinking.
enum ActivityKind {
    case think, wait, memory, search, open, read, write, act

    private static let rules: [(ActivityKind, String)] = [
        (.think, "يفهم|يفكر|يختار الخطوة|يرتب خطوته|يحسب|^حساب "),
        (.wait, "مشغول|سأستأنف|ينتظر|انتظار|\\bwait"),
        (.memory, "الذاكرة|يتذكر|المستندات المحفوظة|\\bmemory"),
        (.search, "يبحث|بحث|\\bsearch"),
        (.read, "يقرأ|قراءة|يستخرج|يفحص|فحص|\\bread"),
        (.open, "يفتح|فتح|\\bopen"),
        (.write, "يكتب|كتابة|الكتابة|يصوغ|يراجع|يحفظ|حفظ|ينشئ|إنشاء|يعدّ|إعداد|\\b(?:writ|draft|sav)"),
        (.act, "ينقر|النقر|يضغط|الضغط|يمرّر|التمرير|ينفذ|تنفيذ|يرسل|إرسال|يسجّل الدخول|تسجيل الدخول|يدخل|إدخال|يختار|اختيار|يرجع|الرجوع|يحمّل|تحميل|يغيّر|تغيير|يبدأ|بدء|\\b(?:click|press|type)"),
    ]

    static func from(_ text: String) -> ActivityKind {
        let value = text.trimmingCharacters(in: .whitespacesAndNewlines)
        for (kind, pattern) in rules where value.range(of: pattern, options: [.regularExpression, .caseInsensitive]) != nil { return kind }
        return .think
    }

    var symbol: String {
        switch self {
        case .think: return "sparkles"
        case .wait: return "clock"
        case .memory: return "brain.head.profile"
        case .search: return "magnifyingglass"
        case .open: return "globe"
        case .read: return "book"
        case .write: return "pencil.line"
        case .act: return "hand.tap"
        }
    }
}

/// Time since the request, shown only once it has lasted five seconds, so a quick answer never flashes a counter.
func elapsedLabel(seconds: Int) -> String? {
    guard seconds >= 5 else { return nil }
    return seconds < 60 ? "\(seconds) ث" : "\(seconds / 60) د \(seconds % 60) ث"
}

/// Uses the server's own progress text and adds elapsed time for longer runs.
struct ActivityLine: View {
    let text: String
    let since: Date
    let typing: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    var body: some View {
        let kind = ActivityKind.from(text)
        HStack(alignment: .firstTextBaseline, spacing: 9) {
            Image(systemName: typing ? "ellipsis" : kind.symbol)
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(Forest.accent)
                .symbolEffect(.pulse, options: .repeating, isActive: !reduceMotion)
                .frame(width: 16, height: 16)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 3) {
                Text(text).font(Forest.font(.subheadline))
                    .fixedSize(horizontal: false, vertical: true)
                    .id(text)
                    .transition(reduceMotion ? .identity : .opacity)
                TimelineView(.periodic(from: since, by: 1)) { context in
                    let seconds = Int(context.date.timeIntervalSince(since))
                    if let label = elapsedLabel(seconds: seconds) {
                        Text(label).font(.caption.monospacedDigit())
                            .accessibilityLabel("الوقت المنقضي \(seconds) ثانية")
                    }
                }
            }
        }
        .animation(reduceMotion ? nil : .easeOut(duration: 0.2), value: text)
        .accessibilityElement(children: .combine)
    }
}

// MARK: - Screens

struct RootView: View {
    @EnvironmentObject private var store: WaslaStore
    private var errorTitle: String {
        if store.errorMessage?.hasPrefix("تعذّر الوصول إلى الخادم") == true { return "تعذّر الاتصال" }
        return "تعذّر إكمال الإجراء"
    }

    var body: some View {
        Group {
            switch store.account {
            case .loading:
                VStack(spacing: 18) {
                    ForestMark()
                    ProgressView("جارٍ تحميل موحسن…")
                        .font(Forest.font(.footnote)).tint(Forest.accent).foregroundStyle(Forest.softText)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity).background(Forest.background)
            case .signedOut:
                SignInView()
            case .signedIn:
                ChatView()
            }
        }
        .alert(errorTitle, isPresented: Binding(get: { store.errorMessage != nil }, set: { if !$0 { store.errorMessage = nil } })) {
            Button("حسنًا", role: .cancel) { store.errorMessage = nil }
        } message: { Text(store.errorMessage ?? "") }
    }
}

private struct ForestMark: View {
    var body: some View {
        Text("م").font(Forest.font(.title2, weight: .semibold))
            .padding(12).frame(minWidth: 52, minHeight: 52)
            .foregroundStyle(Forest.onAccent)
            .background(Forest.accent, in: RoundedRectangle(cornerRadius: 16))
            .accessibilityHidden(true)
    }
}

extension View {
    func forestSheetChrome(_ title: String, done: @escaping () -> Void) -> some View {
        navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbarBackground(Forest.background, for: .navigationBar)
            .toolbarBackground(.visible, for: .navigationBar)
            .toolbar {
                ToolbarItem(placement: .principal) {
                    Text(title).font(Forest.font(.headline, weight: .semibold))
                        .foregroundStyle(Forest.ink).accessibilityAddTraits(.isHeader)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(action: done) {
                        Text("تم").font(Forest.font(.subheadline, weight: .semibold))
                            .foregroundStyle(Forest.accent).padding(.horizontal, 12).padding(.vertical, 5)
                            .background(Forest.accentSoft, in: Capsule())
                            .frame(minWidth: 44, minHeight: 44).contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("تم، إغلاق \(title)")
                }
            }
    }

    func forestInput(focused: Bool = false) -> some View {
        font(Forest.font())
            .foregroundStyle(Forest.ink)
            .padding(.horizontal, 13).padding(.vertical, 10).frame(minHeight: 44)
            .background(Forest.background, in: RoundedRectangle(cornerRadius: 12))
            .overlay {
                RoundedRectangle(cornerRadius: 12).strokeBorder(focused ? Forest.accent : Forest.controlBorder)
                    .allowsHitTesting(false)
            }
    }
}

/// Signing in with the owner's account on the cloud server, as on the web.
struct SignInView: View {
    private enum Field: Hashable { case email, password }
    @EnvironmentObject private var store: WaslaStore
    @State private var email = ""
    @State private var password = ""
    @FocusState private var focused: Field?
    private var ready: Bool { !email.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !password.isEmpty && !store.signingIn }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 22) {
                    ForestMark()
                    ScreenTitle(title: "سجّل الدخول إلى موحسن", subtitle: "استخدم حسابك على الويب للوصول إلى محادثاتك.")
                    Card {
                        field("البريد الإلكتروني") {
                            TextField("البريد الإلكتروني", text: $email, prompt: Text("name@example.com").foregroundColor(Forest.softText))
                                .keyboardType(.emailAddress).textContentType(.username)
                                .textInputAutocapitalization(.never).autocorrectionDisabled()
                                .environment(\.layoutDirection, .leftToRight)
                                .focused($focused, equals: .email)
                                .submitLabel(.next)
                                .onSubmit { focused = .password }
                                .forestInput(focused: focused == .email)
                                .accessibilityLabel("البريد الإلكتروني")
                        }
                        field("كلمة المرور") {
                            SecureField("", text: $password)
                                .textContentType(.password)
                                .environment(\.layoutDirection, .leftToRight)
                                .focused($focused, equals: .password)
                                .submitLabel(.go)
                                .onSubmit { submit() }
                                .forestInput(focused: focused == .password)
                                .accessibilityLabel("كلمة المرور")
                        }
                    }
                    Button { submit() } label: {
                        if store.signingIn {
                            ProgressView("جارٍ تسجيل الدخول…").tint(Forest.accent)
                        } else {
                            Label("دخول", systemImage: "arrow.left")
                        }
                    }
                    .buttonStyle(ForestButton()).disabled(!ready)
                    Text(store.origin.host ?? "").font(Forest.font(.footnote)).foregroundStyle(Forest.softText)
                        .frame(maxWidth: .infinity, alignment: .center).environment(\.layoutDirection, .leftToRight)
                }
                .padding(24).frame(maxWidth: 620).frame(maxWidth: .infinity)
                .disabled(store.signingIn)
            }
            .scrollDismissesKeyboard(.interactively)
            .background(Forest.background)
            .navigationTitle("موحسن").navigationBarTitleDisplayMode(.inline)
            .toolbarBackground(Forest.background, for: .navigationBar)
            .toolbarBackground(.visible, for: .navigationBar)
        }
    }

    private func submit() {
        guard ready else { return }
        focused = nil
        let address = email, secret = password
        Task {
            await store.signIn(email: address, password: secret)
            if store.signedIn { password = "" }
        }
    }

    private func field<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title).font(Forest.font(.subheadline, weight: .semibold)).accessibilityHidden(true)
            content()
        }
    }
}

struct SettingsView: View {
    let onOpenConversation: (String) -> Void
    @EnvironmentObject private var store: WaslaStore
    @EnvironmentObject private var pushNotifications: PushNotifications
    @Environment(\.openURL) private var openURL
    @Environment(\.dismiss) private var dismiss
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @AppStorage(AppAppearance.storageKey) private var appearance: AppAppearance = .dark
    @State private var signOutConfirm = false

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 22) {
                    settingsSection("الحساب") {
                        Card {
                            accountRow("البريد", value: store.email ?? "—", icon: "person.crop.circle")
                            Rectangle().fill(Forest.line).frame(height: 1).accessibilityHidden(true)
                            accountRow("الخادم", value: store.origin.host ?? "", icon: "server.rack")
                            Rectangle().fill(Forest.line).frame(height: 1).accessibilityHidden(true)
                            Button(role: .destructive) { signOutConfirm = true } label: {
                                HStack(spacing: 12) {
                                    rowIcon("rectangle.portrait.and.arrow.right", alert: true)
                                    Text("تسجيل الخروج").font(Forest.font(.subheadline, weight: .medium))
                                    Spacer(minLength: 0)
                                }
                                .frame(minHeight: 44).contentShape(Rectangle())
                                .foregroundStyle(Forest.alert)
                            }
                            .buttonStyle(.plain)
                        }
                    }
                    settingsSection("المظهر") {
                        Card {
                            if dynamicTypeSize.isAccessibilitySize {
                                appearancePicker.pickerStyle(.menu)
                            } else {
                                appearanceSegments
                            }
                        }
                    }
                    settingsSection("الإشعارات") {
                        notificationSettings
                    }
                    if store.smartMonitorsAvailable {
                        settingsSection("المراقبات") {
                            MonitorSettingsList(onOpenConversation: onOpenConversation)
                        }
                    }
                    settingsSection("ما يعمل الآن") {
                        settingsNote(store.capabilities?.localModeText ?? (store.capabilities == nil ? "لم تُقرأ قدرات هذه الجلسة بعد." : "نموذج لغوي متصل، والردود الحرة متاحة."))
                    }
                    settingsSection("حول") {
                        settingsNote("التطبيق نافذة إلى موحسن على الخادم السحابي، كما في الويب: المحادثات والعقل والأسئلة والموافقات والتحكم بالكمبيوتر تجري هناك. لا يحتاج الهاتف إلى الكمبيوتر ليحادث موحسن.")
                    }
                }
                .padding(.horizontal, 22).padding(.vertical, 18)
                .frame(maxWidth: 620).frame(maxWidth: .infinity)
            }
            .background(Forest.background)
            .forestSheetChrome("الإعدادات") { dismiss() }
            .confirmationDialog("تسجيل الخروج من هذا الهاتف؟", isPresented: $signOutConfirm, titleVisibility: .visible) {
                Button("تسجيل الخروج", role: .destructive) { Task { await store.signOut() } }
            } message: { Text("تبقى محادثاتك على الخادم. ويتوقف أي تحكم بالكمبيوتر من هذا الهاتف.") }
        }
        .environment(\.layoutDirection, .rightToLeft)
    }

    private var notificationSettings: some View {
        VStack(alignment: .leading, spacing: 8) {
            Card {
                VStack(spacing: 8) {
                    Toggle(isOn: Binding(get: { pushNotifications.enabled }, set: { pushNotifications.setEnabled($0) })) {
                        HStack(spacing: 12) {
                            rowIcon("bell")
                            Text("إشعارات المهام").font(Forest.font(.subheadline, weight: .medium))
                        }
                    }
                    .tint(Forest.accent)
                    .frame(minHeight: 44)
                    .disabled(pushNotifications.requestingPermission)
                    Rectangle().fill(Forest.line).frame(height: 1).accessibilityHidden(true)
                    notificationSystemRow("الصوت", value: soundSetting, icon: "speaker.wave.2")
                    Rectangle().fill(Forest.line).frame(height: 1).accessibilityHidden(true)
                    notificationSystemRow("عرض أول سطر على شاشة القفل", value: previewSetting, icon: "lock")
                }
            }
            Text("يصلك إشعار عند اكتمال المهمة أو عند الحاجة إلى تدخّلك. يضبط iOS الصوت ومعاينات شاشة القفل.")
                .font(Forest.font(.footnote)).foregroundStyle(Forest.softText)
                .lineSpacing(5).padding(.horizontal, 2)
            if pushNotifications.settings?.authorizationStatus == .denied {
                Text("اسمح بإشعارات موحسن في إعدادات iOS ثم فعّلها هنا.")
                    .font(Forest.font(.footnote)).foregroundStyle(Forest.softText).padding(.horizontal, 2)
            }
            if let problem = pushNotifications.problem {
                Text(problem).font(Forest.font(.footnote)).foregroundStyle(Forest.alert)
                    .padding(.horizontal, 2)
            }
        }
    }

    private var soundSetting: String? {
        guard let feature = pushNotifications.settings?.soundSetting else { return nil }
        return feature == .enabled ? "مفعّل" : "موقوف"
    }

    private var previewSetting: String? {
        switch pushNotifications.settings?.showPreviewsSetting {
        case .some(.always): return "ظاهر"
        case .some(.whenAuthenticated): return "بعد فتح القفل"
        case .some(.never): return "مخفي"
        default: return nil
        }
    }

    private func notificationSystemRow(_ title: String, value: String?, icon: String) -> some View {
        Button {
            if let url = URL(string: UIApplication.openNotificationSettingsURLString) { openURL(url) }
        } label: {
            HStack(spacing: 12) {
                rowIcon(icon)
                VStack(alignment: .leading, spacing: 2) {
                    Text(title).font(Forest.font(.subheadline, weight: .medium)).foregroundStyle(Forest.ink)
                    if let value {
                        Text(value).font(Forest.font(.footnote)).foregroundStyle(Forest.softText)
                    }
                }
                Spacer(minLength: 0)
                Image(systemName: "chevron.forward").foregroundStyle(Forest.softText).accessibilityHidden(true)
            }
            .frame(minHeight: 44).contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityHint("يفتح إعدادات إشعارات موحسن في iOS")
    }

    private var appearancePicker: some View {
        Picker("مظهر التطبيق", selection: $appearance) {
            ForEach(AppAppearance.allCases) { option in
                Text(option.title).tag(option)
            }
        }
        .font(Forest.font(.subheadline)).frame(minHeight: 44)
    }

    private var appearanceSegments: some View {
        HStack(spacing: 3) {
            ForEach(AppAppearance.allCases) { option in
                let selected = appearance == option
                Button { appearance = option } label: {
                    Text(option.title).font(Forest.font(.caption, weight: .semibold))
                        .multilineTextAlignment(.center).padding(.horizontal, 4)
                        .frame(maxWidth: .infinity, minHeight: 44)
                        .foregroundStyle(selected ? Forest.accent : Forest.softText)
                        .background(selected ? Forest.accentSoft : Color.clear, in: RoundedRectangle(cornerRadius: 10))
                        .overlay {
                            if selected {
                                RoundedRectangle(cornerRadius: 10).strokeBorder(Forest.accent)
                                    .allowsHitTesting(false)
                            }
                        }
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain).accessibilityAddTraits(selected ? .isSelected : [])
            }
        }
        .padding(3).background(Forest.background, in: RoundedRectangle(cornerRadius: 13))
        .accessibilityElement(children: .contain).accessibilityLabel("مظهر التطبيق")
    }

    private func settingsSection<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title).font(Forest.font(.footnote, weight: .semibold)).foregroundStyle(Forest.softText)
                .padding(.horizontal, 2).accessibilityAddTraits(.isHeader)
            content()
        }
    }

    private func settingsNote(_ message: String) -> some View {
        Card { Text(message).font(Forest.font(.footnote)).foregroundStyle(Forest.softText).lineSpacing(5) }
    }

    private func accountRow(_ title: String, value: String, icon: String) -> some View {
        HStack(spacing: 12) {
            rowIcon(icon)
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(Forest.font(.subheadline, weight: .medium)).foregroundStyle(Forest.ink)
                Text(value).font(Forest.font(.footnote)).foregroundStyle(Forest.softText)
                    .environment(\.layoutDirection, .leftToRight)
            }
        }
        .accessibilityElement(children: .combine)
    }

    private func rowIcon(_ icon: String, alert: Bool = false) -> some View {
        Image(systemName: icon).font(.system(size: 16, weight: .medium))
            .frame(width: 36, height: 36).foregroundStyle(alert ? Forest.alert : Forest.accent)
            .background(alert ? Forest.alert.opacity(0.1) : Forest.accentSoft, in: RoundedRectangle(cornerRadius: 10))
            .accessibilityHidden(true)
    }
}

/// Remote control of the Windows app on the owner's PC: one switch, the PC's state in the owner's words, and
/// while it is on, the allowed window live with taps, typing, keys and scrolling. Mohassan can use the same
/// grant when the owner asks it in this phone's chat.
struct RemoteControlView: View {
    @EnvironmentObject private var store: WaslaStore
    @Environment(\.dismiss) private var dismiss
    @State private var stopConfirm = false
    @State private var typed = ""
    @State private var rightClick = false
    @FocusState private var typing: Bool

    private var readiness: RemoteReadiness? { store.remote }
    private var switchEnabled: Bool { !store.remoteBusy && (store.remoteWanted || readiness?.canTurnOn == true) }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    Card {
                        Toggle(isOn: Binding(get: { store.remoteWanted }, set: { store.setRemote($0) })) {
                            VStack(alignment: .leading, spacing: 4) {
                                Text("التحكم عن بُعد بتطبيق Windows").font(Forest.font(.headline, weight: .semibold))
                                Text(readiness?.title ?? (store.windowsProblem == nil ? "جارٍ قراءة حالة الكمبيوتر…" : "تعذّرت قراءة حالة الكمبيوتر"))
                                    .font(Forest.font(.footnote)).foregroundStyle(store.remoteWanted ? Forest.accent : Forest.softText)
                            }
                        }
                        .tint(Forest.accent)
                        .disabled(!switchEnabled)
                        if store.remoteBusy {
                            ProgressView().tint(Forest.accent).frame(maxWidth: .infinity)
                                .accessibilityLabel("جارٍ تحديث حالة التحكم بالكمبيوتر")
                        }
                        if let readiness, !readiness.advice.isEmpty { Text(readiness.advice).foregroundStyle(Forest.softText) }
                        if let problem = store.windowsProblem { Label(problem, systemImage: "exclamationmark.triangle").foregroundStyle(Forest.alert) }
                        if let note = store.remoteNote { Text(note).foregroundStyle(Forest.alert) }
                    }
                    .font(Forest.font(.footnote)).lineSpacing(5)
                    if readiness == .noDevice { pairingCard }
                    if store.remoteWanted {
                        screenCard
                        controlsCard
                    }
                    if store.remoteWanted || readiness?.on == true {
                        Button("إيقاف كامل (STOP)", role: .destructive) { stopConfirm = true }
                            .buttonStyle(ForestButton(prominent: false))
                    }
                    Text("حين يكون المفتاح مشغّلًا يستطيع موحسن أيضًا رؤية النافذة المسموحة والتحكم بها عندما تطلب ذلك في محادثة هذا الهاتف. السماح نفسه يبقى بيدك على الكمبيوتر في Mohassan Companion، وقفل الكمبيوتر يوقف كل شيء.")
                        .font(Forest.font(.footnote)).foregroundStyle(Forest.softText).lineSpacing(5)
                }
                .padding(.horizontal, 22).padding(.vertical, 18)
                .frame(maxWidth: 620).frame(maxWidth: .infinity)
            }
            .scrollDismissesKeyboard(.interactively)
            .background(Forest.background)
            .forestSheetChrome("الكمبيوتر") { dismiss() }
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button { Task { await store.loadWindows() } } label: {
                        Image(systemName: "arrow.clockwise").font(.system(size: 16, weight: .medium))
                            .frame(width: 44, height: 44).contentShape(Rectangle())
                    }
                    .disabled(store.remoteBusy).accessibilityLabel("تحديث حالة الكمبيوتر")
                }
            }
            .refreshable { await store.loadWindows() }
            .task { await store.loadWindows() }
            .onAppear { store.remoteScreenOpened() }
            .onDisappear { store.remoteScreenClosed() }
            .confirmationDialog("إيقاف كل شيء على الكمبيوتر؟", isPresented: $stopConfirm, titleVisibility: .visible) {
                Button("أوقف كل شيء", role: .destructive) { Task { await store.stopRemoteCompletely() } }
            } message: { Text("يتوقف التحكم والمشاهدة فورًا، ويلزم سماح جديد في Mohassan Companion على الكمبيوتر قبل التحكم مرة أخرى.") }
        }
        .environment(\.layoutDirection, .rightToLeft)
    }

    private var pairingCard: some View {
        Card {
            Label("ربط كمبيوتر", systemImage: "link").font(Forest.font(.headline, weight: .semibold))
                .accessibilityAddTraits(.isHeader)
            if let pairing = store.pairing {
                Text(pairing.code).font(.system(.title3, design: .monospaced)).textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .center).environment(\.layoutDirection, .leftToRight)
                Button { UIPasteboard.general.string = pairing.code } label: { Label("نسخ الرمز", systemImage: "doc.on.doc") }
                    .buttonStyle(ForestButton(prominent: false))
                Text("في Mohassan Companion على الكمبيوتر ألصق الرمز في «رمز الربط من مساحة العمل (دقيقتان)» ثم اضغط «ربط الجهاز محليًا». ينتهي الرمز خلال دقيقتين.")
                    .foregroundStyle(Forest.softText)
            } else {
                Text("يلزم برنامج Mohassan Companion على الكمبيوتر. أنشئ رمزًا هنا، ثم ألصقه فيه.").foregroundStyle(Forest.softText)
                Button { Task { await store.pairWindows() } } label: { Label("أنشئ رمز ربط", systemImage: "key") }
                    .buttonStyle(ForestButton()).disabled(store.remoteBusy)
            }
        }
        .font(Forest.font(.footnote)).lineSpacing(5)
    }

    private var screenCard: some View {
        Card {
            if let frame = store.remoteFrame {
                GeometryReader { geometry in
                    Image(uiImage: frame).resizable().scaledToFit()
                        .frame(width: geometry.size.width, height: geometry.size.height)
                        .contentShape(Rectangle())
                        .onTapGesture(coordinateSpace: .local) { location in
                            let width = max(geometry.size.width, 1), height = max(geometry.size.height, 1)
                            store.remoteAct(.click(x: Double(location.x / width), y: Double(location.y / height), right: rightClick))
                        }
                }
                .aspectRatio(frame.size.width / max(frame.size.height, 1), contentMode: .fit)
                .background(Color.black)
                .clipShape(RoundedRectangle(cornerRadius: 12))
                .environment(\.layoutDirection, .leftToRight)
                .accessibilityLabel("صورة حديثة من النافذة المسموحة على الكمبيوتر. المس مكانًا للنقر عليه.")
                if let at = store.remoteFrameAt {
                    Text("آخر صورة \(at.formatted(date: .omitted, time: .standard))")
                        .font(Forest.font(.caption)).foregroundStyle(Forest.softText)
                }
            } else {
                ProgressView("تحميل الشاشة…").frame(maxWidth: .infinity, minHeight: 160)
                    .font(Forest.font(.footnote)).tint(Forest.accent).foregroundStyle(Forest.softText)
            }
        }
    }

    private var controlsCard: some View {
        Card {
            Picker("نوع النقرة", selection: $rightClick) {
                Text("نقرة يسرى").tag(false)
                Text("نقرة يمنى").tag(true)
            }
            .pickerStyle(.segmented)
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 12) { scrollButtons }
                VStack(spacing: 8) { scrollButtons }
            }
            .buttonStyle(ForestButton(prominent: false))
            Text("نص يُكتب على الكمبيوتر (حتى ١٢٠ حرفًا)").font(Forest.font(.footnote)).foregroundStyle(Forest.softText)
                .accessibilityHidden(true)
            TextField("", text: $typed)
                .focused($typing).submitLabel(.send).onSubmit { sendTyped() }
                .forestInput(focused: typing)
                .accessibilityLabel("نص يُكتب على الكمبيوتر، حتى مئة وعشرين حرفًا")
            Button("اكتب على الكمبيوتر") { sendTyped() }
            .buttonStyle(ForestButton()).disabled(!WindowsAction.textFits(typed))
            HStack(spacing: 8) {
                key("Enter", "Enter", spoken: "مفتاح الإدخال")
                key("⌫", "Backspace", spoken: "حذف الحرف السابق")
                key("Tab", "Tab", spoken: "مفتاح الجدولة")
                key("Esc", "Escape", spoken: "مفتاح الهروب")
            }
            .environment(\.layoutDirection, .leftToRight)
            HStack(spacing: 8) {
                key("←", "ArrowLeft", spoken: "السهم الأيسر")
                key("↑", "ArrowUp", spoken: "السهم الأعلى")
                key("↓", "ArrowDown", spoken: "السهم الأسفل")
                key("→", "ArrowRight", spoken: "السهم الأيمن")
            }
            .environment(\.layoutDirection, .leftToRight)
        }
    }

    @ViewBuilder private var scrollButtons: some View {
        Button("تمرير لأعلى") { store.remoteAct(.scroll(3)) }
        Button("تمرير لأسفل") { store.remoteAct(.scroll(-3)) }
    }

    private func sendTyped() {
        guard WindowsAction.textFits(typed) else { return }
        typing = false
        store.remoteAct(.text(typed))
        typed = ""
    }

    private func key(_ title: String, _ name: String, spoken: String) -> some View {
        Button { store.remoteAct(.key(name)) } label: {
            Text(title).font(.system(.footnote, design: .monospaced)).foregroundStyle(Forest.ink)
                .frame(maxWidth: .infinity, minHeight: 44).contentShape(Rectangle())
                .background(Forest.soft, in: RoundedRectangle(cornerRadius: 12))
        }
        .buttonStyle(.plain).accessibilityLabel(spoken)
    }
}

struct BrowserDestination: Identifiable { let id = UUID(); let url: URL }
struct SafariView: UIViewControllerRepresentable {
    let url: URL
    func makeUIViewController(context: Context) -> SFSafariViewController { SFSafariViewController(url: url) }
    func updateUIViewController(_ controller: SFSafariViewController, context: Context) {}
}
