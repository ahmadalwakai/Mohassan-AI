import SwiftUI
import UIKit

/// The phone's whole state. It is a client of the cloud server, like the web: the server owns the conversations,
/// the brain, the request keys and the Windows grants; the phone shows them and sends the owner's taps.
@MainActor
final class WaslaStore: ObservableObject {
    enum Account: Equatable { case loading, signedOut, signedIn }

    // The account.
    @Published private(set) var account: Account = .loading
    @Published private(set) var email: String?
    @Published var signingIn = false
    @Published var errorMessage: String?
    @Published var foreground = true
    let origin = CloudDefaults.load()
    let pushNotifications = PushNotifications.shared
    private(set) var client: CloudClient?
    /// Bumped whenever the session changes; answers that belong to an older session are dropped.
    private(set) var sessionEpoch = 0

    // The chat. Logic in Mohassan.swift.
    @Published var chatList: [ChatSummary] = []
    @Published var pendingPushRoute: PushNotificationRoute?
    var visibleChatConversationID: String?
    @Published var conversation: ChatConversation?
    @Published var capabilities: ChatCapabilities?
    /// The server runs a resent request once when it carries the same key (`requestKeys` in the list).
    @Published var requestKeys = false
    @Published var draft = ""
    @Published var sending = false
    /// The one changing request whose outcome is not settled yet; nothing new is sent until it is.
    @Published var pending: PendingRequest?
    @Published var attachments: [ChatAttachment] = []
    @Published var uploading = false
    @Published var imagesAvailable = false
    @Published var secureBusy = false
    @Published var images: [String: UIImage] = [:]
    var watchTask: Task<Void, Never>?
    var watchID = 0
    var chatEpoch = 0

    // Windows remote control. Logic below.
    @Published private(set) var windows: WindowsOverview?
    @Published private(set) var windowsProblem: String?
    @Published private(set) var remoteDeviceID: String?
    /// The owner's switch: while on and the app is open, this session keeps a control grant.
    @Published private(set) var remoteWanted = false
    @Published private(set) var remoteBusy = false
    @Published private(set) var remoteFrame: UIImage?
    @Published private(set) var remoteFrameAt: Date?
    @Published var remoteNote: String?
    @Published private(set) var pairing: WindowsPairing?
    private var remoteFrameID: String?
    private var remoteGrantID: String?
    private var remoteScreenShown = false
    private var renewTask: Task<Void, Never>?
    private var frameTask: Task<Void, Never>?
    private var pairingTask: Task<Void, Never>?

    private let defaults = UserDefaults.standard
    private let emailKey = "mohassan.account.email"

    var signedIn: Bool { account == .signedIn }

    func start() async {
        defer { if !signedIn { pendingPushRoute = nil } }
        // The app's earlier version talked to the PC directly; its pairing and saved requests mean nothing now.
        await SessionVault.shared.forgetLegacyPairing()
        for key in ["wasla.server.identity", "wasla.pending.image", "wasla.last.image", "wasla.mohassan.request"] { defaults.removeObject(forKey: key) }
        do {
            guard let cookie = try await SessionVault.shared.read() else { account = .signedOut; return }
            let signedInClient = CloudClient(origin: origin, cookie: cookie)
            client = signedInClient
            email = defaults.string(forKey: emailKey)
            account = .signedIn
            pushNotifications.connect(signedInClient, email: email)
            restorePending()
            await loadChatList()
            guard signedIn else { return }
            resumePending()
            Task { await self.loadWindows() }
            Task { await self.checkImages() }
        } catch {
            account = .signedOut
            show(error)
        }
    }

    func signIn(email typed: String, password: String) async {
        let address = typed.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !signingIn, !address.isEmpty, !password.isEmpty else { return }
        signingIn = true
        defer { signingIn = false }
        do {
            let (cookie, reply) = try await CloudClient(origin: origin, cookie: nil).signIn(email: address, password: password)
            try await SessionVault.shared.save(cookie)
            sessionEpoch += 1
            let signedInClient = CloudClient(origin: origin, cookie: cookie)
            client = signedInClient
            let shown = reply.user?.email ?? address
            email = shown
            defaults.set(shown, forKey: emailKey)
            account = .signedIn
            pushNotifications.connect(signedInClient, email: email)
            await loadChatList()
            guard signedIn else { return }
            Task { await self.loadWindows() }
            Task { await self.checkImages() }
        } catch { show(error) }
    }

