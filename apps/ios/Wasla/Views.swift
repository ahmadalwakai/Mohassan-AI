import SwiftUI
import UIKit
import SafariServices

// The web workspace's palette (apps/web/components/assistant-app.module.css), light and dark.
enum Forest {
    private static func pair(_ light: UInt32, _ dark: UInt32) -> Color {
        Color(uiColor: UIColor { $0.userInterfaceStyle == .dark ? UIColor(hex: dark) : UIColor(hex: light) })
    }
    static let background = pair(0xFAF9F6, 0x1E1D1B)   // --page
    static let panel = pair(0xF4F2ED, 0x181715)        // --panel
    static let surface = pair(0xFFFFFF, 0x292825)      // --raised
    static let ink = pair(0x22201C, 0xEDEBE5)          // --ink
    static let softText = pair(0x6B675F, 0xA6A298)     // --soft
    static let faint = pair(0x9A968C, 0x77746C)        // --faint
    static let line = pair(0xE7E4DC, 0x34322D)         // --line
    static let soft = pair(0xEFECE4, 0x2E2C28)         // --user / --hover
    static let accent = pair(0x1F6F5C, 0x4FB596)       // --accent
    static let accentSoft = pair(0xE3EFE9, 0x1F3A31)   // --accent-soft
    static let onAccent = pair(0xFFFFFF, 0x0F1F1A)     // --accent-ink
    static let alert = pair(0xA33A2C, 0xEE9383)        // --alert
}
extension UIColor {
    convenience init(hex: UInt32) {
        self.init(red: CGFloat((hex >> 16) & 0xFF) / 255, green: CGFloat((hex >> 8) & 0xFF) / 255, blue: CGFloat(hex & 0xFF) / 255, alpha: 1)
    }
}
func dismissKeyboard() { UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil) }

/// The web's .primary / .secondary buttons.
struct ForestButton: ButtonStyle {
    var prominent = true
    @Environment(\.isEnabled) private var enabled
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.body.weight(.medium))
            .frame(maxWidth: .infinity, minHeight: 24)
            .padding(.vertical, 10).padding(.horizontal, 14)
            .background(prominent ? (enabled ? Forest.accent : Forest.soft) : Color.clear, in: RoundedRectangle(cornerRadius: 10))
            .overlay { if !prominent { RoundedRectangle(cornerRadius: 10).stroke(Forest.line) } }
            .foregroundStyle(prominent ? (enabled ? Forest.onAccent : Forest.faint) : (enabled ? Forest.ink : Forest.faint))
            .opacity(configuration.isPressed ? 0.75 : 1)
    }
}
/// The web's .card: raised, a hairline border, a soft shadow.
struct Card<Content: View>: View {
    @ViewBuilder var content: Content
    var body: some View {
        VStack(alignment: .leading, spacing: 12) { content }
            .padding(.vertical, 16).padding(.horizontal, 18)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Forest.surface, in: RoundedRectangle(cornerRadius: 16))
            .overlay(RoundedRectangle(cornerRadius: 16).stroke(Forest.line))
            .shadow(color: .black.opacity(0.04), radius: 6, y: 2)
    }
}
struct ScreenTitle: View {
    let title: String
    let subtitle: String
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title).font(.system(size: 28, weight: .medium))
            Text(subtitle).font(.subheadline).foregroundStyle(Forest.softText)
        }.frame(maxWidth: .infinity, alignment: .leading).padding(.bottom, 4)
    }
}
/// Wraps chips onto new lines, centred, like the web's suggestions row.
struct ChipFlow: Layout {
    var spacing: CGFloat = 8
    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let rows = arrange(width: proposal.width ?? .infinity, subviews: subviews)
        let height = rows.map(\.height).reduce(0, +) + spacing * CGFloat(max(rows.count - 1, 0))
        return CGSize(width: proposal.width ?? rows.map(\.width).max() ?? 0, height: height)
    }
    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var y = bounds.minY
        for row in arrange(width: bounds.width, subviews: subviews) {
            var x = bounds.minX + (bounds.width - row.width) / 2
            for index in row.items {
                let size = subviews[index].sizeThatFits(.unspecified)
                subviews[index].place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(size))
                x += size.width + spacing
            }
            y += row.height + spacing
        }
    }
    private func arrange(width: CGFloat, subviews: Subviews) -> [(items: [Int], width: CGFloat, height: CGFloat)] {
        var rows: [(items: [Int], width: CGFloat, height: CGFloat)] = []
        var current: (items: [Int], width: CGFloat, height: CGFloat) = ([], 0, 0)
        for index in subviews.indices {
            let size = subviews[index].sizeThatFits(.unspecified)
            let next = current.items.isEmpty ? size.width : current.width + spacing + size.width
            if next > width, !current.items.isEmpty { rows.append(current); current = ([index], size.width, size.height) }
            else { current = (current.items + [index], next, max(current.height, size.height)) }
        }
        if !current.items.isEmpty { rows.append(current) }
        return rows
    }
}

