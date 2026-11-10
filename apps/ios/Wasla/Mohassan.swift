import SwiftUI

// Mohassan's chat on the phone. The computer service forwards these calls to the
// Mohassan server on the same computer; Mohassan runs the work with its own brain,
// questions and approvals, exactly as in the web workspace.

extension WaslaStore {
    var mohassanLinked: Bool { mohassanLink?.linked == true }
    var mohassanBusy: Bool { mohassanSending || mohassanConversation?.working == true }
    /// While the assistant waits for an answer, an approval or a step, the card answers it, not the composer.
    var mohassanWaiting: Bool {
        guard let status = mohassanConversation?.status else { return false }
        return [MohassanStatus.waitingUser, MohassanStatus.waitingApproval, MohassanStatus.waitingInput].contains(status)
    }

    func refreshMohassanLink() async {
        guard let client else { mohassanLink = nil; return }
        let epoch = sessionEpoch
        do {
            let link: MohassanLink = try await client.get("/v1/mohassan/status")
            guard epoch == sessionEpoch else { return }
            mohassanLink = link
        } catch {
            guard epoch == sessionEpoch else { return }
            // An older computer service has no Mohassan routes: keep the local chat.
            // Other failures keep the last known state instead of switching screens.
            if let failure = error as? WaslaError, case .server(404, _) = failure { mohassanLink = nil }
        }
    }

    func loadMohassanList() async {
        guard let client else { return }
        let epoch = sessionEpoch
        do {
            let list: MohassanList = try await client.get("/v1/mohassan/conversations")
            guard epoch == sessionEpoch else { return }
            mohassanList = list.conversations
        } catch { if epoch == sessionEpoch { show(error) } }
    }

    func newMohassanChat() {
        mohassanEpoch += 1
        stopMohassanPolling()
        mohassanConversation = nil
        mohassanSending = false
        mohassanPendingText = nil
    }

    func openMohassan(_ id: String) async {
        guard UUID(uuidString: id) != nil else { return }
        newMohassanChat()
        await refreshMohassan(id)
    }

    func refreshMohassan(_ id: String) async {
        guard let client, UUID(uuidString: id) != nil else { return }
        let epoch = sessionEpoch, conversationEpoch = mohassanEpoch
        do {
            let detail: MohassanConversation = try await client.get("/v1/mohassan/conversations/\(id)")
            guard epoch == sessionEpoch, conversationEpoch == mohassanEpoch else { return }
            mohassanConversation = detail
            if detail.working { pollMohassan() } else { stopMohassanPolling() }
        } catch { if epoch == sessionEpoch, conversationEpoch == mohassanEpoch { show(error) } }
    }

    /// Mohassan accepts up to 4,000 UTF-16 units per message.
    nonisolated static func mohassanTextFits(_ text: String) -> Bool { text.utf16.count <= 4_000 }

    @discardableResult
    func sendMohassan(_ text: String) -> Bool {
        guard let client else { show(WaslaError.notPaired); return false }
        let clean = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !clean.isEmpty, !mohassanBusy, !mohassanWaiting else { return false }
        guard Self.mohassanTextFits(clean) else { errorMessage = "الرسالة تتجاوز ٤٬٠٠٠ حرف. اختصرها قبل الإرسال."; return false }
        let existing = mohassanConversation?.id
        let epoch = sessionEpoch, conversationEpoch = mohassanEpoch
        mohassanSending = true
        mohassanPendingText = clean
        Task { [weak self] in
            guard let self else { return }
            defer { if epoch == self.sessionEpoch, conversationEpoch == self.mohassanEpoch { self.mohassanSending = false; self.mohassanPendingText = nil } }
            do {
                let id: String
                if let existing, UUID(uuidString: existing) != nil {
                    let _: EmptyResponse = try await client.post("/v1/mohassan/conversations/\(existing)/messages", body: MohassanSend(text: clean), timeout: 45)
                    id = existing
                } else {
                    let created: MohassanCreated = try await client.post("/v1/mohassan/conversations", body: MohassanCreate(goal: clean), timeout: 45)
                    guard UUID(uuidString: created.id) != nil else { throw WaslaError.invalidResponse }
                    id = created.id
                }
                guard epoch == self.sessionEpoch, conversationEpoch == self.mohassanEpoch else { return }
                await self.refreshMohassan(id)
            } catch {
                // A lost response is not proof that nothing started; nothing is sent again automatically.
                if epoch == self.sessionEpoch, conversationEpoch == self.mohassanEpoch { self.show(error) }
            }
        }
        return true
    }

