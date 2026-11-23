import SwiftUI
import PhotosUI
import UIKit

// Mohassan's chat on the phone: the same conversations, brain, questions and approvals as the web, on the cloud
// server. Every changing call carries an Idempotency-Key. After a lost reply the phone sends the very same request
// again with the same key, but only when the server says it honours keys (`requestKeys`), so nothing runs twice.
// A card's answer is refused by any server once its card is gone, so it may go again too. Replies arrive by
// long-poll: the server holds a read until the conversation changes.

extension WaslaStore {
    /// While the assistant waits for a several-questions card, the card answers it, not the composer.
    var asking: Bool { conversation?.fieldsQuestion != nil }
    /// A changing request is on its way or not settled: nothing new is sent until it is.
    var busy: Bool { sending || pending != nil }

    private static let pendingKey = "mohassan.chat.pending"
    static let maxImages = 4

    /// The server takes up to 4,000 UTF-16 units per message.
    nonisolated static func textFits(_ text: String) -> Bool { text.utf16.count <= 4_000 }

    func loadChatList() async {
        guard let client else { return }
        let epoch = sessionEpoch
        do {
            let list: ChatList = try await client.get("/api/chat/conversations")
            guard epoch == sessionEpoch else { return }
            chatList = list.conversations
            if let found = list.capabilities { capabilities = found }
            requestKeys = list.requestKeys == true
        } catch { if epoch == sessionEpoch { show(error) } }
    }

    func checkImages() async {
        guard let client else { return }
        let epoch = sessionEpoch
        do {
            let reply: ChatImageAvailability = try await client.get("/api/chat/images", timeout: 15)
            if epoch == sessionEpoch { imagesAvailable = reply.available }
        } catch { if epoch == sessionEpoch { imagesAvailable = false } }
    }

    func newChat() {
        chatEpoch += 1
        stopWatching()
        conversation = nil
    }

    func openConversation(_ id: String) async {
        guard UUID(uuidString: id) != nil, !sending else { return }
        newChat()
        await refreshConversation(id)
    }

    func refreshConversation(_ id: String) async {
        guard let client, UUID(uuidString: id) != nil else { return }
        let epoch = sessionEpoch, screen = chatEpoch
        do {
            let detail: ChatConversation = try await client.get("/api/chat/conversations/\(id)")
            guard epoch == sessionEpoch, screen == chatEpoch else { return }
            present(detail)
        } catch { if epoch == sessionEpoch, screen == chatEpoch { show(error) } }
    }

    /// Shows a conversation the server returned, and keeps following it.
    func present(_ detail: ChatConversation) {
        conversation = detail
        if let found = detail.capabilities { capabilities = found }
        watch()
    }

    // MARK: Changing requests, each with its own key

    /// Sends the composer's text and photos: a new conversation, or a message in the open one. While Mohassan works,
    /// the server takes a message as a correction of the running task.
    @discardableResult
    func send() -> Bool {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        let photos = attachments
        guard signedIn, !busy, !uploading, !asking, !text.isEmpty || !photos.isEmpty else { return false }
        guard Self.textFits(text) else { errorMessage = "الرسالة تتجاوز ٤٬٠٠٠ حرف. اختصرها قبل الإرسال."; return false }
        let ids: [String]? = photos.isEmpty ? nil : photos.map(\.id)
        let request: PendingRequest
        do {
            if let id = conversation?.id, UUID(uuidString: id) != nil {
                request = try PendingRequest.make(.message, conversationId: id, text: text, attachments: photos,
                                                  body: ChatSend(text: text, questionId: nil, answers: nil, images: ids))
            } else {
                request = try PendingRequest.make(.create, conversationId: nil, text: text, attachments: photos,
                                                  body: ChatCreate(goal: text.isEmpty ? nil : text, images: ids))
            }
        } catch { show(error); return false }
        // The text now shows as the pending turn; it comes back to the box if the server refuses it.
        draft = ""
        attachments = []
        submit(request)
        return true
    }

    /// One option of the pending question.
    func answer(option: ChatOption) {
        guard let conversation, conversation.status == ChatStatus.waitingUser, let question = conversation.question else { return }
        sendKeyed(.option, conversationId: conversation.id, text: option.label, body: ChatRespond(questionId: question.id, optionId: option.id))
    }

    /// The answers of a several-questions card, in the card's order.
    func answer(fields answers: [ChatFieldAnswer]) {
        guard let conversation, let question = conversation.fieldsQuestion, !answers.isEmpty,
              answers.map(\.fieldId) == question.phoneFields.map(\.id), FieldAnswers.ready(answers.map(\.value)) else { return }
        let summary = answers.count > 1 ? answers.enumerated().map { "\($0.offset + 1). \($0.element.value)" }.joined(separator: "\n") : answers[0].value
        sendKeyed(.fields, conversationId: conversation.id, text: summary, body: ChatSend(text: "", questionId: question.id, answers: answers, images: nil))
    }

    func approve(_ approved: Bool) {
        guard let conversation, conversation.status == ChatStatus.waitingApproval, let approval = conversation.approval else { return }
        sendKeyed(.approve, conversationId: conversation.id, text: approved ? "موافق" : "لا تفعل", body: ChatApprove(approvalId: approval.id, approved: approved))
    }