// MARK: - The web chat layout

/// A thread that scrolls under a composer pinned above the keyboard. Sending clears focus, so the keyboard closes;
/// dragging the thread closes it too. While Mohassan works, an empty box shows «stop» and a typed one shows «send».
struct ChatScaffold<Thread: View>: View {
    @Binding var draft: String
    let placeholder: String
    let tooLong: Bool
    let canSend: Bool
    let working: Bool
    let scrollKey: Int
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
    @FocusState private var focused: Bool

    init(draft: Binding<String>, placeholder: String, tooLong: Bool, canSend: Bool, working: Bool, scrollKey: Int, showComposer: Bool = true,
         notice: String? = nil, tools: AnyView? = nil, tray: AnyView? = nil, onSend: @escaping () -> Bool, onStop: (() -> Void)? = nil,
         @ViewBuilder thread: () -> Thread) {
        _draft = draft
        self.placeholder = placeholder; self.tooLong = tooLong; self.canSend = canSend; self.working = working
        self.scrollKey = scrollKey; self.showComposer = showComposer; self.notice = notice; self.tools = tools; self.tray = tray
        self.onSend = onSend; self.onStop = onStop
        self.thread = thread()
    }

    private var empty: Bool { draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: 22) {
                    thread
                    Color.clear.frame(height: 1).id("bottom")
                }
                .padding(.horizontal, 16).padding(.top, 8).padding(.bottom, 12)
                .frame(maxWidth: 740).frame(maxWidth: .infinity)
            }
            .scrollDismissesKeyboard(.interactively)
            .onChange(of: scrollKey) { _, _ in withAnimation(.easeOut(duration: 0.25)) { proxy.scrollTo("bottom", anchor: .bottom) } }
            .onChange(of: focused) { _, on in
                guard on else { return }
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) { withAnimation(.easeOut(duration: 0.25)) { proxy.scrollTo("bottom", anchor: .bottom) } }
            }
            .safeAreaInset(edge: .bottom, spacing: 0) { if showComposer { composer } }
        }
    }

    private var composer: some View {
        VStack(spacing: 6) {
            if let notice {
                Label(notice, systemImage: "info.circle").font(.footnote).foregroundStyle(Forest.softText)
                    .frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 6)
            }
            if let tray { tray }
            HStack(alignment: .bottom, spacing: 8) {
                if let tools { tools }
                TextField(placeholder, text: $draft, axis: .vertical)
                    .lineLimit(1...6)
                    .focused($focused)
                    .submitLabel(.return)
                    .padding(.vertical, 7).padding(.horizontal, 6)
                if working, empty, let onStop {
                    Button(action: onStop) {
                        Image(systemName: "stop.fill").font(.footnote).frame(width: 36, height: 36)
                            .background(Forest.soft, in: RoundedRectangle(cornerRadius: 12)).foregroundStyle(Forest.ink)
                    }.accessibilityLabel("إيقاف")
                } else {
                    Button {
                        if onSend() { focused = false; dismissKeyboard() }
                    } label: {
                        Image(systemName: "arrow.up").font(.body.weight(.semibold)).frame(width: 36, height: 36)
                            .background(canSend ? Forest.accent : Forest.soft, in: RoundedRectangle(cornerRadius: 12))
                            .foregroundStyle(canSend ? Forest.onAccent : Forest.faint)
                    }
                    .disabled(!canSend)
                    .accessibilityLabel("إرسال الرسالة")
                }
            }
            .padding(.vertical, 8).padding(.leading, 10).padding(.trailing, 8)
            .background(Forest.surface, in: RoundedRectangle(cornerRadius: 20))
            .overlay(RoundedRectangle(cornerRadius: 20).stroke(focused ? Forest.faint : Forest.line))
            .shadow(color: .black.opacity(0.05), radius: 6, y: 2)
            if tooLong { Text("الرسالة أطول من المسموح. اختصرها قبل الإرسال.").font(.caption).foregroundStyle(Forest.alert) }
        }
        .padding(.horizontal, 12).padding(.top, 6).padding(.bottom, 8)
        .frame(maxWidth: 740).frame(maxWidth: .infinity)
        .background(Forest.background)
    }
}

