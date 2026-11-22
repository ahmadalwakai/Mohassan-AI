import SwiftUI

// Mohassan's chat on the phone. The computer service forwards these calls to the
// Mohassan server on the same computer; Mohassan runs the work with its own brain,
// questions and approvals, exactly as in the web workspace.
//
// Plan phase 3: every call that changes something carries its own key (`clientRequestId`).
// The text stays until Mohassan has it and comes back when a send is refused. A call whose
// reply was lost stays on screen as «not confirmed», with «check» (a read) and, for the
// composer's text, «send again» with the same key, which can never run twice. Nothing is
// sent again by itself, and a card's answer or approval is never resent at all: the owner
// answers the fresh card.

extension WaslaStore {
    var mohassanLinked: Bool { mohassanLink?.linked == true }
    var mohassanBusy: Bool { mohassanSending || mohassanConversation?.working == true }
    /// A request whose outcome is not settled: the composer and the cards wait for it.
    var mohassanUnsettled: Bool { mohassanRequest != nil }
    /// While the assistant waits for an answer, an approval or a step, the card answers it, not the composer.
    var mohassanWaiting: Bool {
        guard let status = mohassanConversation?.status else { return false }
        return [MohassanStatus.waitingUser, MohassanStatus.waitingApproval, MohassanStatus.waitingInput].contains(status)
    }

    private static let requestKey = "wasla.mohassan.request"

    func refreshMohassanLink() async {
        guard let client else { mohassanLink = nil; return }
        let epoch = sessionEpoch
        do {
            let link: MohassanLink = try await client.get("/v1/mohassan/status", timeout: 15)
            guard epoch == sessionEpoch else { return }
            mohassanLink = link
        } catch {
            guard epoch == sessionEpoch else { return }
            // An older computer service has no Mohassan routes: that is «not linked».
            // Other failures keep the last known link instead of flickering the state.
            if let failure = error as? WaslaError, case .server(404, _, _) = failure { mohassanLink = nil }
        }
        updateConnection()
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
        mohassanAnswerDraft = ""
    }