    private func sendKeyed<Body: Encodable>(_ kind: PendingRequest.Kind, conversationId: String, text: String, body: Body) {
        guard signedIn, UUID(uuidString: conversationId) != nil, !busy else { return }
        do { submit(try PendingRequest.make(kind, conversationId: conversationId, text: text, body: body)) }
        catch { show(error) }
    }

    /// A credential, a finished step or a skip for the pending secure request. Never resent: its values go to the page once.
    func secure(_ action: String, values: [String: String]? = nil) {
        guard let client, let conversation, conversation.status == ChatStatus.waitingInput, let request = conversation.secure, !secureBusy else { return }
        let epoch = sessionEpoch, screen = chatEpoch, id = conversation.id
        let body: Data
        do { body = try JSONEncoder().encode(ChatSecureSubmit(requestId: request.id, action: action, values: values)) } catch { show(error); return }
        secureBusy = true
        Task {
            defer { self.secureBusy = false }
            do {
                let reply = try await client.send("/api/chat/conversations/\(id)/secure", method: "POST", body: body, timeout: 120)
                guard epoch == self.sessionEpoch, screen == self.chatEpoch else { return }
                if let detail = try? JSONDecoder().decode(ChatConversation.self, from: reply.data), detail.id == id { self.present(detail) }
                else { await self.refreshConversation(id) }
            } catch {
                guard epoch == self.sessionEpoch else { return }
                self.show(error)
                if screen == self.chatEpoch { await self.refreshConversation(id) }
            }
        }
    }

    /// Stopping is always allowed, even while another call is in flight; stopping twice stops once.
    func cancelRun() {
        guard let client, let id = conversation?.id, UUID(uuidString: id) != nil else { return }
        let epoch = sessionEpoch, screen = chatEpoch
        Task {
            do {
                _ = try await client.send("/api/chat/conversations/\(id)/cancel", method: "POST", body: Data("{}".utf8), timeout: 45)
                guard epoch == self.sessionEpoch, screen == self.chatEpoch else { return }
                await self.refreshConversation(id)
            } catch { if epoch == self.sessionEpoch { self.show(error) } }
        }
    }

    func deleteConversation(_ id: String) async {
        guard let client, UUID(uuidString: id) != nil else { return }
        let epoch = sessionEpoch
        do {
            try await client.delete("/api/chat/conversations/\(id)")
            guard epoch == sessionEpoch else { return }
            chatList.removeAll { $0.id == id }
            // A request into a deleted conversation has nothing left to confirm.
            if let request = pending, request.conversationId == id, request.phase == .unconfirmed { settle(request.key) }
            if conversation?.id == id { newChat() }
        } catch { if epoch == sessionEpoch { show(error) } }
    }

    /// The owner's judgement of one reply: a rating record on the server, never training data.
    func feedback(_ verdict: String, for messageId: String) async -> Bool {
        guard let client, let id = conversation?.id, UUID(uuidString: id) != nil, UUID(uuidString: messageId) != nil else { return false }
        do {
            let body = try JSONEncoder().encode(ChatFeedback(messageId: messageId, verdict: verdict))
            _ = try await client.send("/api/chat/conversations/\(id)/feedback", method: "POST", body: body, timeout: 20)
            return true
        } catch {
            show(error)
            return false
        }
    }

    /// Sends one keyed request. A lost reply, or the same key still running, sends the same bytes with the same key
    /// again after 1, 2, 4 and 8 s, in the foreground only; then the card waits for the owner's tap.
    private func submit(_ request: PendingRequest) {
        guard let client else { return }
        var first = request
        first.phase = .sending
        first.note = nil
        pending = first
        savePending()
        sending = true
        let epoch = sessionEpoch, screen = chatEpoch
        let sent = first
        Task {
            var current = sent
            while true {
                do {
                    let reply = try await client.send(current.path, method: "POST", body: current.body, key: current.key, timeout: 150)
                    guard epoch == self.sessionEpoch else { return }
                    self.sending = false
                    guard self.pending?.key == current.key else { return }
                    await self.delivered(current, data: reply.data, sameScreen: screen == self.chatEpoch)
                    return
                } catch {
                    guard epoch == self.sessionEpoch else { return }
                    guard self.pending?.key == current.key else { self.sending = false; return }
                    switch SendOutcome.of(error) {
                    case .signedOut:
                        self.sending = false
                        self.signedOutByServer()
                        return
                    case .notDone(let reason):
                        self.sending = false
                        await self.refused(current, reason: reason)
                        return
                    case .inProgress(let reason), .unknown(let reason):
                        current.attempts += 1
                        let safe = self.requestKeys || !current.fromComposer
                        if safe, self.foreground, current.attempts <= 4 {
                            current.note = reason
                            self.pending = current
                            self.savePending()
                            do { try await Task.sleep(for: .seconds(PendingRequest.backoff(current.attempts))) } catch { return }
                            guard epoch == self.sessionEpoch else { return }
                            guard self.pending?.key == current.key else { self.sending = false; return }
                            continue
                        }
                        self.sending = false
                        current.phase = .unconfirmed
                        current.note = reason
                        self.pending = current
                        self.savePending()
                        return
                    }
                }
            }
        }
    }