/// The web's welcome: the mark, one question, suggestion chips, and what works without a language model.
struct ChatWelcome: View {
    let title: String
    let suggestions: [String]
    var note: String? = nil
    let pick: (String) -> Void
    var body: some View {
        VStack(spacing: 22) {
            Text("م").font(.system(size: 22, weight: .semibold)).frame(width: 46, height: 46)
                .background(Forest.accent, in: RoundedRectangle(cornerRadius: 14)).foregroundStyle(Forest.onAccent)
                .shadow(color: .black.opacity(0.06), radius: 4, y: 1)
            Text(title).font(.system(size: 26, weight: .medium)).multilineTextAlignment(.center)
            ChipFlow {
                ForEach(suggestions, id: \.self) { item in
                    Button { pick(item) } label: {
                        Text(item).font(.subheadline).padding(.vertical, 7).padding(.horizontal, 14)
                            .overlay(Capsule().stroke(Forest.line)).foregroundStyle(Forest.softText)
                    }.buttonStyle(.plain)
                }
            }
            if let note {
                Text(note).font(.footnote).foregroundStyle(Forest.softText).multilineTextAlignment(.center)
                    .padding(.vertical, 10).padding(.horizontal, 14)
                    .background(Forest.panel, in: RoundedRectangle(cornerRadius: 12))
            }
        }
        .frame(maxWidth: .infinity).padding(.top, 72)
    }
}