    func openMohassan(_ id: String) async {
        guard UUID(uuidString: id) != nil, !mohassanSending else { return }
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

    // MARK: Requests that change something, each with its own key

    /// Sends the composer's text: a new conversation, or a message in the open one.
    @discardableResult
    func sendMohassan() -> Bool {
        guard client != nil else { show(WaslaError.notPaired); return false }
        let clean = mohassanDraft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !clean.isEmpty, connection.canSend, !mohassanBusy, !mohassanWaiting, !mohassanUnsettled else { return false }
        guard Self.mohassanTextFits(clean) else { errorMessage = "الرسالة تتجاوز ٤٬٠٠٠ حرف. اختصرها قبل الإرسال."; return false }
        let request: MohassanRequest
        do {
            if let existing = mohassanConversation?.id, UUID(uuidString: existing) != nil {
                request = try MohassanRequest.make(.message, conversationId: existing, text: clean) { MohassanSend(text: clean, clientRequestId: $0) }
            } else {
                request = try MohassanRequest.make(.create, conversationId: nil, text: clean) { MohassanCreate(goal: clean, clientRequestId: $0) }
            }
        } catch { show(error); return false }
        // The text now shows as the pending turn; it comes back to the box if the send is refused.
        mohassanDraft = ""
        submit(request)
        return true
    }

    /// One option of the pending question.
    func answerMohassan(option: MohassanOption) {
        guard let conversation = mohassanConversation, conversation.status == MohassanStatus.waitingUser, let question = conversation.question else { return }
        sendKeyed(.option, conversationId: conversation.id, text: option.label) { MohassanRespond(questionId: question.id, optionId: option.id, clientRequestId: $0) }
    }

    /// A typed answer to the pending question: a message that names the question, so a stale answer is refused.
    func answerMohassan(text: String) {
        guard let conversation = mohassanConversation, conversation.status == MohassanStatus.waitingUser,
              let question = conversation.question, question.acceptsText else { return }
        let typed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !typed.isEmpty, Self.mohassanTextFits(typed) else { return }
        if sendKeyed(.reply, conversationId: conversation.id, text: typed, body: { MohassanReply(text: typed, questionId: question.id, clientRequestId: $0) }) {
            mohassanAnswerDraft = ""
        }
    }

    /// The answers of a several-questions card, in the card's order.
    func answerMohassan(fields answers: [MohassanFieldAnswer]) {
        guard let conversation = mohassanConversation, conversation.status == MohassanStatus.waitingUser, let question = conversation.question,
              !answers.isEmpty, answers.map(\.fieldId) == question.phoneFields.map(\.id), FieldAnswers.ready(answers.map(\.value)) else { return }
        let summary = answers.count > 1 ? answers.enumerated().map { "\($0.offset + 1). \($0.element.value)" }.joined(separator: "\n") : answers[0].value
        sendKeyed(.fields, conversationId: conversation.id, text: summary) { MohassanFieldsReply(questionId: question.id, answers: answers, clientRequestId: $0) }
    }

    func approveMohassan(_ approved: Bool) {
        guard let conversation = mohassanConversation, conversation.status == MohassanStatus.waitingApproval, let approval = conversation.approval else { return }
        sendKeyed(.approve, conversationId: conversation.id, text: approved ? "موافق" : "رفض") { MohassanApprove(approvalId: approval.id, approved: approved, clientRequestId: $0) }
    }

    /// Stopping is always allowed, even while another call is in flight. It needs no key: stopping twice stops once.
    func cancelMohassan() {
        guard let client, let id = mohassanConversation?.id, UUID(uuidString: id) != nil else { return }
        let epoch = sessionEpoch, conversationEpoch = mohassanEpoch
        Task { [weak self] in
            guard let self else { return }
            do {
                let _: EmptyResponse = try await client.post("/v1/mohassan/conversations/\(id)/cancel", body: EmptyBody(), timeout: 45)
                guard epoch == self.sessionEpoch, conversationEpoch == self.mohassanEpoch else { return }
                await self.refreshMohassan(id)
            } catch { if epoch == self.sessionEpoch, conversationEpoch == self.mohassanEpoch { self.show(error) } }
        }
    }

    func deleteMohassan(_ id: String) async {
        guard let client, UUID(uuidString: id) != nil else { return }
        let epoch = sessionEpoch
        do {
            try await client.delete("/v1/mohassan/conversations/\(id)")
            guard epoch == sessionEpoch else { return }
            mohassanList.removeAll { $0.id == id }
            // A request into a deleted conversation has nothing left to confirm.
            if let request = mohassanRequest, request.conversationId == id, request.phase != .sending { settleMohassanRequest(request.key) }
            if mohassanConversation?.id == id { newMohassanChat() }
        } catch { if epoch == sessionEpoch { show(error) } }
    }

    @discardableResult
    private func sendKeyed<Body: Encodable>(_ kind: MohassanRequest.Kind, conversationId: String, text: String, body: (String) -> Body) -> Bool {
        guard client != nil, UUID(uuidString: conversationId) != nil, connection.canSend, !mohassanSending, !mohassanUnsettled else { return false }
        do { submit(try MohassanRequest.make(kind, conversationId: conversationId, text: text, body: body)) }
        catch { show(error); return false }
        return true
    }

    /// Sends one keyed request, or the same one again. Success shows the conversation the reply carries;
    /// a refusal hands the text back; a lost or half-finished call stays as «not confirmed».
    private func submit(_ request: MohassanRequest) {
        guard let client else { show(WaslaError.notPaired); return }
        var request = request
        request.phase = .sending
        request.note = nil
        mohassanRequest = request
        saveMohassanRequest()
        mohassanSending = true
        let epoch = sessionEpoch, conversationEpoch = mohassanEpoch
        Task { [weak self] in
            guard let self else { return }
            var reply = Data()
            var outcome: SendOutcome?
            do { reply = try await client.data(path: request.path, method: "POST", body: request.body, timeout: 45) }
            catch { outcome = SendOutcome.of(error) }
            guard epoch == self.sessionEpoch else { return }
            self.mohassanSending = false
            guard self.mohassanRequest?.key == request.key else { return }
            if let outcome { await self.failed(request, outcome) }
            else { await self.delivered(request, reply: reply, sameScreen: conversationEpoch == self.mohassanEpoch) }
        }
    }

    private func delivered(_ request: MohassanRequest, reply: Data, sameScreen: Bool) async {
        let detail = try? JSONDecoder().decode(MohassanConversation.self, from: reply)
        guard let target = detail?.id ?? request.conversationId, UUID(uuidString: target) != nil else {
            // It happened, but the reply named no conversation: the gateway's record does.
            markMohassanRequest(request.key, phase: .unknown, note: "وصل الطلب، لكن الرد لم يذكر المحادثة.")
            await checkMohassanRequest(automatic: true)
            return
        }
        settleMohassanRequest(request.key)
        await reveal(target, detail: detail, for: request, sameScreen: sameScreen)
    }

    /// Shows the conversation a settled request went to, when the screen still belongs to that request.
    private func reveal(_ id: String, detail: MohassanConversation?, for request: MohassanRequest, sameScreen: Bool) async {
        guard sameScreen, request.belongs(to: mohassanConversation?.id) else { await loadMohassanList(); return }
        if let detail, detail.id == id {
            mohassanConversation = detail
            if detail.working { pollMohassan() } else { stopMohassanPolling() }
        } else {
            await refreshMohassan(id)
        }
    }

    private func failed(_ request: MohassanRequest, _ outcome: SendOutcome) async {
        switch outcome {
        case .notDone(let reason):
            settleMohassanRequest(request.key)
            handBack(request)
            errorMessage = request.fromComposer || request.kind == .reply ? reason + "\nبقي نصك في الصندوق." : reason
            // A refused answer or approval usually means the card changed: show the current one.
            if !request.fromComposer, let id = request.conversationId, mohassanConversation?.id == id { await refreshMohassan(id) }
        case .unknown(let reason):
            markMohassanRequest(request.key, phase: .unknown, note: reason)
            // One read a moment later often settles it; nothing is sent again.
            try? await Task.sleep(for: .seconds(2))
            await checkMohassanRequest(automatic: true)
        case .inProgress(let reason):
            markMohassanRequest(request.key, phase: .unknown, note: reason)
            try? await Task.sleep(for: .seconds(3))
            await checkMohassanRequest(automatic: true)
        case .undetermined:
            await undetermined(request)
        }
    }

    /// The computer saw the request fail midway: only the conversation can show what happened.
    private func undetermined(_ request: MohassanRequest) async {
        settleMohassanRequest(request.key)
        handBack(request)
        if let id = request.conversationId, mohassanConversation?.id == id { await refreshMohassan(id) } else { await loadMohassanList() }
        errorMessage = request.fromComposer || request.kind == .reply
            ? "لم يتأكد ما حدث للطلب على الكمبيوتر. راجع المحادثة قبل أن ترسل من جديد. أعدنا النص إلى الصندوق، ولن يُرسل إلا إذا أرسلته أنت."
            : "لم يتأكد ما حدث لهذه الخطوة على الكمبيوتر. راجع المحادثة؛ إن ظهرت البطاقة نفسها فأجب منها من جديد."
    }

    /// Puts a request's text back where the owner typed it, keeping anything typed since.
    private func handBack(_ request: MohassanRequest) {
        func merged(_ current: String) -> String { current.isEmpty ? request.text : request.text + "\n" + current }
        switch request.kind {
        case .create, .message: mohassanDraft = merged(mohassanDraft)
        case .reply: mohassanAnswerDraft = merged(mohassanAnswerDraft)
        case .fields, .option, .approve: break
        }
    }

    /// Asks Mohassan what became of the unsettled request. A read only: nothing is sent again.
    func checkMohassanRequest(automatic: Bool = false) async {
        guard let client, let request = mohassanRequest, request.phase != .sending, !mohassanChecking else { return }
        let epoch = sessionEpoch
        mohassanChecking = true
        defer { mohassanChecking = false }
        do {
            let status: MohassanRequestStatus = try await client.get("/v1/mohassan/requests/\(request.key)", timeout: 15)
            guard epoch == sessionEpoch, mohassanRequest?.key == request.key else { return }
            switch status.verdict {
            case .done(let id):
                settleMohassanRequest(request.key)
                if let target = id ?? request.conversationId, UUID(uuidString: target) != nil {
                    await reveal(target, detail: nil, for: request, sameScreen: true)
                } else { await loadMohassanList() }
            case .notReceived:
                if request.fromComposer {
                    markMohassanRequest(request.key, phase: .notReceived, note: "لم يصل الطلب إلى موحسن. أرسله الآن، أو اتركه لتعدّل النص.")
                } else {
                    settleMohassanRequest(request.key)
                    if let id = request.conversationId, mohassanConversation?.id == id { await refreshMohassan(id) }
                    errorMessage = "لم تصل هذه الخطوة إلى موحسن. إن كانت البطاقة ما زالت ظاهرة فأجب منها من جديد."
                }
            case .inProgress:
                markMohassanRequest(request.key, phase: .unknown, note: "ما زال موحسن يستلم الطلب. تحقّق بعد قليل.")
            case .undetermined:
                await undetermined(request)
            }
        } catch {
            // An automatic check keeps the first reason on the card; the owner's own check says why it failed.
            guard !automatic, epoch == sessionEpoch, mohassanRequest?.key == request.key else { return }
            let reason = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
            markMohassanRequest(request.key, phase: request.phase, note: "تعذّر التحقق الآن: \(reason)")
        }
    }

    /// Sends the composer's unsettled request again with its own key: if the first one arrived, Mohassan
    /// returns its result instead of running it twice. Only on the owner's tap.
    func resendMohassanRequest() {
        guard let request = mohassanRequest, request.fromComposer, request.phase != .sending,
              !mohassanSending, !mohassanChecking, connection.canSend else { return }
        submit(request)
    }

    /// Lets go of the unsettled request: the phone stops following it and its text returns to the box.
    /// It stops nothing on the computer.
    func dropMohassanRequest() {
        guard let request = mohassanRequest, request.phase != .sending else { return }
        settleMohassanRequest(request.key)
        handBack(request)
        if let id = request.conversationId, mohassanConversation?.id == id { Task { await refreshMohassan(id) } }
    }

    private func markMohassanRequest(_ key: String, phase: MohassanRequest.Phase, note: String?) {
        guard var request = mohassanRequest, request.key == key else { return }
        request.phase = phase
        request.note = note
        mohassanRequest = request
        saveMohassanRequest()
    }

    private func settleMohassanRequest(_ key: String) {
        guard mohassanRequest?.key == key else { return }
        mohassanRequest = nil
        saveMohassanRequest()
    }

    /// Kept on the phone so a closed app can still check the request later. It is never sent again by itself.
    private func saveMohassanRequest() {
        if let request = mohassanRequest, let data = try? JSONEncoder().encode(request) { UserDefaults.standard.set(data, forKey: Self.requestKey) }
        else { UserDefaults.standard.removeObject(forKey: Self.requestKey) }
    }

    /// At launch: the request the last session left unconfirmed, to be checked.
    func restoreMohassanRequest() {
        guard let data = UserDefaults.standard.data(forKey: Self.requestKey) else { return }
        guard var request = try? JSONDecoder().decode(MohassanRequest.self, from: data), UUID(uuidString: request.key) != nil else {
            UserDefaults.standard.removeObject(forKey: Self.requestKey)
            return
        }
        if request.phase == .sending {
            request.phase = .unknown
            request.note = "أُغلق التطبيق قبل أن يتأكد وصول الطلب."
        }
        mohassanRequest = request
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
        mohassanSending = false
        mohassanList = []
        mohassanLink = nil
        mohassanRequest = nil
        saveMohassanRequest()
        mohassanDraft = ""
    }

    func mohassanSceneChanged(active: Bool) {
        if active {
            if let id = mohassanConversation?.id { Task { await refreshMohassan(id) } }
            // Back in the foreground: an unconfirmed request is checked, never sent again.
            if let request = mohassanRequest, request.phase != .sending { Task { await checkMohassanRequest(automatic: true) } }
        } else {
            stopMohassanPolling()
        }
    }
}

struct MohassanChatView: View {
    @EnvironmentObject private var store: WaslaStore
    @State private var listShown = false
    @State private var approveConfirm = false
    @State private var dropConfirm = false
    @State private var browsing: BrowserDestination?
    private var clean: String { store.mohassanDraft.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var scrollKey: Int {
        let conversation = store.mohassanConversation
        let request: Int
        switch store.mohassanRequest?.phase {
        case .none: request = 0
        case .sending: request = 1
        case .unknown: request = 2
        case .notReceived: request = 3
        }
        return (conversation?.messages.count ?? 0) * 1_000 + (conversation?.steps.count ?? 0) * 2 + (store.mohassanWaiting ? 1 : 0) + request * 100_000
    }
    /// Why the composer cannot send right now: the connection first, then an unconfirmed request.
    private var notice: String? {
        if !store.connection.canSend { return store.connection.title + ". " + store.connection.advice }
        if let request = store.mohassanRequest, request.phase != .sending { return "تحقّق من الطلب السابق قبل رسالة جديدة." }
        return nil
    }
    private var cardsLocked: Bool { store.mohassanSending || store.mohassanUnsettled || !store.connection.canSend }

    var body: some View {
        ChatScaffold(
            draft: $store.mohassanDraft,
            placeholder: store.mohassanConversation == nil ? "ماذا تريد أن ينجز موحسن؟" : "اكتب رسالتك…",
            tooLong: !WaslaStore.mohassanTextFits(store.mohassanDraft),
            // Sending needs the whole path: this phone trusted, the computer answering, Mohassan linked and up,
            // and no earlier request left unconfirmed.
            canSend: store.connection.canSend && !store.mohassanBusy && !store.mohassanUnsettled && !clean.isEmpty && WaslaStore.mohassanTextFits(store.mohassanDraft),
            working: store.mohassanBusy,
            scrollKey: scrollKey,
            showComposer: !store.mohassanWaiting,
            notice: notice,
            onSend: { store.sendMohassan() },
            onStop: { store.cancelMohassan() }
        ) {
            if let conversation = store.mohassanConversation {
                conversationView(conversation)
            } else if store.mohassanRequest == nil {
                ChatWelcome(title: "بمَ أساعدك اليوم؟", suggestions: ["خطّط لحملة إعلانية", "لخّص لي موضوعًا", "نظّم مهامي"]) { store.mohassanDraft = $0 }
            }
            if let request = store.mohassanRequest { requestView(request) }
        }
        // Links in replies open here, in Safari inside the app, and only when they are https.
        .environment(\.openURL, OpenURLAction { url in
            guard let safe = SafeLink.https(url.absoluteString) else { return .discarded }
            browsing = BrowserDestination(url: safe)
            return .handled
        })
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                Button { listShown = true; Task { await store.loadMohassanList() } } label: { Image(systemName: "sidebar.right") }.accessibilityLabel("المحادثات")
            }
            ToolbarItem(placement: .topBarLeading) {
                Button { store.newMohassanChat(); store.mohassanDraft = "" } label: { Image(systemName: "square.and.pencil") }
                    .disabled(store.mohassanSending).accessibilityLabel("محادثة جديدة")
            }
        }
        .sheet(isPresented: $listShown) { MohassanListView() }
        .sheet(item: $browsing) { SafariView(url: $0.url).ignoresSafeArea() }
        .confirmationDialog("ترك هذا الطلب؟", isPresented: $dropConfirm, titleVisibility: .visible) {
            Button("اتركه", role: .destructive) { store.dropMohassanRequest() }
        } message: {
            Text("قد يكون موحسن استلمه. تركه هنا لا يوقف شيئًا على الكمبيوتر، ويعود نصك إلى الصندوق. راجع المحادثة قبل أن ترسل من جديد.")
        }
    }