    private func delivered(_ request: PendingRequest, data: Data, sameScreen: Bool) async {
        settle(request.key)
        let detail = try? JSONDecoder().decode(ChatConversation.self, from: data)
        if request.kind == .create { await loadChatList() }
        guard sameScreen, request.belongs(to: conversation?.id) else { return }
        if let detail, request.kind == .create || detail.id == request.conversationId { present(detail) }
        else if let id = request.conversationId { await refreshConversation(id) }
    }

    /// The server refused the request, so nothing happened: the text and photos return to the box.
    private func refused(_ request: PendingRequest, reason: String) async {
        settle(request.key)
        handBack(request)
        errorMessage = request.fromComposer ? reason + "\nبقي نصك في الصندوق." : reason
        // A refused answer or approval usually means the card changed: show the current one.
        if !request.fromComposer, let id = request.conversationId, conversation?.id == id { await refreshConversation(id) }
    }

    /// Puts a request's text and photos back where the owner left them, keeping anything added since.
    private func handBack(_ request: PendingRequest) {
        guard request.fromComposer else { return }
        if !request.text.isEmpty { draft = draft.isEmpty ? request.text : request.text + "\n" + draft }
        let held = Set(attachments.map(\.id))
        attachments = Array((request.attachments.filter { !held.contains($0.id) } + attachments).prefix(Self.maxImages))
    }

    /// Sends the unconfirmed request again with its own key, on the owner's tap.
    func resendPending() {
        guard let request = pending, request.phase == .unconfirmed, !sending else { return }
        var again = request
        again.attempts = 0
        submit(again)
    }

    /// Lets go of the unconfirmed request: the phone stops following it and its text returns to the box.
    /// It stops nothing on the server.
    func dropPending() {
        guard let request = pending, request.phase == .unconfirmed else { return }
        settle(request.key)
        handBack(request)
        if let id = request.conversationId, conversation?.id == id { Task { await self.refreshConversation(id) } }
    }

    /// Reads the conversation (or the list) again so the owner can see whether the request arrived. Nothing is sent.
    func checkPending() async {
        guard let request = pending else { return }
        if let id = request.conversationId { await refreshConversation(id) } else { await loadChatList() }
    }

    func settle(_ key: String) {
        guard pending?.key == key else { return }
        pending = nil
        savePending()
    }

    /// Kept on the phone so a closed app can send the same request again with its key later.
    func savePending() {
        if let request = pending, let data = try? JSONEncoder().encode(request) { UserDefaults.standard.set(data, forKey: Self.pendingKey) }
        else { UserDefaults.standard.removeObject(forKey: Self.pendingKey) }
    }

    /// At launch: the request the last run left unconfirmed.
    func restorePending() {
        guard let data = UserDefaults.standard.data(forKey: Self.pendingKey) else { return }
        guard var request = try? JSONDecoder().decode(PendingRequest.self, from: data), PendingRequest.validKey(request.key) else {
            UserDefaults.standard.removeObject(forKey: Self.pendingKey)
            return
        }
        if request.phase == .sending {
            request.phase = .unconfirmed
            request.note = "أُغلق التطبيق قبل أن يتأكد وصول الطلب."
        }
        pending = request
    }

    /// Back in the app: an unconfirmed request goes again by itself when that is safe (the same key on a server that
    /// honours keys, or a card's answer, which a server refuses once taken).
    func resumePending() {
        guard let request = pending, request.phase == .unconfirmed, !sending, request.resendable() else { return }
        if requestKeys || !request.fromComposer { resendPending() }
    }

    // MARK: Following the open conversation

    /// Holds a read until the conversation changes (long-poll), while the app is open. An older server without
    /// `version` is read every two seconds while Mohassan works.
    func watch() {
        guard watchTask == nil, foreground, signedIn, let id = conversation?.id, UUID(uuidString: id) != nil else { return }
        watchID += 1
        let token = watchID, epoch = sessionEpoch, screen = chatEpoch
        watchTask = Task {
            await self.follow(id, epoch: epoch, screen: screen)
            if self.watchID == token { self.watchTask = nil }
        }
    }

    private func follow(_ id: String, epoch: Int, screen: Int) async {
        var failures = 0
        while !Task.isCancelled {
            guard foreground, epoch == sessionEpoch, screen == chatEpoch, let client, let current = conversation, current.id == id else { return }
            do {
                let detail: ChatConversation
                if let version = current.version {
                    detail = try await client.get("/api/chat/conversations/\(id)",
                                                  query: [URLQueryItem(name: "since", value: version), URLQueryItem(name: "wait", value: "8000")], timeout: 20)
                } else {
                    guard current.working else { return }
                    try await Task.sleep(for: .seconds(2))
                    detail = try await client.get("/api/chat/conversations/\(id)")
                }
                guard !Task.isCancelled, epoch == sessionEpoch, screen == chatEpoch, detail.id == id else { return }
                failures = 0
                conversation = detail
                if let found = detail.capabilities { capabilities = found }
            } catch {
                if Task.isCancelled { return }
                if let failure = error as? WaslaError, case .signedOut = failure { signedOutByServer(); return }
                failures += 1
                if failures >= 6 {
                    if epoch == sessionEpoch, screen == chatEpoch { show(error) }
                    return
                }
                do { try await Task.sleep(for: .seconds(min(2 * failures, 10))) } catch { return }
            }
        }
    }