/// A user turn: a soft bubble on the reading side. An assistant turn: the reply's Markdown, no bubble,
/// with copy and rating under it, as on the web.
struct ChatTurn: View {
    let mine: Bool
    let text: String
    var messageId: String? = nil
    var body: some View {
        if mine {
            HStack {
                Text(text).textSelection(.enabled).lineSpacing(4)
                    .padding(.vertical, 10).padding(.horizontal, 16)
                    .background(Forest.soft, in: UnevenRoundedRectangle(topLeadingRadius: 6, bottomLeadingRadius: 18, bottomTrailingRadius: 18, topTrailingRadius: 18))
                Spacer(minLength: 48)
            }
        } else {
            VStack(alignment: .leading, spacing: 8) {
                ReplyText(text: text)
                if !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    HStack(spacing: 16) {
                        CopyReplyButton(text: text)
                        if let messageId { FeedbackButtons(messageId: messageId) }
                        Spacer(minLength: 0)
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

/// A reply in the web's Markdown subset: headings, lists, quotes, code, **bold**, `code` and links.
/// Links open through the screen's openURL action, which takes https only.
struct ReplyText: View {
    let text: String
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(Array(ReplyMarkdown.blocks(text).enumerated()), id: \.offset) { _, block in
                switch block {
                case .paragraph(let line):
                    Text(ReplyMarkdown.inline(line)).lineSpacing(6)
                case .heading(let line):
                    Text(ReplyMarkdown.inline(line)).font(.headline)
                case .quote(let parts):
                    VStack(alignment: .leading, spacing: 6) {
                        ForEach(Array(parts.enumerated()), id: \.offset) { _, part in Text(ReplyMarkdown.inline(part)).lineSpacing(4) }
                    }
                    .foregroundStyle(Forest.softText)
                    .padding(.leading, 12)
                    .overlay(alignment: .leading) { Rectangle().fill(Forest.line).frame(width: 3) }
                case .list(let ordered, let items):
                    VStack(alignment: .leading, spacing: 6) {
                        ForEach(Array(items.enumerated()), id: \.offset) { position, item in
                            HStack(alignment: .firstTextBaseline, spacing: 8) {
                                Text(ordered ? "\(position + 1)." : "•").monospacedDigit().foregroundStyle(Forest.softText)
                                Text(ReplyMarkdown.inline(item)).lineSpacing(4)
                            }
                        }
                    }
                case .code(let code):
                    ScrollView(.horizontal, showsIndicators: false) {
                        Text(code).font(.system(.footnote, design: .monospaced)).padding(12)
                    }
                    .background(Forest.soft, in: RoundedRectangle(cornerRadius: 10))
                    .environment(\.layoutDirection, .leftToRight)
                }
            }
        }
        .textSelection(.enabled)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// Copies one reply as plain text, without ** or > marks, so it pastes cleanly anywhere.
struct CopyReplyButton: View {
    let text: String
    @State private var copied = false
    var body: some View {
        Button {
            UIPasteboard.general.string = ReplyMarkdown.plainText(text)
            copied = true
            Task { @MainActor in
                try? await Task.sleep(for: .seconds(1.8))
                copied = false
            }
        } label: {
            Label(copied ? "تم النسخ" : "نسخ", systemImage: copied ? "checkmark" : "doc.on.doc").font(.caption)
        }
        .buttonStyle(.plain)
        .foregroundStyle(Forest.softText)
        .accessibilityLabel(copied ? "تم نسخ الرد" : "نسخ الرد")
    }
}

/// The owner's judgement of one reply, as on the web: useful, wrong or incomplete.
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
            Label(sent ? "شكرًا" : "قيّم الرد", systemImage: sent ? "checkmark" : "hand.thumbsup").font(.caption)
        }
        .foregroundStyle(Forest.softText)
        .disabled(busy || sent)
        .accessibilityLabel(sent ? "أُرسل تقييمك" : "قيّم هذا الرد")
    }
    private func rate(_ verdict: String) {
        busy = true
        Task {
            sent = await store.feedback(verdict, for: messageId)
            busy = false
        }
    }
}

/// The web's working pill and its step list.
struct WorkingSteps: View {
    let progress: String
    let steps: [String]
    @State private var open = false
    /// When the pill appeared; the counter runs from here.
    @State private var since = Date()
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Button { withAnimation(.easeOut(duration: 0.2)) { open.toggle() } } label: {
                HStack(spacing: 8) {
                    ActivityLine(text: progress, since: since)
                    if !steps.isEmpty { Image(systemName: "chevron.down").font(.caption2).rotationEffect(.degrees(open ? 180 : 0)) }
                }
                .padding(.vertical, 5).padding(.horizontal, 11)
                .background(Forest.surface, in: Capsule()).overlay(Capsule().stroke(Forest.line))
                .foregroundStyle(Forest.softText)
            }.buttonStyle(.plain).disabled(steps.isEmpty)
            if open {
                VStack(alignment: .leading, spacing: 6) { ForEach(Array(steps.enumerated()), id: \.offset) { _, step in Text(step).font(.subheadline) } }
                    .foregroundStyle(Forest.softText)
                    .padding(.leading, 14)
                    .overlay(alignment: .leading) { Rectangle().fill(Forest.line).frame(width: 2) }
                    .padding(.leading, 12)
            }
        }.accessibilityElement(children: .combine)
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

/// The live line: a symbol for the kind of work, the server's own words for what is happening now, and how
/// long it has taken. Only the server names the phase; the symbol and its motion follow the words.
struct ActivityLine: View {
    let text: String
    let since: Date
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    var body: some View {
        let kind = ActivityKind.from(text)
        HStack(spacing: 8) {
            Image(systemName: kind.symbol)
                .font(.footnote.weight(.semibold))
                .foregroundStyle(Forest.accent)
                .symbolEffect(.pulse, options: .repeating, isActive: !reduceMotion)
                .frame(width: 16, height: 16)
            ShimmerText(text: text, still: reduceMotion)
                .id(text)
                .transition(.opacity.combined(with: .move(edge: .bottom)))
            TimelineView(.periodic(from: since, by: 1)) { context in
                if let label = elapsedLabel(seconds: Int(context.date.timeIntervalSince(since))) {
                    Text(label).font(.caption2.monospacedDigit()).foregroundStyle(Forest.faint)
                }
            }
        }
        .animation(.easeOut(duration: 0.25), value: text)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(text)
    }
}

/// Words with a band of light sweeping across them while the work goes on.
struct ShimmerText: View {
    let text: String
    let still: Bool
    @State private var sweep = false
    var body: some View {
        Text(text).font(.subheadline).lineLimit(2)
            .foregroundStyle(Forest.softText)
            .overlay {
                if !still {
                    GeometryReader { geometry in
                        let band = max(geometry.size.width / 2, 40)
                        LinearGradient(colors: [.clear, Forest.ink, .clear], startPoint: .leading, endPoint: .trailing)
                            .frame(width: band)
                            .offset(x: sweep ? geometry.size.width : -band)
                    }
                    .mask { Text(text).font(.subheadline).lineLimit(2) }
                    .allowsHitTesting(false)
                }
            }
            .onAppear { withAnimation(.linear(duration: 2.4).repeatForever(autoreverses: false)) { sweep = true } }
    }
}

// MARK: - Screens

struct RootView: View {
    @EnvironmentObject private var store: WaslaStore
    var body: some View {
        Group {
            switch store.account {
            case .loading:
                ProgressView("موحسن").frame(maxWidth: .infinity, maxHeight: .infinity).background(Forest.background)
            case .signedOut:
                SignInView()
            case .signedIn:
                ChatView()
            }
        }
        .alert("تعذّر إكمال الإجراء", isPresented: Binding(get: { store.errorMessage != nil }, set: { if !$0 { store.errorMessage = nil } })) {
            Button("حسنًا", role: .cancel) { store.errorMessage = nil }
        } message: { Text(store.errorMessage ?? "") }
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
                    Text("م").font(.system(size: 26, weight: .semibold)).frame(width: 56, height: 56)
                        .background(Forest.accent, in: RoundedRectangle(cornerRadius: 16)).foregroundStyle(Forest.onAccent)
                    ScreenTitle(title: "سجّل الدخول إلى موحسن", subtitle: "بحسابك نفسه على الويب. المحادثات والعقل والأسئلة والموافقات على الخادم، والهاتف نافذة إليها.")
                    Card {
                        field("البريد الإلكتروني") {
                            TextField("name@example.com", text: $email)
                                .keyboardType(.emailAddress).textContentType(.username)
                                .textInputAutocapitalization(.never).autocorrectionDisabled()
                                .environment(\.layoutDirection, .leftToRight)
                                .focused($focused, equals: .email)
                                .submitLabel(.next)
                                .onSubmit { focused = .password }
                        }
                        field("كلمة المرور") {
                            SecureField("", text: $password)
                                .textContentType(.password)
                                .environment(\.layoutDirection, .leftToRight)
                                .focused($focused, equals: .password)
                                .submitLabel(.go)
                                .onSubmit { submit() }
                        }
                    }
                    Button { submit() } label: {
                        if store.signingIn { ProgressView().tint(Forest.onAccent) } else { Label("دخول", systemImage: "person.crop.circle.badge.checkmark") }
                    }
                    .buttonStyle(ForestButton()).disabled(!ready)
                    Text(store.origin.host ?? "").font(.footnote).foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, alignment: .center).environment(\.layoutDirection, .leftToRight)
                }
                .padding(24).frame(maxWidth: 620).frame(maxWidth: .infinity)
                .disabled(store.signingIn)
            }
            .background(Forest.background)
            .navigationTitle("موحسن").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItemGroup(placement: .keyboard) { Spacer(); Button("تم") { focused = nil } } }
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
            Text(title).font(.subheadline.weight(.semibold))
            content().padding(12).background(Forest.background, in: RoundedRectangle(cornerRadius: 12))
        }
    }
}