    @ViewBuilder private func conversationView(_ conversation: MohassanConversation) -> some View {
        let fields: [MohassanField] = conversation.status == MohassanStatus.waitingUser ? (conversation.question?.phoneFields ?? []) : []
        ForEach(Array(conversation.messages.enumerated()), id: \.element.id) { index, message in
            // While a field card holds the questions, the last reply need not list them again (as on the web).
            let listed = !fields.isEmpty && index == conversation.messages.count - 1 && message.role != "user"
            ChatTurn(mine: message.role == "user", text: listed ? ReplyMarkdown.withoutQuestionList(message.text) : message.text)
        }
        if conversation.working {
            WorkingSteps(progress: conversation.progress ?? "موحسن يعمل…", steps: conversation.steps.map(\.text))
        }
        if conversation.status == MohassanStatus.waitingUser, let question = conversation.question {
            if fields.isEmpty {
                questionCard(question)
            } else {
                FieldQuestionCard(question: question, busy: cardsLocked, onSubmit: { store.answerMohassan(fields: $0) },
                                  onStop: question.stopOption.map { option in { store.answerMohassan(option: option) } })
                    .id(question.id)
            }
        }
        if conversation.status == MohassanStatus.waitingApproval, let approval = conversation.approval { approvalCard(approval) }
        if conversation.status == MohassanStatus.waitingInput, let secure = conversation.secure { secureCard(secure) }
        if !conversation.working, let error = conversation.error, !error.isEmpty {
            Text(error).font(.subheadline).foregroundStyle(Forest.alert)
                .padding(.vertical, 9).padding(.horizontal, 12).frame(maxWidth: .infinity, alignment: .leading)
                .background(Forest.alert.opacity(0.1), in: RoundedRectangle(cornerRadius: 10))
        }
        if store.mohassanWaiting {
            Button(role: .destructive) { store.cancelMohassan() } label: { Label("إيقاف", systemImage: "stop.fill") }
                .buttonStyle(ForestButton(prominent: false))
        }
    }