    func stopWatching() {
        watchID += 1
        watchTask?.cancel()
        watchTask = nil
    }

    func chatSceneChanged(active: Bool) {
        if active {
            if let id = conversation?.id { Task { await self.refreshConversation(id) } }
            else { Task { await self.loadChatList() } }
            resumePending()
        } else {
            stopWatching()
        }
    }

    // MARK: Photos

    /// Uploads one photo (JPEG, at most 2048 px on its long side and 5 MB) to go with the next message.
    func attach(_ data: Data) async {
        guard let client, attachments.count < Self.maxImages else { return }
        uploading = true
        defer { uploading = false }
        let prepared = await Task.detached(priority: .userInitiated) { WaslaStore.prepare(data) }.value
        guard let prepared else { errorMessage = "تعذّر قراءة هذه الصورة."; return }
        let epoch = sessionEpoch
        do {
            let uploaded: ChatImageUploaded = try await client.post("/api/chat/images", body: ChatImageUpload(mimeType: "image/jpeg", data: prepared.jpeg.base64EncodedString()), timeout: 90)
            guard epoch == sessionEpoch, UUID(uuidString: uploaded.id) != nil, attachments.count < Self.maxImages else { return }
            attachments.append(ChatAttachment(id: uploaded.id, preview: prepared.preview))
        } catch { if epoch == sessionEpoch { show(error) } }
    }

    func removeAttachment(_ id: String) { attachments.removeAll { $0.id == id } }

    nonisolated static func prepare(_ data: Data) -> (jpeg: Data, preview: Data)? {
        guard let image = UIImage(data: data) else { return nil }
        let full = scaled(image, longSide: 2048)
        var quality: CGFloat = 0.82
        var jpeg = full.jpegData(compressionQuality: quality)
        while let current = jpeg, current.count > 5_000_000, quality > 0.35 {
            quality -= 0.15
            jpeg = full.jpegData(compressionQuality: quality)
        }
        guard let encoded = jpeg, encoded.count <= 5_000_000, let preview = scaled(image, longSide: 240).jpegData(compressionQuality: 0.7) else { return nil }
        return (encoded, preview)
    }

    nonisolated static func scaled(_ image: UIImage, longSide: CGFloat) -> UIImage {
        let size = image.size
        let longest = max(size.width, size.height)
        guard longest > longSide, longest > 0 else { return image }
        let factor = longSide / longest
        let target = CGSize(width: max(1, (size.width * factor).rounded()), height: max(1, (size.height * factor).rounded()))
        let format = UIGraphicsImageRendererFormat.preferred()
        format.scale = 1
        return UIGraphicsImageRenderer(size: target, format: format).image { _ in image.draw(in: CGRect(origin: .zero, size: target)) }
    }

    /// A photo the owner attached to an earlier message, read once with the session.
    func loadImage(_ id: String) async {
        guard images[id] == nil, let client, UUID(uuidString: id) != nil else { return }
        do {
            let reply = try await client.send("/api/chat/images/\(id)", timeout: 30)
            if let image = UIImage(data: reply.data) { images[id] = image }
        } catch {}
    }

    /// The latest screenshot of the browser Mohassan works in, on the server.
    func browserScreen() async -> UIImage? {
        guard let client, let current = conversation, let browser = current.browser,
              let screen = browser.screen(conversation: current.id) else { return nil }
        guard let reply = try? await client.send(screen.path, query: screen.query, timeout: 20) else { return nil }
        return UIImage(data: reply.data)
    }
}