struct SettingsView: View {
    @EnvironmentObject private var store: WaslaStore
    @Environment(\.dismiss) private var dismiss
    @State private var signOutConfirm = false
    var body: some View {
        NavigationStack {
            List {
                Section("الحساب") {
                    LabeledContent("البريد", value: store.email ?? "—")
                    LabeledContent("الخادم", value: store.origin.host ?? "")
                    Button("تسجيل الخروج", role: .destructive) { signOutConfirm = true }
                }
                Section("ما يعمل الآن") {
                    Text(store.capabilities?.localModeText ?? (store.capabilities == nil ? "لم تُقرأ قدرات هذه الجلسة بعد." : "نموذج لغوي متصل، والردود الحرة متاحة."))
                        .font(.footnote)
                }
                Section("حول") {
                    Text("التطبيق نافذة إلى موحسن على الخادم السحابي، كما في الويب: المحادثات والعقل والأسئلة والموافقات والتحكم بالكمبيوتر تجري هناك. لا يحتاج الهاتف إلى الكمبيوتر ليحادث موحسن.")
                        .font(.footnote)
                }
            }
            .navigationTitle("الإعدادات").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("تم") { dismiss() } } }
            .confirmationDialog("تسجيل الخروج من هذا الهاتف؟", isPresented: $signOutConfirm, titleVisibility: .visible) {
                Button("تسجيل الخروج", role: .destructive) { Task { await store.signOut() } }
            } message: { Text("تبقى محادثاتك على الخادم. ويتوقف أي تحكم بالكمبيوتر من هذا الهاتف.") }
        }
        .environment(\.layoutDirection, .rightToLeft)
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

    private var readiness: RemoteReadiness? { store.remote }
    private var switchEnabled: Bool { !store.remoteBusy && (store.remoteWanted || readiness?.canTurnOn == true) }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    Card {
                        Toggle(isOn: Binding(get: { store.remoteWanted }, set: { store.setRemote($0) })) {
                            VStack(alignment: .leading, spacing: 4) {
                                Text("التحكم عن بُعد بتطبيق Windows").font(.headline)
                                Text(readiness?.title ?? (store.windowsProblem == nil ? "جارٍ قراءة حالة الكمبيوتر…" : "تعذّرت قراءة حالة الكمبيوتر"))
                                    .font(.caption).foregroundStyle(store.remoteWanted ? Forest.accent : Forest.softText)
                            }
                        }
                        .tint(Forest.accent)
                        .disabled(!switchEnabled)
                        if store.remoteBusy { ProgressView().frame(maxWidth: .infinity) }
                        if let readiness, !readiness.advice.isEmpty { Text(readiness.advice).font(.footnote).foregroundStyle(.secondary) }
                        if let problem = store.windowsProblem { Label(problem, systemImage: "exclamationmark.triangle").font(.footnote).foregroundStyle(Forest.alert) }
                        if let note = store.remoteNote { Text(note).font(.footnote).foregroundStyle(Forest.alert) }
                    }
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
                        .font(.footnote).foregroundStyle(.secondary)
                }
                .padding(20).frame(maxWidth: 700).frame(maxWidth: .infinity)
            }
            .background(Forest.background)
            .navigationTitle("الكمبيوتر").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("تم") { dismiss() } }
                ToolbarItem(placement: .topBarLeading) {
                    Button { Task { await store.loadWindows() } } label: { Image(systemName: "arrow.clockwise") }
                        .disabled(store.remoteBusy).accessibilityLabel("تحديث حالة الكمبيوتر")
                }
                ToolbarItemGroup(placement: .keyboard) { Spacer(); Button("تم") { dismissKeyboard() } }
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
            Label("ربط كمبيوتر", systemImage: "link").font(.headline)
            if let pairing = store.pairing {
                Text(pairing.code).font(.system(.title2, design: .monospaced)).textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .center).environment(\.layoutDirection, .leftToRight)
                Button { UIPasteboard.general.string = pairing.code } label: { Label("نسخ الرمز", systemImage: "doc.on.doc") }
                    .buttonStyle(ForestButton(prominent: false))
                Text("في Mohassan Companion على الكمبيوتر ألصق الرمز في «رمز الربط من مساحة العمل (دقيقتان)» ثم اضغط «ربط الجهاز محليًا». ينتهي الرمز خلال دقيقتين.")
                    .font(.footnote).foregroundStyle(.secondary)
            } else {
                Text("يلزم برنامج Mohassan Companion على الكمبيوتر. أنشئ رمزًا هنا، ثم ألصقه فيه.").font(.footnote).foregroundStyle(.secondary)
                Button { Task { await store.pairWindows() } } label: { Label("أنشئ رمز ربط", systemImage: "key") }
                    .buttonStyle(ForestButton()).disabled(store.remoteBusy)
            }
        }
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
                    Text("آخر صورة \(at.formatted(date: .omitted, time: .standard))").font(.caption).foregroundStyle(.secondary)
                }
            } else {
                ProgressView("تحميل الشاشة…").frame(maxWidth: .infinity, minHeight: 160)
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
            HStack(spacing: 12) {
                Button("تمرير لأعلى") { store.remoteAct(.scroll(3)) }
                Button("تمرير لأسفل") { store.remoteAct(.scroll(-3)) }
            }
            .buttonStyle(ForestButton(prominent: false))
            TextField("نص يُكتب على الكمبيوتر (حتى ١٢٠ حرفًا)", text: $typed)
                .padding(10).background(Forest.background, in: RoundedRectangle(cornerRadius: 12))
            Button("اكتب على الكمبيوتر") {
                store.remoteAct(.text(typed))
                typed = ""
            }
            .buttonStyle(ForestButton()).disabled(!WindowsAction.textFits(typed))
            HStack(spacing: 8) {
                key("Enter", "Enter")
                key("⌫", "Backspace", spoken: "حذف الحرف السابق")
                key("Tab", "Tab")
                key("Esc", "Escape")
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

    private func key(_ title: String, _ name: String, spoken: String? = nil) -> some View {
        Button(title) { store.remoteAct(.key(name)) }
            .frame(maxWidth: .infinity, minHeight: 44)
            .background(Forest.soft, in: RoundedRectangle(cornerRadius: 12))
            .accessibilityLabel(spoken ?? title)
    }
}

struct BrowserDestination: Identifiable { let id = UUID(); let url: URL }
struct SafariView: UIViewControllerRepresentable {
    let url: URL
    func makeUIViewController(context: Context) -> SFSafariViewController { SFSafariViewController(url: url) }
    func updateUIViewController(_ controller: SFSafariViewController, context: Context) {}
}