    /// Ends the session here and on the server; the server also ends this session's Windows grants.
    func signOut() async {
        let old = client
        let cleanup = pushNotifications.disconnect(unregister: true)
        endSession()
        await cleanup?.value
        await old?.signOut()
    }

    /// The server no longer knows this session (it expired, or was ended elsewhere).
    func signedOutByServer() {
        guard account == .signedIn else { return }
        pushNotifications.disconnect(unregister: false)
        endSession()
        errorMessage = WaslaError.signedOut.localizedDescription
    }

    private func endSession() {
        sessionEpoch += 1
        chatEpoch += 1
        stopWatching()
        stopRemoteTasks()
        pairingTask?.cancel(); pairingTask = nil
        client = nil
        account = .signedOut
        pendingPushRoute = nil; visibleChatConversationID = nil
        conversation = nil; chatList = []; capabilities = nil; requestKeys = false
        pending = nil; savePending(); sending = false; secureBusy = false
        attachments = []; uploading = false; images = [:]; draft = ""
        windows = nil; windowsProblem = nil; remoteWanted = false; remoteBusy = false; remoteDeviceID = nil
        remoteFrame = nil; remoteFrameAt = nil; remoteFrameID = nil; remoteGrantID = nil; remoteNote = nil; pairing = nil
        defaults.removeObject(forKey: emailKey)
        email = nil
        Task { try? await SessionVault.shared.delete() }
    }

    func sceneChanged(active: Bool) {
        foreground = active
        guard signedIn else { return }
        if active { pushNotifications.refreshSettings() }
        chatSceneChanged(active: active)
        remoteSceneChanged(active: active)
    }

    func show(_ error: Error) {
        if error is CancellationError { return }
        if let failure = error as? URLError {
            if failure.code == .cancelled { return }
            if [.notConnectedToInternet, .cannotFindHost, .cannotConnectToHost, .networkConnectionLost, .timedOut, .dnsLookupFailed].contains(failure.code) {
                errorMessage = "تعذّر الوصول إلى الخادم. تحقق من اتصال الهاتف بالإنترنت."
                return
            }
        }
        if let failure = error as? WaslaError, case .signedOut = failure { signedOutByServer(); return }
        errorMessage = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
    }
}

// MARK: - Windows remote control
// The PC's companion decides what may be seen and controlled (its local permission); this session asks the server for
// a short grant on top of it. On: a 120 s control grant, renewed while the switch is on and the app is open. Off: a
// 30 s view-only grant replaces it, so control ends at once and the PC's permission stays for next time. STOP ends
// everything on the PC, which then needs a new local permission.

extension WaslaStore {
    var remote: RemoteReadiness? { windows.map { RemoteReadiness.of($0, preferred: remoteDeviceID) } }

    func loadWindows() async {
        guard let client else { return }
        let epoch = sessionEpoch
        do {
            let overview: WindowsOverview = try await client.get("/api/windows", timeout: 15)
            guard epoch == sessionEpoch else { return }
            windows = overview
            windowsProblem = nil
            if let device = RemoteReadiness.device(in: overview, preferred: remoteDeviceID) { remoteDeviceID = device.id }
            if pairing != nil, overview.devices.contains(where: { !$0.revoked && $0.online }) { pairing = nil }
        } catch {
            guard epoch == sessionEpoch else { return }
            if let failure = error as? WaslaError {
                switch failure {
                case .signedOut: signedOutByServer(); return
                case .server(403, let message, _):
                    windows = nil
                    windowsProblem = message
                    return
                case .server(404, _, _):
                    windows = nil
                    windowsProblem = "هذا الخادم لا يعرف التحكم بـ Windows."
                    return
                default: break
                }
            }
            windowsProblem = (error as? LocalizedError)?.errorDescription ?? "تعذّر قراءة حالة الكمبيوتر."
        }
    }

    /// The owner's switch.
    func setRemote(_ on: Bool) {
        guard !remoteBusy, signedIn else { return }
        remoteNote = nil
        Task { if on { await self.turnRemoteOn() } else { await self.turnRemoteOff() } }
    }

    private func turnRemoteOn() async {
        guard let client else { return }
        remoteBusy = true
        defer { remoteBusy = false }
        await loadWindows()
        guard let overview = windows else { return }
        let readiness = RemoteReadiness.of(overview, preferred: remoteDeviceID)
        switch readiness {
        case .active(let device, _):
            remoteDeviceID = device.id
            remoteWanted = true
            keepRemoteGrant()
            startFrames()
        case .ready(let device):
            do {
                _ = try await requestGrant(device, scope: "control", seconds: 120, client: client)
                remoteDeviceID = device.id
                remoteWanted = true
                keepRemoteGrant()
                startFrames()
                await loadWindows()
            } catch { remoteFailed(error) }
        default:
            remoteWanted = false
            remoteNote = readiness.title + ". " + readiness.advice
        }
    }