struct ChatView: View {
    @EnvironmentObject private var store: WaslaStore
    @State private var listShown = false
    @State private var settingsShown = false
    @State private var remoteShown = false
    @State private var screenShown = false
    @State private var approveConfirm = false
    @State private var dropConfirm = false
    @State private var browsing: BrowserDestination?
    @State private var picks: [PhotosPickerItem] = []
    private var clean: String { store.draft.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var scrollKey: Int {
        let conversation = store.conversation
        let request: Int
        switch store.pending?.phase {
        case .none: request = 0
        case .sending: request = 1
        case .unconfirmed: request = 2
        }
        return (conversation?.messages.count ?? 0) * 1_000 + (conversation?.steps.count ?? 0) * 2 + (conversation?.waiting == true ? 1 : 0) + request * 100_000
    }
    private var canSend: Bool {
        store.signedIn && !store.busy && !store.uploading && (!clean.isEmpty || !store.attachments.isEmpty) && WaslaStore.textFits(store.draft)
    }
    private var notice: String? {
        if let request = store.pending, request.phase == .unconfirmed { return "تحقّق من الطلب السابق قبل رسالة جديدة." }
        if store.conversation?.working == true, !clean.isEmpty { return "رسالتك تصل موحسن وهو يعمل، فيأخذها تصحيحًا للمهمة الجارية." }
        return nil
    }
    private var cardsLocked: Bool { store.busy }

    var body: some View {
        NavigationStack {
            ChatScaffold(
                draft: $store.draft,
                placeholder: store.conversation == nil ? "ماذا تريد أن ينجز موحسن؟" : "اكتب رسالتك…",
                tooLong: !WaslaStore.textFits(store.draft),
                canSend: canSend,
                working: store.conversation?.working == true,
                scrollKey: scrollKey,
                showComposer: !store.asking,
                notice: notice,
                tools: store.imagesAvailable ? AnyView(photoButton) : nil,
                tray: store.attachments.isEmpty && !store.uploading ? nil : AnyView(AttachmentTray()),
                onSend: { store.send() },
                onStop: { store.cancelRun() }
            ) {
                if let conversation = store.conversation {
                    conversationView(conversation)
                } else if store.pending == nil {
                    ChatWelcome(title: "بمَ أساعدك اليوم؟", suggestions: ["خطّط لحملة إعلانية", "لخّص لي موضوعًا", "نظّم مهامي"], note: store.capabilities?.localModeText) { store.draft = $0 }
                }
                if let request = store.pending { pendingView(request) }
            }
            .background(Forest.background)
            .navigationTitle("موحسن")
            .navigationBarTitleDisplayMode(.inline)
            .toolbarBackground(Forest.background, for: .navigationBar)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button { listShown = true; Task { await store.loadChatList() } } label: { Image(systemName: "sidebar.right") }.accessibilityLabel("المحادثات")
                }
                ToolbarItem(placement: .topBarLeading) {
                    Button { store.newChat(); store.draft = "" } label: { Image(systemName: "square.and.pencil") }
                        .disabled(store.sending).accessibilityLabel("محادثة جديدة")
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button { remoteShown = true } label: {
                        Image(systemName: store.remoteWanted ? "desktopcomputer.and.arrow.down" : "desktopcomputer")
                            .foregroundStyle(store.remoteWanted ? Forest.accent : Forest.ink)
                    }
                    .accessibilityLabel(store.remoteWanted ? "التحكم بالكمبيوتر مفعّل" : "التحكم بالكمبيوتر")
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button { settingsShown = true } label: { Image(systemName: "gearshape") }.accessibilityLabel("الإعدادات")
                }
                ToolbarItemGroup(placement: .keyboard) { Spacer(); Button("تم") { dismissKeyboard() } }
            }
        }
        // Links in replies open here, in Safari inside the app, and only when they are https.
        .environment(\.openURL, OpenURLAction { url in
            guard let safe = SafeLink.https(url.absoluteString) else { return .discarded }
            browsing = BrowserDestination(url: safe)
            return .handled
        })
        .sheet(isPresented: $listShown) { ConversationListView() }
        .sheet(isPresented: $settingsShown) { SettingsView() }
        .sheet(isPresented: $remoteShown) { RemoteControlView() }
        .sheet(isPresented: $screenShown) { BrowserScreenView() }
        .sheet(item: $browsing) { SafariView(url: $0.url).ignoresSafeArea() }
        .confirmationDialog("ترك هذا الطلب؟", isPresented: $dropConfirm, titleVisibility: .visible) {
            Button("اتركه", role: .destructive) { store.dropPending() }
        } message: {
            Text("قد يكون الخادم استلمه. تركه هنا لا يوقف شيئًا هناك، ويعود نصك إلى الصندوق. راجع المحادثة قبل أن ترسل من جديد.")
        }
        .onChange(of: picks) { _, items in
            guard !items.isEmpty else { return }
            picks = []
            Task {
                for item in items {
                    if let data = try? await item.loadTransferable(type: Data.self) { await store.attach(data) }
                }
            }
        }
    }

    private var photoButton: some View {
        PhotosPicker(selection: $picks, maxSelectionCount: max(1, WaslaStore.maxImages - store.attachments.count), matching: .images) {
            Image(systemName: "photo.badge.plus").font(.body).frame(width: 36, height: 36)
                .foregroundStyle(store.attachments.count < WaslaStore.maxImages ? Forest.softText : Forest.faint)
        }
        .disabled(store.uploading || store.attachments.count >= WaslaStore.maxImages || store.busy)
        .accessibilityLabel("إرفاق صورة")
    }

    @ViewBuilder private func conversationView(_ conversation: ChatConversation) -> some View {
        let fieldsQuestion = conversation.fieldsQuestion
        if let older = conversation.olderMessages {
            Text("رسائل أقدم غير معروضة هنا (\(older))، والمعروض آخر \(conversation.messages.count) رسالة.").font(.footnote).foregroundStyle(.secondary)
        }
        ForEach(Array(conversation.messages.enumerated()), id: \.element.id) { index, message in
            // While a field card holds the questions, the last reply need not list them again (as on the web).
            let listed = fieldsQuestion != nil && index == conversation.messages.count - 1 && !message.mine
            VStack(alignment: .leading, spacing: 8) {
                if message.mine, let refs = message.images, !refs.isEmpty { MessageImages(refs: refs) }
                if !(message.mine && message.text.isEmpty) {
                    ChatTurn(mine: message.mine, text: listed ? ReplyMarkdown.withoutQuestionList(message.text) : message.text, messageId: message.mine ? nil : message.id)
                }
            }
        }
        if let browser = conversation.browser { BrowserLine(browser: browser) { screenShown = true } }
        if conversation.working {
            WorkingSteps(progress: conversation.progress ?? "موحسن يعمل…", steps: conversation.steps.map(\.text))
        }
        if conversation.status == ChatStatus.waitingUser, let question = conversation.question {
            if let fieldsQuestion {
                FieldQuestionCard(question: fieldsQuestion, busy: cardsLocked, onSubmit: { store.answer(fields: $0) },
                                  onStop: fieldsQuestion.stopOption.map { option in { store.answer(option: option) } })
                    .id(fieldsQuestion.id)
            } else if !question.phoneOptions.isEmpty {
                optionsCard(question)
            }
        }
        if conversation.status == ChatStatus.waitingApproval, let approval = conversation.approval { approvalCard(approval) }
        if conversation.status == ChatStatus.waitingInput, let secure = conversation.secure {
            SecureCard(request: secure, busy: store.secureBusy || cardsLocked) { action, values in store.secure(action, values: values) }
                .id(secure.id)
        }
        if !conversation.working, let error = conversation.error, !error.isEmpty {
            Text(error).font(.subheadline).foregroundStyle(Forest.alert)
                .padding(.vertical, 9).padding(.horizontal, 12).frame(maxWidth: .infinity, alignment: .leading)
                .background(Forest.alert.opacity(0.1), in: RoundedRectangle(cornerRadius: 10))
        }
        if conversation.waiting {
            Button(role: .destructive) { store.cancelRun() } label: { Label("إيقاف", systemImage: "stop.fill") }
                .buttonStyle(ForestButton(prominent: false))
        }
    }

    /// The request whose outcome is still open: its text while it travels, then what is known and what the owner can do.
    @ViewBuilder private func pendingView(_ request: PendingRequest) -> some View {
        let here = request.belongs(to: store.conversation?.id)
        if here, request.fromComposer {
            if !request.attachments.isEmpty { AttachmentPreviews(items: request.attachments) }
            if !request.text.isEmpty { ChatTurn(mine: true, text: request.text) }
        }
        if request.phase == .sending {
            if request.fromComposer || request.attempts > 0 {
                WorkingSteps(progress: request.attempts > 0 ? "يعيد الإرسال بالمفتاح نفسه…" : "يُرسل إلى موحسن…", steps: [])
            }
        } else {
            Card {
                Label("لم يتأكد وصول الطلب", systemImage: "exclamationmark.triangle").font(.headline).foregroundStyle(Forest.alert)
                if !(here && request.fromComposer), !request.text.isEmpty {
                    Text(request.text).font(.subheadline).lineLimit(3)
                        .padding(.vertical, 6).padding(.horizontal, 10).frame(maxWidth: .infinity, alignment: .leading)
                        .background(Forest.soft, in: RoundedRectangle(cornerRadius: 10))
                }
                if !here { Text(request.kind == .create ? "في محادثة جديدة." : "في محادثة أخرى.").font(.caption).foregroundStyle(.secondary) }
                if let note = request.note, !note.isEmpty { Text(note).font(.footnote).foregroundStyle(.secondary) }
                Text(store.requestKeys || !request.fromComposer
                     ? "«أرسل مرة أخرى» آمن: يحمل المفتاح نفسه، فإن كان قد وصل فلن يتكرر."
                     : "هذا الخادم لا يمنع التكرار بعد. راجع المحادثة قبل أن ترسل مرة أخرى.")
                    .font(.footnote).foregroundStyle(.secondary)
                HStack(spacing: 12) {
                    Button("أرسل مرة أخرى") { store.resendPending() }.buttonStyle(ForestButton())
                    Button("راجع المحادثة") { Task { await store.checkPending() } }.buttonStyle(ForestButton(prominent: false))
                }
                .disabled(store.sending)
                Button("اتركه", role: .destructive) { dropConfirm = true }.font(.footnote).disabled(store.sending)
            }
        }
    }

    private func optionsCard(_ question: ChatQuestion) -> some View {
        Card {
            Label("اختر إجابة", systemImage: "questionmark.bubble").font(.headline)
            ForEach(question.phoneOptions) { option in
                Button { store.answer(option: option) } label: { Text(option.label).frame(maxWidth: .infinity, alignment: .leading) }
                    .buttonStyle(ForestButton(prominent: false)).disabled(cardsLocked)
            }
            if question.action == "google_ads_connect" {
                Text("ربط حساب Google Ads يتم من واجهة موحسن على الويب.").font(.footnote).foregroundStyle(.secondary)
            }
            Text("أو اكتب إجابتك في الصندوق أدناه.").font(.footnote).foregroundStyle(.secondary)
        }
    }

    private func approvalCard(_ approval: ChatApproval) -> some View {
        Card {
            Label("يحتاج موافقتك", systemImage: "checkmark.shield").font(.headline)
            Text(approval.prompt)
            if let target = approval.target, !target.isEmpty { Text("الهدف: \(target)").font(.footnote) }
            if let consequence = approval.consequence, !consequence.isEmpty { Text("ما سيحدث: \(consequence)").font(.footnote) }
            if let reversible = approval.reversible { Text(reversible ? "يمكن التراجع عنه." : "لا يمكن التراجع عنه.").font(.footnote) }
            if !approval.detail.isEmpty { Text(approval.detail).font(.footnote).foregroundStyle(.secondary) }
            Text("تنطبق الموافقة على هذا الإجراء بتفاصيله هذه فقط. وإن كتبت تصحيحًا بدلها، يُلغى هذا الإجراء ولا يُنفَّذ.").font(.footnote).foregroundStyle(.secondary)
            HStack(spacing: 12) {
                Button("لا تفعل") { store.approve(false) }.buttonStyle(ForestButton(prominent: false))
                Button("موافق") { approveConfirm = true }.buttonStyle(ForestButton())
            }.disabled(cardsLocked)
        }
        .confirmationDialog("تنفيذ هذا الإجراء؟", isPresented: $approveConfirm, titleVisibility: .visible) {
            Button("موافق، نفّذ") { store.approve(true) }
        } message: { Text(approval.prompt) }
    }
}

