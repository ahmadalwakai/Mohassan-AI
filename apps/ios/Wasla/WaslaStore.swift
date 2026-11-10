import SwiftUI
import UIKit

@MainActor
final class WaslaStore: ObservableObject {
    @Published private(set) var identity: ServerIdentity?
    @Published private(set) var status: ServerStatus?
    @Published var errorMessage: String?
    @Published var isLoading = true
    @Published var isPairing = false
    @Published var isRefreshing = false
    @Published var selectedTab = 0
    @Published var messages: [ChatMessage] = []
    @Published var chatBusy = false
    @Published var chatContextNote = ""
    @Published var chatMode = ChatMode.automatic
    @Published var rememberConversation = false
    @Published var useSavedKnowledge = false
    @Published private(set) var chatMetadata: [UUID: ChatResponse] = [:]
    @Published var imagePreparing = false
    @Published var preparedImage: PreparedImage?
    @Published var imageBusy = false
    @Published private(set) var imageSubmitting = false
    @Published var imageStatus = "صف الصورة، ثم راجع الوصف قبل بدء الإنشاء."
    @Published var pendingImageID: String?
    @Published var lastImage: UIImage?
    @Published var searchBusy = false
    @Published var searchResponse: SearchResponse?
    @Published var desktopStarting = false
    @Published var desktopSession: DesktopSession?
    @Published var desktopFrame: UIImage?
    @Published var frameTime: Date?
    @Published var pointer = CGPoint(x: 0.5, y: 0.5)
    @Published var desktopMessage = "ابدأ جلسة لعرض الشاشة والتحكم بها."
    @Published var foreground = true
    // Mohassan, through the computer service. Logic lives in Mohassan.swift.
    @Published var mohassanLink: MohassanLink?
    @Published var mohassanList: [MohassanSummary] = []
    @Published var mohassanConversation: MohassanConversation?
    @Published var mohassanSending = false
    @Published var mohassanPendingText: String?
    var mohassanPollTask: Task<Void, Never>?
    var mohassanPollID = 0
    var mohassanEpoch = 0

    private(set) var client: APIClient?
    private var frameTask: Task<Void, Never>?
    private var inputTask: Task<Void, Never>?
    private var imageTask: Task<Void, Never>?
    private var chatTask: Task<Void, Never>?
    private var inputQueue: [DesktopCommand] = []
    private var desktopEpoch = 0
    private(set) var sessionEpoch = 0
    private var chatEpoch = 0
    private var chatConversationID: String?
    private let defaults = UserDefaults.standard
    private let identityKey = "wasla.server.identity"
    private let pendingKey = "wasla.pending.image"
    private let lastImageKey = "wasla.last.image"
    let bundledIdentity = BundledConnection.load()

    var paired: Bool { identity != nil && client != nil }
    var computerBusy: Bool { chatBusy || imagePreparing || imageBusy || imageSubmitting || mohassanBusy || status?.busy.isBusy == true }
    var connected: Bool { paired && status != nil }