    private func turnRemoteOff() async {
        remoteWanted = false
        stopRemoteTasks()
        remoteFrame = nil; remoteFrameID = nil; remoteGrantID = nil
        guard let client else { return }
        remoteBusy = true
        defer { remoteBusy = false }
        await loadWindows()
        guard let overview = windows, case .active(let device, _) = RemoteReadiness.of(overview, preferred: remoteDeviceID) else { return }
        // A short view-only grant replaces this session's control grant: input stops now.
        do {
            _ = try await requestGrant(device, scope: "view", seconds: 30, client: client)
            remoteNote = "أُلغي التحكم. تنتهي المشاهدة أيضًا خلال ٣٠ ثانية."
        } catch {
            remoteNote = "تعذّر إلغاء الإذن الآن؛ ينتهي وحده خلال دقيقتين. «إيقاف كامل» يوقفه فورًا."
        }
        await loadWindows()
    }

    /// STOP: ends every grant on the PC at once. The PC needs a new local permission afterwards.
    func stopRemoteCompletely() async {
        guard let client, let id = remoteDeviceID, UUID(uuidString: id) != nil else { return }
        remoteWanted = false
        stopRemoteTasks()
        remoteFrame = nil; remoteFrameID = nil; remoteGrantID = nil
        remoteBusy = true
        defer { remoteBusy = false }
        do {
            let _: OkReply = try await client.post("/api/windows/devices/\(id)/stop", body: EmptyBody(), timeout: 15)
            remoteNote = "أُوقف كل شيء على الكمبيوتر. للتحكم من جديد اسمح مرة أخرى في Mohassan Companion."
        } catch { show(error) }
        await loadWindows()
    }

    /// A one-use code (two minutes) to paste into Mohassan Companion on the PC.
    func pairWindows() async {
        guard let client, !remoteBusy else { return }
        remoteBusy = true
        defer { remoteBusy = false }
        do {
            let code: WindowsPairing = try await client.post("/api/windows/pairing", body: EmptyBody(), timeout: 15)
            pairing = code
            watchPairing()
        } catch { show(error) }
    }

    /// While a code is shown, looks every three seconds for the PC that used it.
    private func watchPairing() {
        pairingTask?.cancel()
        let epoch = sessionEpoch
        pairingTask = Task {
            while !Task.isCancelled, self.pairing != nil, epoch == self.sessionEpoch {
                do { try await Task.sleep(for: .seconds(3)) } catch { return }
                guard !Task.isCancelled, self.foreground else { continue }
                await self.loadWindows()
                if let pairing = self.pairing, let expiry = WindowsClock.date(pairing.expiresAt), expiry < Date() { self.pairing = nil }
            }
        }
    }

    private func requestGrant(_ device: WindowsDevice, scope: String, seconds: Int, client: CloudClient) async throws -> WindowsGrant {
        guard UUID(uuidString: device.id) != nil, let state = device.state, let target = state.target else {
            throw WaslaError.message("اختر نافذة واسمح بها في Mohassan Companion على الكمبيوتر أولًا.")
        }
        let body = WindowsGrantRequest(scope: scope, durationSeconds: seconds, targetKey: target.key, approvalNonce: state.approvalNonce)
        return try await client.post("/api/windows/devices/\(device.id)/grants", body: body, timeout: 15)
    }

    private func remoteFailed(_ error: Error) {
        remoteWanted = false
        stopRemoteTasks()
        if let failure = error as? WaslaError, case .signedOut = failure { signedOutByServer(); return }
        remoteNote = (error as? LocalizedError)?.errorDescription ?? "تعذّر تفعيل التحكم."
    }