/// A credential, a code or a step for the owner's own hands (the web's SecureCard). The values go to the page once.
struct SecureCard: View {
    let request: ChatSecure
    let busy: Bool
    let onSubmit: (String, [String: String]?) -> Void
    @State private var values: [String: String] = [:]

    private var filled: Bool {
        request.fields.allSatisfy { field in
            (field.id == "username" && request.fields.count > 1) || !(values[field.id] ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        }
    }
    private var title: String {
        if request.handsOn { return "هذه الخطوة تحتاجك" }
        return request.kind == "code" ? "رمز التحقق" : "تسجيل الدخول إلى \(request.site)"
    }

    var body: some View {
        Card {
            Label(title, systemImage: "key").font(.headline)
            if !request.prompt.isEmpty { Text(request.prompt) }
            if let note = request.note, !note.isEmpty { Text(note).font(.footnote).foregroundStyle(Forest.alert) }
            ForEach(request.fields) { field in
                VStack(alignment: .leading, spacing: 6) {
                    Text(field.label).font(.subheadline.weight(.semibold))
                    input(field)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .padding(10)
                        .background(Forest.background, in: RoundedRectangle(cornerRadius: 12))
                        .environment(\.layoutDirection, .leftToRight)
                        .disabled(busy)
                }
            }
            if !request.handsOn {
                Text("تذهب هذه البيانات إلى الموقع مباشرة. لا يراها النموذج ولا تُحفظ.").font(.footnote).foregroundStyle(.secondary)
            }
            HStack(spacing: 12) {
                if request.handsOn {
                    Button("أكملت") { onSubmit("done", nil) }.buttonStyle(ForestButton())
                } else {
                    Button("متابعة") {
                        let sent = values
                        values = [:]
                        onSubmit("submit", sent)
                    }
                    .buttonStyle(ForestButton()).disabled(!filled)
                }
                Button("تخطي") { onSubmit("skip", nil) }.buttonStyle(ForestButton(prominent: false))
            }
            .disabled(busy)
        }
    }

    @ViewBuilder private func input(_ field: ChatSecureField) -> some View {
        if field.type == "password" {
            SecureField("", text: binding(field.id)).textContentType(.password)
        } else if field.type == "code" {
            TextField("", text: binding(field.id)).keyboardType(.numberPad).textContentType(.oneTimeCode)
        } else {
            TextField("", text: binding(field.id)).keyboardType(.emailAddress).textContentType(.username)
        }
    }

    private func binding(_ id: String) -> Binding<String> {
        Binding(get: { values[id] ?? "" }, set: { values[id] = $0 })
    }
}

/// The brain's several questions in one card, one at a time, as the web's QuestionPanel: its suggestions
/// (the confident ones chosen in advance), a box for another answer, a short review, then one send.
struct FieldQuestionCard: View {
    let question: ChatQuestion
    let busy: Bool
    let onSubmit: ([ChatFieldAnswer]) -> Void
    let onStop: (() -> Void)?
    private let fields: [ChatField]
    @State private var chosen: [Set<Int>]
    @State private var other: [String]
    @State private var step = 0