    func answerMohassan(option: MohassanOption?, text: String?) {
        guard let conversation = mohassanConversation, conversation.status == MohassanStatus.waitingUser, let question = conversation.question else { return }
        let typed = text?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let body = MohassanRespond(questionId: question.id, optionId: option?.id, text: typed.isEmpty ? nil : typed)
        guard body.optionId != nil || body.text != nil else { return }
        actOnMohassan(conversation.id, action: "respond", body: body)
    }

    func approveMohassan(_ approved: Bool) {
        guard let conversation = mohassanConversation, conversation.status == MohassanStatus.waitingApproval, let approval = conversation.approval else { return }
        actOnMohassan(conversation.id, action: "approve", body: MohassanApprove(approvalId: approval.id, approved: approved))
    }

    /// Stopping is always allowed, even while another call is in flight.
    func cancelMohassan() {
        guard let conversation = mohassanConversation else { return }
        actOnMohassan(conversation.id, action: "cancel", body: EmptyBody(), allowWhileSending: true)
    }

    func deleteMohassan(_ id: String) async {
        guard let client, UUID(uuidString: id) != nil else { return }
        let epoch = sessionEpoch
        do {
            try await client.delete("/v1/mohassan/conversations/\(id)")
            guard epoch == sessionEpoch else { return }
            mohassanList.removeAll { $0.id == id }
            if mohassanConversation?.id == id { newMohassanChat() }
        } catch { if epoch == sessionEpoch { show(error) } }
    }

    private func actOnMohassan<Body: Encodable>(_ id: String, action: String, body: Body, allowWhileSending: Bool = false) {
        guard let client, UUID(uuidString: id) != nil, allowWhileSending || !mohassanSending else { return }
        let epoch = sessionEpoch, conversationEpoch = mohassanEpoch
        mohassanSending = true
        Task { [weak self] in
            guard let self else { return }
            defer { if epoch == self.sessionEpoch, conversationEpoch == self.mohassanEpoch { self.mohassanSending = false } }
            do {
                let _: EmptyResponse = try await client.post("/v1/mohassan/conversations/\(id)/\(action)", body: body, timeout: 45)
                guard epoch == self.sessionEpoch, conversationEpoch == self.mohassanEpoch else { return }
                await self.refreshMohassan(id)
            } catch { if epoch == self.sessionEpoch, conversationEpoch == self.mohassanEpoch { self.show(error) } }
        }
    }

    /// Reads the conversation every two seconds while Mohassan works, in the foreground only.
    func pollMohassan() {
        guard mohassanPollTask == nil, foreground, let client, let id = mohassanConversation?.id, UUID(uuidString: id) != nil else { return }
        mohassanPollID += 1
        let pollID = mohassanPollID, epoch = sessionEpoch, conversationEpoch = mohassanEpoch
        mohassanPollTask = Task { [weak self] in
            guard let self else { return }
            defer { if pollID == self.mohassanPollID { self.mohassanPollTask = nil } }
            var failures = 0
            while !Task.isCancelled {
                do { try await Task.sleep(for: .seconds(2)) } catch { return }
                guard !Task.isCancelled, self.foreground, epoch == self.sessionEpoch, conversationEpoch == self.mohassanEpoch else { return }
                do {
                    let detail: MohassanConversation = try await client.get("/v1/mohassan/conversations/\(id)")
                    guard !Task.isCancelled, epoch == self.sessionEpoch, conversationEpoch == self.mohassanEpoch else { return }
                    failures = 0
                    self.mohassanConversation = detail
                    if !detail.working { return }
                } catch {
                    failures += 1
                    if failures >= 5 {
                        if !Task.isCancelled, epoch == self.sessionEpoch, conversationEpoch == self.mohassanEpoch { self.show(error) }
                        return
                    }
                }
            }
        }
    }

    func stopMohassanPolling() {
        mohassanPollID += 1
        mohassanPollTask?.cancel()
        mohassanPollTask = nil
    }

    func resetMohassan() {
        newMohassanChat()
        mohassanList = []
        mohassanLink = nil
    }

    func mohassanSceneChanged(active: Bool) {
        if active {
            if let id = mohassanConversation?.id { Task { await refreshMohassan(id) } }
        } else {
            stopMohassanPolling()
        }
    }
}