    func start() async {
        defer { isLoading = false }
        do {
            guard let data = defaults.data(forKey: identityKey), let saved = try? JSONDecoder().decode(ServerIdentity.self, from: data) else { return }
            let checked = try ServerIdentity.validate(address: saved.baseURL.absoluteString, fingerprint: saved.fingerprint, deviceID: saved.deviceID, name: saved.name)
            guard let token = try await TokenVault.shared.read(), Self.validToken(token) else { return }
            identity = checked
            client = APIClient(identity: checked, token: token)
            if let id = defaults.string(forKey: pendingKey), UUID(uuidString: id) != nil {
                pendingImageID = id
                imageStatus = "يوجد طلب سابق. استعد حالته دون إعادة إرساله."
            }
            await refreshStatus()
            if pendingImageID != nil { resumeImage() }
            else if let id = defaults.string(forKey: lastImageKey), UUID(uuidString: id) != nil, let client {
                do { lastImage = try await loadImage(id: id, client: client) }
                catch { imageStatus = "تعذّر تحميل الصورة السابقة. يمكنك إنشاء طلب جديد." }
            }
        } catch { show(error) }
    }
    static func validToken(_ token: String) -> Bool {
        token.utf8.count >= 32 && token.utf8.count <= 4096 && !token.unicodeScalars.contains { CharacterSet.whitespacesAndNewlines.union(.controlCharacters).contains($0) }
    }
    func pair(address: String, fingerprint: String, code: String) async {
        guard !isPairing else { return }
        isPairing = true
        defer { isPairing = false }
        do {
            let checked = try ServerIdentity.validate(address: address, fingerprint: fingerprint)
            let pairingCode = PairingCode.normalized(code)
            guard PairingCode.isValid(pairingCode) else { throw WaslaError.invalidPairingCode }
            let deviceName = String(UIDevice.current.name.trimmingCharacters(in: .whitespacesAndNewlines).prefix(60))
            let pairing = APIClient(identity: checked)
            let response: PairResponse = try await pairing.post("/v1/pair", body: PairRequest(code: pairingCode, device_name: deviceName.isEmpty ? "iPhone" : deviceName))
            guard Self.validToken(response.token) else { throw WaslaError.invalidResponse }
            let saved = ServerIdentity(baseURL: checked.baseURL, fingerprint: checked.fingerprint, deviceID: response.device_id, name: response.name)
            let authenticated = APIClient(identity: saved, token: response.token)
            do { try await TokenVault.shared.save(response.token) }
            catch { try? await authenticated.delete("/v1/session"); throw error }
            defaults.set(try JSONEncoder().encode(saved), forKey: identityKey)
            identity = saved; client = authenticated
            await refreshStatus()
        } catch { show(error) }
    }
    func refreshStatus() async {
        guard let client, !isRefreshing else { return }
        let epoch = sessionEpoch
        isRefreshing = true
        defer { isRefreshing = false }
        do {
            let fresh: ServerStatus = try await client.get("/v1/status")
            guard epoch == sessionEpoch else { return }
            status = fresh
            await refreshMohassanLink()
        } catch {
            guard epoch == sessionEpoch else { return }
            status = nil
            show(error)
        }
    }
    func revokePairing() async {
        guard let client else { return }
        stopDesktop()
        do { try await client.delete("/v1/session"); try await clearPairing() }
        catch { show(error) }
    }
    func forgetPairing() async {
        do { try await clearPairing() } catch { show(error) }
    }
    private func clearPairing() async throws {
        stopDesktop()
        chatTask?.cancel(); imageTask?.cancel()
        sessionEpoch += 1
        try await TokenVault.shared.delete()
        defaults.removeObject(forKey: identityKey)
        defaults.removeObject(forKey: pendingKey)
        defaults.removeObject(forKey: lastImageKey)
        client = nil; identity = nil; status = nil
        messages = []; chatContextNote = ""; pendingImageID = nil; lastImage = nil; preparedImage = nil; searchResponse = nil
        chatMetadata = [:]; chatConversationID = nil; chatEpoch += 1
        rememberConversation = false; useSavedKnowledge = false; chatMode = .automatic
        imageBusy = false; imageSubmitting = false; imagePreparing = false; chatBusy = false; selectedTab = 0
        resetMohassan()
    }
    func newChat() {
        chatEpoch += 1
        chatTask?.cancel(); chatTask = nil
        messages = []; chatMetadata = [:]; chatConversationID = nil; chatContextNote = ""; chatBusy = false
        rememberConversation = false; useSavedKnowledge = false; chatMode = .automatic
    }
    @discardableResult
    func sendChat(_ text: String) -> Bool {
        guard let client else { show(WaslaError.notPaired); return false }
        guard !computerBusy else { errorMessage = "المساعد مشغول حاليًا. انتظر انتهاء المهمة قبل إرسال رسالة أخرى."; return false }
        let clean = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !clean.isEmpty else { return false }
        guard clean.unicodeScalars.count <= 8_000 else { errorMessage = "الرسالة تتجاوز ٨٬٠٠٠ حرف. اختصرها قبل الإرسال."; return false }
        let message = ChatMessage(role: "user", content: clean)
        messages.append(message)
        var history = messages
        // Python counts Unicode code points; unicodeScalars uses the same bound, even
        // for Arabic combining marks. Trim only old context; preserve the new message.
        while history.count > 1 && (history.count > 16 || history.reduce(0, { $0 + $1.content.unicodeScalars.count }) > 24_000 || history.contains(where: { $0.content.unicodeScalars.count > 8_000 })) {
            history.removeFirst()
        }
        chatContextNote = history.count < messages.count ? "أُرسل أحدث جزء من المحادثة ضمن حدود النموذج: \(history.count) رسالة." : ""
        let requestHistory = history
        let request = ChatRequest(messages: requestHistory, request_id: UUID().uuidString.lowercased(), mode: chatMode.rawValue, remember: rememberConversation, use_memory: useSavedKnowledge, conversation_id: rememberConversation ? chatConversationID : nil)
        let epoch = sessionEpoch
        let conversationEpoch = chatEpoch
        chatBusy = true
        chatTask = Task { [weak self] in
            guard let self else { return }
            defer { if epoch == self.sessionEpoch, conversationEpoch == self.chatEpoch { self.chatBusy = false; self.chatTask = nil } }
            do {
                let answer: ChatResponse = try await client.post("/v1/chat", body: request, timeout: 210)
                guard !Task.isCancelled, epoch == self.sessionEpoch, conversationEpoch == self.chatEpoch else { return }
                let reply = ChatMessage(role: "assistant", content: answer.content)
                self.chatMetadata[reply.id] = answer
                self.messages.append(reply)
                self.chatConversationID = answer.memory_saved == true ? answer.conversation_id : nil
                await self.refreshStatus()
            } catch {
                if !Task.isCancelled, epoch == self.sessionEpoch, conversationEpoch == self.chatEpoch { self.show(error) }
            }
        }
        return true
    }
    func prepareImage(description: String, style: String) async {
        guard let client, !computerBusy, pendingImageID == nil else { return }
        let clean = description.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !clean.isEmpty else { return }
        imagePreparing = true
        let epoch = sessionEpoch
        defer { imagePreparing = false }
        do {
            let prepared: PreparedImage = try await client.post("/v1/images/prepare", body: ImagePreparation(description: clean, style: style), timeout: 210)
            guard epoch == sessionEpoch else { return }
            preparedImage = prepared
        } catch { if epoch == sessionEpoch { show(error) } }
    }
    func generateImage(_ prepared: PreparedImage) async {
        guard let client, !imageBusy, pendingImageID == nil else { return }
        preparedImage = nil
        let id = UUID().uuidString.lowercased()
        let request = ImageRequest(prompt: prepared.prompt, negative_prompt: prepared.negative_prompt, seed: prepared.seed, request_id: id)
        pendingImageID = id
        defaults.set(id, forKey: pendingKey)
        imageBusy = true
        imageSubmitting = true
        imageStatus = "جارٍ إرسال الطلب…"
        let epoch = sessionEpoch
        do {
            let _: ImageJob = try await client.post("/v1/images", body: request)
            guard epoch == sessionEpoch else { return }
            imageSubmitting = false
            resumeImage()
        } catch {
            guard epoch == sessionEpoch else { return }
            imageSubmitting = false
            imageBusy = false
            // A lost response is not proof that generation never started. Do not POST again.
            imageStatus = "لم يتأكد استلام الطلب. تحقّق من حالته؛ لن يُعاد إرساله تلقائيًا."
            show(error)
        }
    }
    func resumeImage() {
        guard !imageSubmitting, let id = pendingImageID, UUID(uuidString: id) != nil, let client, foreground else { return }
        imageTask?.cancel()
        imageBusy = true
        let epoch = sessionEpoch
        imageTask = Task { [weak self] in
            guard let self else { return }
            do {
                while !Task.isCancelled {
                    let job: ImageJob = try await client.get("/v1/images/\(id)")
                    guard !Task.isCancelled, epoch == self.sessionEpoch else { return }
                    switch job.status {
                    case "queued": self.imageStatus = "الطلب في الانتظار."
                    case "running": self.imageStatus = "الجهاز ينشئ الصورة. ستعود المحادثة بعد اكتمالها."
                    case "completed":
                        let image = try await self.loadImage(id: id, client: client)
                        guard !Task.isCancelled, epoch == self.sessionEpoch else { return }
                        self.lastImage = image
                        self.defaults.set(id, forKey: self.lastImageKey)
                        self.finishImage("اكتمل إنشاء الصورة على الكمبيوتر.")
                        await self.refreshStatus()
                        return
                    case "failed":
                        self.finishImage("فشل الطلب. لم تتم إعادة المحاولة تلقائيًا.")
                        self.errorMessage = job.error ?? "تعذّر إنشاء الصورة."
                        await self.refreshStatus()
                        return
                    default: throw WaslaError.invalidResponse
                    }
                    try await Task.sleep(for: .seconds(2))
                }
            } catch {
                guard !Task.isCancelled, epoch == self.sessionEpoch else { return }
                self.imageBusy = false
                if let failure = error as? WaslaError, case .server(404, _) = failure {
                    self.finishImage("الكمبيوتر لا يعرف هذا الطلب. لم نُعِد إرساله. يمكنك إنشاء طلب جديد.")
                } else {
                    self.imageStatus = "توقفت متابعة الطلب. تحقّق من حالته عند عودة الاتصال."
                    self.show(error)
                }
            }
        }
    }
    private func finishImage(_ message: String) {
        imageBusy = false; pendingImageID = nil; imageStatus = message
        defaults.removeObject(forKey: pendingKey)
    }
    private func loadImage(id: String, client: APIClient) async throws -> UIImage {
        guard UUID(uuidString: id) != nil else { throw WaslaError.invalidResponse }
        let data = try await client.data(path: "/v1/images/\(id)/content")
        guard let image = UIImage(data: data) else { throw WaslaError.invalidResponse }
        return image
    }
    func search(_ text: String) async {
        guard let client, !searchBusy else { return }
        let query = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !query.isEmpty else { return }
        let epoch = sessionEpoch
        searchBusy = true
        defer { searchBusy = false }
        do {
            let result: SearchResponse = try await client.post("/v1/search", body: SearchRequest(query: query))
            guard epoch == sessionEpoch else { return }
            searchResponse = result
        } catch { if epoch == sessionEpoch { show(error) } }
    }
    func startDesktop() async {
        guard let client, foreground, !desktopStarting, desktopSession == nil else { return }
        guard status?.desktop_enabled == true else { errorMessage = "فعّل التحكم بسطح المكتب من الكمبيوتر أولًا."; return }
        desktopStarting = true
        desktopEpoch += 1
        let epoch = desktopEpoch
        defer { desktopStarting = false }
        do {
            let opened: DesktopSession = try await client.post("/v1/desktop/session", body: EmptyBody(), timeout: 10)
            guard foreground, epoch == desktopEpoch else { try? await client.delete("/v1/desktop/session", desktopSession: opened.session_id); return }
            // Synchronize the real pointer before controls can be displayed or clicked.
            do {
                let _: EmptyResponse = try await client.post("/v1/desktop/input", body: DesktopCommand(action: "move", x: Double(pointer.x), y: Double(pointer.y)), desktopSession: opened.session_id, timeout: 10)
            } catch {
                try? await client.delete("/v1/desktop/session", desktopSession: opened.session_id)
                throw error
            }
            guard foreground, epoch == desktopEpoch else { try? await client.delete("/v1/desktop/session", desktopSession: opened.session_id); return }
            desktopSession = opened
            desktopMessage = "جارٍ تحميل الشاشة…"
            frameTask = Task { [weak self] in
                guard let self else { return }
                var busyRetries = 0
                do {
                    while !Task.isCancelled, self.foreground, epoch == self.desktopEpoch {
                        guard Date().timeIntervalSince1970 < opened.expires_at else { throw WaslaError.message("انتهت جلسة التحكم. ابدأ جلسة جديدة عند الحاجة.") }
                        let data: Data
                        do {
                            data = try await client.data(path: "/v1/desktop/frame", desktopSession: opened.session_id, timeout: 10)
                            busyRetries = 0
                        } catch let failure as WaslaError {
                            if case .server(429, _) = failure, busyRetries < 12 {
                                busyRetries += 1
                                self.desktopMessage = "عرض الشاشة ينتظر اكتمال الإدخال…"
                                try await Task.sleep(for: .milliseconds(min(2_000, busyRetries * 250)))
                                continue
                            }
                            throw failure
                        }
                        guard !Task.isCancelled, epoch == self.desktopEpoch else { return }
                        guard let image = UIImage(data: data) else { throw WaslaError.invalidResponse }
                        self.desktopFrame = image; self.frameTime = Date()
                        self.desktopMessage = "جلسة تحكم نشطة"
                        try await Task.sleep(for: .milliseconds(500))
                    }
                } catch {
                    guard !Task.isCancelled, epoch == self.desktopEpoch else { return }
                    self.stopDesktop()
                    self.desktopMessage = "توقف عرض الشاشة."
                    self.show(error)
                }
            }
        } catch { if epoch == desktopEpoch { show(error) } }
    }
    func stopDesktop() {
        desktopEpoch += 1
        let endingEpoch = desktopEpoch
        frameTask?.cancel(); frameTask = nil
        inputTask?.cancel(); inputTask = nil
        inputQueue.removeAll()
        let oldSession = desktopSession
        desktopSession = nil; desktopFrame = nil; frameTime = nil
        desktopMessage = "انتهت جلسة التحكم."
        if let oldSession, let client {
            Task {
                do { try await client.delete("/v1/desktop/session", desktopSession: oldSession.session_id) }
                catch {
                    if endingEpoch == self.desktopEpoch, self.desktopSession == nil {
                        self.desktopMessage = "توقف التحكم على الهاتف؛ لم يتأكد إنهاء الجلسة على الكمبيوتر. تنتهي الجلسة تلقائيًا."
                    }
                }
            }
        }
    }
    func movePointer(dx: CGFloat, dy: CGFloat) {
        pointer.x = min(1, max(0, pointer.x + dx))
        pointer.y = min(1, max(0, pointer.y + dy))
        enqueue(DesktopCommand(action: "move", x: Double(pointer.x), y: Double(pointer.y)))
    }
    func enqueue(_ command: DesktopCommand) {
        guard foreground, let active = desktopSession, let client else { return }
        if command.action == "move", inputQueue.last?.action == "move" { inputQueue[inputQueue.count - 1] = command }
        else if inputQueue.count < 30 { inputQueue.append(command) }
        guard inputTask == nil else { return }
        let epoch = desktopEpoch
        inputTask = Task { [weak self] in
            guard let self else { return }
            defer { if epoch == self.desktopEpoch { self.inputTask = nil } }
            do {
                while !Task.isCancelled, self.foreground, epoch == self.desktopEpoch, !self.inputQueue.isEmpty {
                    let item = self.inputQueue.removeFirst()
                    let _: EmptyResponse = try await client.post("/v1/desktop/input", body: item, desktopSession: active.session_id, timeout: 10)
                    // Pace the entire command stream to at most ten requests/second.
                    try await Task.sleep(for: .milliseconds(100))
                }
            } catch {
                guard !Task.isCancelled, epoch == self.desktopEpoch else { return }
                self.stopDesktop(); self.show(error)
            }
        }
    }
    func sceneChanged(active: Bool) {
        foreground = active
        mohassanSceneChanged(active: active)
        if !active {
            stopDesktop()
            imageTask?.cancel(); imageTask = nil
            if pendingImageID != nil { imageBusy = false; imageStatus = "سنتابع حالة الطلب عند عودتك؛ لن نعيد إنشاؤه." }
        } else {
            Task { await refreshStatus() }
            if pendingImageID != nil { resumeImage() }
        }
    }
    func show(_ error: Error) {
        if error is CancellationError { return }
        if let urlError = error as? URLError, urlError.code == .cancelled { return }
        if let urlError = error as? URLError, [.serverCertificateUntrusted, .serverCertificateHasBadDate, .serverCertificateNotYetValid, .serverCertificateHasUnknownRoot, .secureConnectionFailed].contains(urlError.code) {
            errorMessage = WaslaError.certificate.localizedDescription
        } else if let urlError = error as? URLError, [.notConnectedToInternet, .cannotFindHost, .cannotConnectToHost, .networkConnectionLost, .timedOut, .dnsLookupFailed].contains(urlError.code) {
            errorMessage = "تعذّر الوصول إلى الكمبيوتر. شغّل وصلة وTailscale على الكمبيوتر، وتأكد من اتصال Tailscale على الهاتف."
        } else { errorMessage = error.localizedDescription }
    }
}