    init(question: ChatQuestion, busy: Bool, onSubmit: @escaping ([ChatFieldAnswer]) -> Void, onStop: (() -> Void)?) {
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
        onSubmit(fields.indices.map { ChatFieldAnswer(fieldId: fields[$0].id, value: current[$0]) })
    }
}

/// Photos waiting to go with the next message, above the composer.
struct AttachmentTray: View {
    @EnvironmentObject private var store: WaslaStore
    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(store.attachments) { item in
                    ZStack(alignment: .topLeading) {
                        PhotoThumb(data: item.preview).frame(width: 56, height: 56).clipShape(RoundedRectangle(cornerRadius: 10))
                        Button { store.removeAttachment(item.id) } label: {
                            Image(systemName: "xmark.circle.fill").font(.body).foregroundStyle(Color.white, Color.black.opacity(0.6))
                        }
                        .buttonStyle(.plain).padding(2)
                        .accessibilityLabel("إزالة الصورة")
                    }
                }
                if store.uploading { ProgressView().frame(width: 56, height: 56) }
            }
            .padding(.horizontal, 4)
        }
    }
}

/// The photos of a request still on its way.
struct AttachmentPreviews: View {
    let items: [ChatAttachment]
    var body: some View {
        HStack(spacing: 8) {
            ForEach(items) { item in PhotoThumb(data: item.preview).frame(width: 72, height: 72).clipShape(RoundedRectangle(cornerRadius: 12)) }
            Spacer(minLength: 0)
        }
    }
}