    /// The request whose outcome is still open: its text while it travels, then what is known and what the owner can do.
    @ViewBuilder private func requestView(_ request: MohassanRequest) -> some View {
        let here = request.belongs(to: store.mohassanConversation?.id)
        if here, request.fromComposer { ChatTurn(mine: true, text: request.text) }
        if request.phase == .sending {
            if request.fromComposer { WorkingSteps(progress: "يُرسل إلى موحسن…", steps: []) }
        } else {
            Card {
                Label(request.phase == .notReceived ? "لم يصل الطلب إلى موحسن" : "لم يتأكد وصول الطلب", systemImage: "exclamationmark.triangle")
                    .font(.headline).foregroundStyle(Forest.alert)
                if !(here && request.fromComposer) {
                    Text(request.text).font(.subheadline).lineLimit(3)
                        .padding(.vertical, 6).padding(.horizontal, 10).frame(maxWidth: .infinity, alignment: .leading)
                        .background(Forest.soft, in: RoundedRectangle(cornerRadius: 10))
                }
                if !here { Text(request.kind == .create ? "في محادثة جديدة." : "في محادثة أخرى.").font(.caption).foregroundStyle(.secondary) }
                if let note = request.note, !note.isEmpty { Text(note).font(.footnote).foregroundStyle(.secondary) }
                Text(request.fromComposer
                     ? "لن يُرسل من جديد إلا بضغطك. «أرسل مرة أخرى» آمن: إن كان قد وصل فلن يتكرر."
                     : "لن يُرسل من جديد. تحقّق لترى البطاقة كما هي الآن.")
                    .font(.footnote).foregroundStyle(.secondary)
                HStack(spacing: 12) {
                    Button { Task { await store.checkMohassanRequest() } } label: {
                        if store.mohassanChecking { ProgressView().tint(Forest.onAccent) } else { Text("تحقّق") }
                    }
                    .buttonStyle(ForestButton())
                    .disabled(store.mohassanChecking || store.mohassanSending)
                    if request.fromComposer {
                        Button(request.phase == .notReceived ? "أرسل الآن" : "أرسل مرة أخرى") { store.resendMohassanRequest() }
                            .buttonStyle(ForestButton(prominent: false))
                            .disabled(store.mohassanChecking || store.mohassanSending || !store.connection.canSend)
                    }
                }
                Button("اتركه", role: .destructive) { dropConfirm = true }
                    .font(.footnote).disabled(store.mohassanChecking || store.mohassanSending)
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
                Button { store.answerMohassan(option: option) } label: {
                    Text(recommended ? option.label + " · مقترح" : option.label).frame(maxWidth: .infinity, alignment: .leading)
                }
                .buttonStyle(ForestButton(prominent: recommended)).disabled(cardsLocked)
            }
            if question.action == "google_ads_connect" {
                Text("ربط حساب Google Ads يتم من واجهة موحسن على الويب.").font(.footnote).foregroundStyle(.secondary)
            }
            if question.acceptsText {
                TextField(question.phoneOptions.isEmpty ? "اكتب إجابتك…" : "أو اكتب إجابتك…", text: $store.mohassanAnswerDraft, axis: .vertical).lineLimit(1...4)
                Button("إرسال الإجابة") { store.answerMohassan(text: store.mohassanAnswerDraft); dismissKeyboard() }
                    .buttonStyle(ForestButton())
                    .disabled(cardsLocked || store.mohassanAnswerDraft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !WaslaStore.mohassanTextFits(store.mohassanAnswerDraft))
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
            }.disabled(cardsLocked)
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

/// The brain's several questions in one card, one at a time, as the web's QuestionPanel: its suggestions
/// (the confident ones chosen in advance), a box for another answer, a short review, then one send.
struct FieldQuestionCard: View {
    let question: MohassanQuestion
    let busy: Bool
    let onSubmit: ([MohassanFieldAnswer]) -> Void
    let onStop: (() -> Void)?
    private let fields: [MohassanField]
    @State private var chosen: [Set<Int>]
    @State private var other: [String]
    @State private var step = 0

    init(question: MohassanQuestion, busy: Bool, onSubmit: @escaping ([MohassanFieldAnswer]) -> Void, onStop: (() -> Void)?) {
        self.question = question
        self.busy = busy
        self.onSubmit = onSubmit
        self.onStop = onStop
        let fields = question.phoneFields
        self.fields = fields
        _chosen = State(initialValue: fields.map(\.preselected))
        _other = State(initialValue: fields.map { $0.initialValue ?? "" })
    }

    private var several: Bool { fields.count > 1 }
    private var reviewing: Bool { several && step >= fields.count }
    private var answers: [String] { fields.indices.map { FieldAnswers.answer(fields[$0], chosen: chosen[$0], typed: other[$0]) } }

    var body: some View {
        let total = FieldAnswers.length(answers)
        Card {
            HStack(spacing: 8) {
                Label(several ? "أسئلة من موحسن" : "سؤال من موحسن", systemImage: "questionmark.bubble").font(.headline)
                Spacer(minLength: 4)
                Text(reviewing ? "راجع إجاباتك" : several ? "\(step + 1) من \(fields.count)" : "سؤال واحد").font(.caption).foregroundStyle(.secondary)
            }
            if several { tabs }
            if reviewing { review } else if fields.indices.contains(step) { fieldView(step).id(step) }
            if total > FieldAnswers.limit {
                Text("الإجابات \(total) من \(FieldAnswers.limit) حرف. اختصر بعض النص قبل الإرسال.").font(.footnote).foregroundStyle(Forest.alert)
            }
            actions
        }
    }

    private var tabs: some View {
        HStack(spacing: 8) {
            ForEach(fields.indices, id: \.self) { index in
                let answered = !answers[index].isEmpty
                Button { step = index } label: {
                    Group { if answered { Image(systemName: "checkmark") } else { Text("\(index + 1)") } }
                        .font(.caption.weight(.semibold)).frame(width: 30, height: 30)
                        .background(step == index ? Forest.accent : Forest.soft, in: Circle())
                        .foregroundStyle(step == index ? Forest.onAccent : Forest.ink)
                }
                .buttonStyle(.plain).disabled(busy)
                .accessibilityLabel("السؤال \(index + 1)\(answered ? "، أُجيب" : "")")
            }
            Button { step = fields.count } label: {
                Text("إرسال").font(.caption.weight(.semibold)).padding(.horizontal, 12).frame(height: 30)
                    .background(reviewing ? Forest.accent : Forest.soft, in: Capsule())
                    .foregroundStyle(reviewing ? Forest.onAccent : Forest.ink)
            }
            .buttonStyle(.plain).disabled(busy || !FieldAnswers.ready(answers))
            Spacer(minLength: 0)
        }
    }

    private func fieldView(_ index: Int) -> some View {
        let field = fields[index]
        let typedHere = !other[index].trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        return VStack(alignment: .leading, spacing: 10) {
            Text(field.prompt).font(.body.weight(.medium))
            if field.allowsSeveral { Text("يمكنك اختيار أكثر من واحد، ثم اضغط «التالي».").font(.footnote).foregroundStyle(.secondary) }
            ForEach(Array(field.suggestions.enumerated()), id: \.offset) { position, suggestion in
                // In a single-answer question a typed answer replaces the chosen suggestion.
                let on = chosen[index].contains(position) && !(typedHere && !field.allowsSeveral)
                Button { pick(index, position) } label: {
                    HStack(alignment: .top, spacing: 10) {
                        Image(systemName: on ? (field.allowsSeveral ? "checkmark.square.fill" : "largecircle.fill.circle") : (field.allowsSeveral ? "square" : "circle"))
                            .foregroundStyle(on ? Forest.accent : Forest.faint)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(suggestion.label).foregroundStyle(Forest.ink)
                            if let reason = suggestion.reason, !reason.isEmpty { Text(reason).font(.caption).foregroundStyle(.secondary) }
                        }
                        Spacer(minLength: 0)
                    }
                    .padding(.vertical, 10).padding(.horizontal, 12)
                    .background(on ? Forest.accentSoft : Forest.surface, in: RoundedRectangle(cornerRadius: 12))
                    .overlay(RoundedRectangle(cornerRadius: 12).stroke(on ? Forest.accent : Forest.line))
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain).disabled(busy)
                .accessibilityAddTraits(on ? .isSelected : [])
            }
            TextField(field.placeholder ?? (field.suggestions.isEmpty ? "اكتب إجابتك…" : "إجابة أخرى…"), text: $other[index], axis: .vertical)
                .lineLimit(field.keepsLines ? 3...8 : 1...4)
                .padding(10)
                .background(Forest.background, in: RoundedRectangle(cornerRadius: 12))
                .overlay(RoundedRectangle(cornerRadius: 12).stroke(typedHere ? Forest.accent : Forest.line))
                .disabled(busy)
                .accessibilityLabel("\(field.prompt): \(field.suggestions.isEmpty ? "إجابتك" : "إجابة أخرى")")
        }
    }

    private var review: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(fields.indices, id: \.self) { index in
                Button { step = index } label: {
                    VStack(alignment: .leading, spacing: 3) {
                        Text(fields[index].prompt).font(.caption).foregroundStyle(.secondary)
                        Text(answers[index].isEmpty ? "—" : answers[index]).foregroundStyle(Forest.ink)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.vertical, 8).padding(.horizontal, 12)
                    .background(Forest.background, in: RoundedRectangle(cornerRadius: 12))
                }
                .buttonStyle(.plain).disabled(busy)
            }
            Text("اضغط سؤالًا لتعديل إجابته.").font(.caption).foregroundStyle(.secondary)
        }
    }