    /// Keeps a control grant while the switch is on and the app is open: renews it when under 35 s remain, takes a
    /// new one when it lapsed while the app was away, and turns the switch off when the PC no longer allows it.
    private func keepRemoteGrant() {
        renewTask?.cancel()
        guard remoteWanted, foreground else { return }
        let epoch = sessionEpoch
        renewTask = Task {
            var first = true
            while !Task.isCancelled {
                if !first { do { try await Task.sleep(for: .seconds(15)) } catch { return } }
                first = false
                guard !Task.isCancelled, self.remoteWanted, self.foreground, epoch == self.sessionEpoch, let client = self.client else { return }
                await self.loadWindows()
                guard !Task.isCancelled, self.remoteWanted, let overview = self.windows else { continue }
                let readiness = RemoteReadiness.of(overview, preferred: self.remoteDeviceID)
                switch readiness {
                case .active(let device, let grant):
                    if let expiry = grant.expiry, expiry.timeIntervalSinceNow > 35 { continue }
                    do { _ = try await self.requestGrant(device, scope: "control", seconds: 120, client: client) } catch { self.remoteNote = (error as? LocalizedError)?.errorDescription }
                case .ready(let device):
                    do { _ = try await self.requestGrant(device, scope: "control", seconds: 120, client: client) } catch { self.remoteNote = (error as? LocalizedError)?.errorDescription }
                default:
                    self.remoteWanted = false
                    self.remoteNote = readiness.title + ". " + readiness.advice
                    self.frameTask?.cancel(); self.frameTask = nil
                    self.remoteFrame = nil; self.remoteFrameID = nil
                    return
                }
            }
        }
    }

    func remoteScreenOpened() {
        remoteScreenShown = true
        startFrames()
    }

    func remoteScreenClosed() {
        remoteScreenShown = false
        frameTask?.cancel(); frameTask = nil
    }

    /// Reads the PC's latest frame about once a second while the remote screen is open.
    private func startFrames() {
        frameTask?.cancel()
        guard remoteScreenShown, remoteWanted, foreground, let client, let id = remoteDeviceID, UUID(uuidString: id) != nil else { return }
        let epoch = sessionEpoch
        frameTask = Task {
            var misses = 0
            while !Task.isCancelled, self.remoteScreenShown, self.foreground, epoch == self.sessionEpoch {
                do {
                    let reply: WindowsFrameReply = try await client.get("/api/windows/devices/\(id)/frame", timeout: 10)
                    guard !Task.isCancelled, epoch == self.sessionEpoch else { return }
                    if let data = reply.frame.imageData, let image = UIImage(data: data) {
                        self.remoteFrame = image
                        self.remoteFrameID = reply.frame.id
                        self.remoteGrantID = reply.grant.id
                        self.remoteFrameAt = Date()
                        misses = 0
                    }
                } catch {
                    if Task.isCancelled { return }
                    if let failure = error as? WaslaError, case .signedOut = failure { self.signedOutByServer(); return }
                    misses += 1
                    if misses == 3 {
                        self.remoteFrame = nil
                        self.remoteFrameID = nil
                        self.remoteNote = "لا تصل صورة حديثة من الكمبيوتر الآن."
                    }
                }
                do { try await Task.sleep(for: .milliseconds(900)) } catch { return }
            }
        }
    }

    /// One input on the allowed window, tied to the frame on screen. The server refuses it when that frame is stale.
    func remoteAct(_ action: WindowsAction) {
        guard remoteWanted, let client, let id = remoteDeviceID, UUID(uuidString: id) != nil,
              let frameID = remoteFrameID, let grantID = remoteGrantID else {
            remoteNote = "انتظر صورة حديثة من الكمبيوتر قبل الإدخال."
            return
        }
        if case .text(let value) = action, !WindowsAction.textFits(value) {
            remoteNote = "النص من حرف إلى ١٢٠ حرفًا، دون أسطر جديدة."
            return
        }
        let epoch = sessionEpoch
        let request = WindowsActionRequest(grantId: grantID, nonce: UUID().uuidString.lowercased(), frameId: frameID, action: action)
        Task {
            do {
                let _: WindowsActionReply = try await client.post("/api/windows/devices/\(id)/actions", body: request, timeout: 10)
            } catch {
                guard epoch == self.sessionEpoch else { return }
                if let failure = error as? WaslaError, case .server(_, let message, let code) = failure,
                   code == "WINDOWS_FRESH_SCREEN_REQUIRED" || code == "WINDOWS_CONTROL_DENIED" {
                    self.remoteNote = message
                    return
                }
                self.show(error)
            }
        }
    }

    func remoteSceneChanged(active: Bool) {
        if active {
            Task {
                await self.loadWindows()
                if self.remoteWanted {
                    self.keepRemoteGrant()
                    self.startFrames()
                }
                if self.pairing != nil { self.watchPairing() }
            }
        } else {
            // Away from the app nothing is renewed: the grant lapses within two minutes.
            stopRemoteTasks()
            pairingTask?.cancel(); pairingTask = nil
        }
    }

    func stopRemoteTasks() {
        renewTask?.cancel(); renewTask = nil
        frameTask?.cancel(); frameTask = nil
    }
}