struct MohassanChatView: View {
    @EnvironmentObject private var store: WaslaStore
    @State private var draft = ""
    @State private var answer = ""
    @State private var listShown = false
    @State private var approveConfirm = false
    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            ScreenTitle(title: "موحسن", subtitle: "مساعدك نفسه في واجهة الويب، من هاتفك.")
            HStack(spacing: 12) {
                Button { listShown = true; Task { await store.loadMohassanList() } } label: { Label("المحادثات", systemImage: "list.bullet") }
                    .buttonStyle(ForestButton(prominent: false))
                Button { store.newMohassanChat(); draft = ""; answer = "" } label: { Label("محادثة جديدة", systemImage: "plus.bubble") }
                    .buttonStyle(ForestButton(prominent: false)).disabled(store.mohassanSending)
            }
            if let conversation = store.mohassanConversation {
                conversationView(conversation)
            } else if let pending = store.mohassanPendingText {
                bubble(role: "user", text: pending)
                HStack { ProgressView(); Text("يُرسل الطلب إلى موحسن…").font(.subheadline) }.accessibilityElement(children: .combine)
            } else {
                Text("اطلب ما تريد كما تطلبه من واجهة الويب. يسألك موحسن إن احتاج توضيحًا، ويطلب موافقتك قبل أي إجراء حساس.").font(.subheadline).foregroundStyle(.secondary)
            }
            if !store.mohassanWaiting { composer }
            Text("إدخال كلمات المرور ورموز التحقق وربط الحسابات يتم من واجهة موحسن على الويب في هذه النسخة.").font(.footnote).foregroundStyle(.secondary)
        }
        .sheet(isPresented: $listShown) { MohassanListView() }
    }

    @ViewBuilder private func conversationView(_ conversation: MohassanConversation) -> some View {
        if !conversation.title.isEmpty { Text(conversation.title).font(.headline) }
        Label(MohassanStatus.title(conversation.status), systemImage: conversation.working ? "hourglass" : "circle.fill").font(.caption).foregroundStyle(.secondary)
        ForEach(conversation.messages) { message in bubble(role: message.role, text: message.text) }
        if conversation.working {
            VStack(alignment: .leading, spacing: 8) {
                HStack { ProgressView(); Text(conversation.progress ?? "موحسن يعمل…").font(.subheadline) }
                ForEach(conversation.steps.suffix(3)) { step in Text("• " + step.text).font(.footnote).foregroundStyle(.secondary) }
            }.accessibilityElement(children: .combine)
        }
        if conversation.status == MohassanStatus.waitingUser, let question = conversation.question { questionCard(question) }
        if conversation.status == MohassanStatus.waitingApproval, let approval = conversation.approval { approvalCard(approval) }
        if conversation.status == MohassanStatus.waitingInput, let secure = conversation.secure { secureCard(secure) }
        if !conversation.working, let error = conversation.error, !error.isEmpty { Text(error).font(.footnote).foregroundStyle(.secondary) }
        if conversation.working || store.mohassanWaiting {
            Button(role: .destructive) { store.cancelMohassan() } label: { Label("إيقاف", systemImage: "stop.fill") }
                .buttonStyle(ForestButton(prominent: false))
        }
    }

    private func bubble(role: String, text: String) -> some View {
        VStack(alignment: .leading, spacing: 7) {
            Text(role == "user" ? "أنت" : "موحسن").font(.caption).foregroundStyle(.secondary)
            Text(text).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
        }.padding(16).background(role == "user" ? Forest.soft : Forest.surface, in: RoundedRectangle(cornerRadius: 20))
    }

    private var composer: some View {
        Card {
            TextField(store.mohassanConversation == nil ? "ماذا تريد أن ينجز موحسن؟" : "اكتب رسالتك…", text: $draft, axis: .vertical).lineLimit(3...8)
            Text("\(draft.utf16.count) / 4000 حرف")
                .font(.caption).foregroundStyle(WaslaStore.mohassanTextFits(draft) ? Color.secondary : Color.red)
            HStack {
                Text(store.mohassanBusy ? "موحسن يعمل الآن" : "يعمل على كمبيوترك").font(.caption).foregroundStyle(.secondary)
                Spacer()
                Button {
                    if store.sendMohassan(draft) { draft = "" }
                } label: {
                    Image(systemName: "arrow.up").font(.headline).frame(width: 48, height: 48)
                        .background(Forest.accent, in: RoundedRectangle(cornerRadius: 16)).foregroundStyle(Forest.onAccent)
                }
                .disabled(store.mohassanBusy || draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !WaslaStore.mohassanTextFits(draft))
                .accessibilityLabel("إرسال الرسالة")
            }
        }
    }

    private func questionCard(_ question: MohassanQuestion) -> some View {
        Card {
            Label("سؤال من موحسن", systemImage: "questionmark.bubble").font(.headline)
            Text(question.prompt)
            if let reason = question.clarification?.reason, !reason.isEmpty { Text(reason).font(.footnote).foregroundStyle(.secondary) }
            ForEach(question.phoneOptions) { option in
                let recommended = option.id == question.clarification?.recommendedOptionId
                Button { store.answerMohassan(option: option, text: nil) } label: {
                    Text(recommended ? option.label + " · مقترح" : option.label).frame(maxWidth: .infinity, alignment: .leading)
                }
                .buttonStyle(ForestButton(prominent: recommended)).disabled(store.mohassanSending)
            }
            if question.action == "google_ads_connect" {
                Text("ربط حساب Google Ads يتم من واجهة موحسن على الويب.").font(.footnote).foregroundStyle(.secondary)
            }
            if question.acceptsText {
                TextField("أو اكتب إجابتك…", text: $answer, axis: .vertical).lineLimit(1...4)
                Button("إرسال الإجابة") { store.answerMohassan(option: nil, text: answer); answer = "" }
                    .buttonStyle(ForestButton())
                    .disabled(store.mohassanSending || answer.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || answer.utf16.count > 2_000)
            }
        }
    }

    private func approvalCard(_ approval: MohassanApproval) -> some View {
        Card {
            Label("يحتاج موافقتك", systemImage: "checkmark.shield").font(.headline)
            Text(approval.prompt)
            if !approval.detail.isEmpty { Text(approval.detail).font(.footnote).foregroundStyle(.secondary) }
            HStack(spacing: 12) {
                Button("رفض") { store.approveMohassan(false) }.buttonStyle(ForestButton(prominent: false))
                Button("موافق") { approveConfirm = true }.buttonStyle(ForestButton())
            }.disabled(store.mohassanSending)
        }
        .confirmationDialog("تنفيذ هذا الإجراء؟", isPresented: $approveConfirm, titleVisibility: .visible) {
            Button("موافق، نفّذ") { store.approveMohassan(true) }
        } message: { Text(approval.prompt) }
    }

    private func secureCard(_ secure: MohassanSecure) -> some View {
        Card {
            Label(secure.kind == "code" ? "يحتاج رمز تحقق" : secure.kind == "login" ? "يحتاج تسجيل دخول" : "يحتاج خطوة منك", systemImage: "lock").font(.headline)
            Text(secure.prompt)
            if !secure.site.isEmpty { Text(secure.site).font(.caption).foregroundStyle(.secondary).environment(\.layoutDirection, .leftToRight) }
            Text("أكمل هذه الخطوة من واجهة موحسن على الويب، ثم يتابع موحسن من حيث توقف. لا تُرسل كلمات المرور ورموز التحقق عبر الهاتف في هذه النسخة.").font(.footnote).foregroundStyle(.secondary)
        }
    }
}

struct MohassanListView: View {
    @EnvironmentObject private var store: WaslaStore
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        NavigationStack {
            List {
                if store.mohassanList.isEmpty { Text("لا توجد محادثات بعد.").foregroundStyle(.secondary) }
                ForEach(store.mohassanList) { item in
                    Button {
                        let id = item.id
                        dismiss()
                        Task { await store.openMohassan(id) }
                    } label: {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(item.title.isEmpty ? "محادثة" : item.title)
                            Text(MohassanStatus.title(item.status)).font(.caption).foregroundStyle(.secondary)
                        }
                    }
                }
                .onDelete { offsets in
                    let ids = offsets.map { store.mohassanList[$0].id }
                    Task { for id in ids { await store.deleteMohassan(id) } }
                }
            }
            .navigationTitle("محادثات موحسن").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("تم") { dismiss() } } }
            .refreshable { await store.loadMohassanList() }
        }.environment(\.layoutDirection, .rightToLeft)
    }
}