    private var actions: some View {
        VStack(spacing: 8) {
            HStack(spacing: 12) {
                if several && step > 0 { Button("رجوع") { step -= 1 }.buttonStyle(ForestButton(prominent: false)).disabled(busy) }
                if reviewing {
                    Button("أرسل الإجابات") { submit() }.buttonStyle(ForestButton()).disabled(busy || !FieldAnswers.ready(answers))
                } else {
                    Button(several ? "التالي" : "أرسل") { next() }.buttonStyle(ForestButton())
                        .disabled(busy || !fields.indices.contains(step) || answers[step].isEmpty)
                }
            }
            if let onStop { Button("توقف هنا", role: .destructive) { onStop() }.font(.subheadline).disabled(busy) }
        }
    }

    private func pick(_ index: Int, _ position: Int) {
        guard !busy else { return }
        if fields[index].allowsSeveral {
            if chosen[index].contains(position) { chosen[index].remove(position) } else { chosen[index].insert(position) }
            return
        }
        chosen[index] = [position]
        other[index] = ""
        // A single choice goes on by itself, as on the web.
        Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(140))
            next()
        }
    }

    private func next() {
        guard !busy else { return }
        if !several {
            if FieldAnswers.ready(answers) { submit() }
            return
        }
        guard fields.indices.contains(step), !answers[step].isEmpty else { return }
        // On to the first question still unanswered, or to the review once all are.
        let current = answers, now = step
        step = fields.indices.first { $0 > now && current[$0].isEmpty } ?? fields.count
    }

    private func submit() {
        let current = answers
        guard !busy, FieldAnswers.ready(current) else { return }
        onSubmit(fields.indices.map { MohassanFieldAnswer(fieldId: fields[$0].id, value: current[$0]) })
    }
}

struct MohassanListView: View {
    @EnvironmentObject private var store: WaslaStore
    @Environment(\.dismiss) private var dismiss
    @State private var deleting: MohassanSummary?
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
                    .disabled(store.mohassanSending)
                    .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                        Button { deleting = item } label: { Label("حذف", systemImage: "trash") }.tint(Forest.alert)
                    }
                }
            }
            .navigationTitle("محادثات موحسن").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("تم") { dismiss() } } }
            .refreshable { await store.loadMohassanList() }
            .confirmationDialog("حذف هذه المحادثة؟", isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } }),
                                titleVisibility: .visible, presenting: deleting) { item in
                Button("حذف المحادثة", role: .destructive) { let id = item.id; Task { await store.deleteMohassan(id) } }
            } message: { item in
                Text("«\(item.title.isEmpty ? "محادثة" : item.title)» تُحذف من موحسن على الكمبيوتر، ولا يمكن التراجع.")
            }
        }.environment(\.layoutDirection, .rightToLeft)
    }
}