struct PhotoThumb: View {
    let data: Data
    var body: some View {
        if let image = UIImage(data: data) {
            Image(uiImage: image).resizable().scaledToFill()
        } else {
            Forest.soft.overlay { Image(systemName: "photo").foregroundStyle(Forest.faint) }
        }
    }
}

/// The photos attached to a message the owner sent, read from the server with the session.
struct MessageImages: View {
    @EnvironmentObject private var store: WaslaStore
    let refs: [ChatImageRef]
    var body: some View {
        HStack(spacing: 8) {
            ForEach(refs) { ref in
                Group {
                    if let image = store.images[ref.id] {
                        Image(uiImage: image).resizable().scaledToFill()
                    } else {
                        Forest.soft.overlay { ProgressView() }
                    }
                }
                .frame(width: 96, height: 96)
                .clipShape(RoundedRectangle(cornerRadius: 12))
                .task { await store.loadImage(ref.id) }
                .accessibilityLabel("صورة مرفقة")
            }
            Spacer(minLength: 0)
        }
    }
}

/// The page the brain's browser is on, on the server; a tap shows its latest screenshot.
struct BrowserLine: View {
    let browser: ChatBrowser
    let open: () -> Void
    var body: some View {
        Button(action: open) {
            HStack(spacing: 10) {
                Image(systemName: "globe").foregroundStyle(Forest.accent)
                VStack(alignment: .leading, spacing: 2) {
                    Text(browser.title.isEmpty ? browser.host : browser.title).font(.subheadline).lineLimit(1)
                    Text(browser.host).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                }
                Spacer(minLength: 4)
                if browser.live {
                    Text("مباشر").font(.caption2.weight(.semibold)).padding(.horizontal, 8).padding(.vertical, 3)
                        .background(Forest.accentSoft, in: Capsule()).foregroundStyle(Forest.accent)
                }
                Image(systemName: "chevron.left").font(.caption).foregroundStyle(Forest.faint)
            }
            .padding(.vertical, 9).padding(.horizontal, 12)
            .background(Forest.surface, in: RoundedRectangle(cornerRadius: 12))
            .overlay(RoundedRectangle(cornerRadius: 12).stroke(Forest.line))
        }
        .buttonStyle(.plain)
        .accessibilityLabel("شاشة المتصفح: \(browser.title)")
    }
}

struct BrowserScreenView: View {
    @EnvironmentObject private var store: WaslaStore
    @Environment(\.dismiss) private var dismiss
    @State private var image: UIImage?
    @State private var loading = true
    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 12) {
                    if let image {
                        Image(uiImage: image).resizable().scaledToFit().clipShape(RoundedRectangle(cornerRadius: 12))
                            .accessibilityLabel("صورة من متصفح موحسن")
                    } else if loading {
                        ProgressView().frame(maxWidth: .infinity, minHeight: 200)
                    } else {
                        ContentUnavailableView("لا توجد صورة الآن", systemImage: "globe", description: Text("تظهر هنا شاشة المتصفح حين يعمل موحسن على صفحة."))
                    }
                    if let browser = store.conversation?.browser {
                        Text(browser.url).font(.caption).foregroundStyle(.secondary).textSelection(.enabled).environment(\.layoutDirection, .leftToRight)
                    }
                }
                .padding(16)
            }
            .background(Forest.background)
            .navigationTitle("شاشة المتصفح").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("تم") { dismiss() } } }
            .task {
                while !Task.isCancelled {
                    if let fresh = await store.browserScreen() { image = fresh }
                    loading = false
                    guard store.conversation?.working == true else { return }
                    try? await Task.sleep(for: .seconds(2))
                }
            }
        }
        .environment(\.layoutDirection, .rightToLeft)
    }
}

struct ConversationListView: View {
    @EnvironmentObject private var store: WaslaStore
    @Environment(\.dismiss) private var dismiss
    @State private var deleting: ChatSummary?
    var body: some View {
        NavigationStack {
            List {
                if store.chatList.isEmpty { Text("لا توجد محادثات بعد.").foregroundStyle(.secondary) }
                ForEach(store.chatList) { item in
                    Button {
                        let id = item.id
                        dismiss()
                        Task { await store.openConversation(id) }
                    } label: {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(item.title.isEmpty ? "محادثة" : item.title).foregroundStyle(Forest.ink)
                            Text(ChatStatus.title(item.status)).font(.caption).foregroundStyle(.secondary)
                        }
                    }
                    .disabled(store.sending)
                    .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                        Button { deleting = item } label: { Label("حذف", systemImage: "trash") }.tint(Forest.alert)
                    }
                }
            }
            .navigationTitle("محادثاتك").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("تم") { dismiss() } } }
            .refreshable { await store.loadChatList() }
            .confirmationDialog("حذف هذه المحادثة؟", isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } }),
                                titleVisibility: .visible, presenting: deleting) { item in
                Button("حذف المحادثة", role: .destructive) { let id = item.id; Task { await store.deleteConversation(id) } }
            } message: { item in
                Text("«\(item.title.isEmpty ? "محادثة" : item.title)» تُحذف من موحسن على الخادم، ولا يمكن التراجع.")
            }
        }
        .environment(\.layoutDirection, .rightToLeft)
    }
}
