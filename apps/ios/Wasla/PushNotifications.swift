import SwiftUI
import UIKit
import UserNotifications

@MainActor
final class PushNotifications: ObservableObject {
    static let shared = PushNotifications()

    @Published private(set) var enabled: Bool
    @Published private(set) var settings: UNNotificationSettings?
    @Published private(set) var requestingPermission = false
    @Published private(set) var problem: String?

    private struct Session {
        let client: CloudClient
        let account: String
    }

    private static let enabledKey = "mohassan.push.enabled"
    private static let cleanupKey = "mohassan.push.tokensForRemoval"
    private let defaults = UserDefaults.standard
    private let center = UNUserNotificationCenter.current()
    private weak var store: WaslaStore?
    private var launchRoute: PushNotificationRoute?
    private var session: Session?
    private var deviceToken: String?
    private var registeredToken: String?
    private var operation: Task<Void, Never>?

    private init() {
        enabled = UserDefaults.standard.bool(forKey: Self.enabledKey)
    }

    var systemAllowsNotifications: Bool {
        guard let settings else { return false }
        switch settings.authorizationStatus {
        case .authorized, .provisional, .ephemeral: return true
        default: return false
        }
    }

    func attach(to store: WaslaStore) {
        self.store = store
        if let launchRoute {
            self.launchRoute = nil
            open(launchRoute)
        }
    }

    func connect(_ client: CloudClient, email: String?) {
        session = Session(client: client, account: email?.lowercased() ?? "")
        refreshSettings()
    }

    @discardableResult
    func disconnect(unregister: Bool) -> Task<Void, Never>? {
        let old = session
        session = nil
        stopRemoteDelivery()
        launchRoute = nil
        problem = nil
        guard unregister, let old else { return nil }
        return enqueue {
            _ = await self.removeTokens(for: old)
        }
    }

    func refreshSettings() {
        Task {
            let updated = await center.notificationSettings()
            guard !requestingPermission else { return }
            settings = updated
            applySettings()
        }
    }

    func setEnabled(_ value: Bool) {
        guard let current = session, !requestingPermission, value != enabled else { return }
        problem = nil
        if !value {
            saveEnabled(false)
            stopRemoteDelivery()
            _ = enqueue {
                let removed = await self.removeTokens(for: current)
                guard self.session?.client === current.client else { return }
                self.registeredToken = nil
                if removed, !self.enabled { self.problem = nil }
            }
            return
        }

        requestingPermission = true
        Task {
            defer { requestingPermission = false }
            do {
                let status = await center.notificationSettings().authorizationStatus
                guard session?.client === current.client else { return }
                if status == .notDetermined {
                    _ = try await center.requestAuthorization(options: [.alert, .sound, .badge])
                }
                let updated = await center.notificationSettings()
                guard session?.client === current.client else { return }
                settings = updated
                saveEnabled(systemAllowsNotifications)
                applySettings()
            } catch {
                if session?.client === current.client { problem = "تعذّر طلب إذن الإشعارات." }
            }
        }
    }

    func receivedDeviceToken(_ data: Data) {
        guard session != nil, enabled, systemAllowsNotifications, !data.isEmpty else { return }
        deviceToken = PushDeviceRegistration.hexToken(data)
        scheduleSync()
    }

    func deviceRegistrationFailed() {
        guard session != nil, enabled, systemAllowsNotifications, deviceToken == nil else { return }
        problem = "تعذّر تسجيل الهاتف للإشعارات. ستُعاد المحاولة عند فتح التطبيق."
    }

    func foregroundOptions(for route: PushNotificationRoute) -> UNNotificationPresentationOptions {
        guard let store, store.signedIn, enabled else { return [] }
        let visibleID = store.foreground ? store.visibleChatConversationID : nil
        if !route.showsForegroundBanner(notificationsEnabled: enabled, visibleConversationID: visibleID) {
            Task { await store.refreshVisiblePushConversation(route) }
            return []
        }
        if settings?.soundSetting == .disabled { return [.banner, .list] }
        return [.banner, .list, .sound]
    }

    func open(_ route: PushNotificationRoute) {
        guard enabled else { return }
        guard let store else {
            launchRoute = route
            return
        }
        guard store.account != .signedOut else { return }
        store.pendingPushRoute = route
    }

    private func saveEnabled(_ value: Bool) {
        enabled = value
        defaults.set(value, forKey: Self.enabledKey)
    }

    private func applySettings() {
        guard session != nil else { return }
        if enabled, systemAllowsNotifications {
            if deviceToken == nil { UIApplication.shared.registerForRemoteNotifications() }
        } else if deviceToken != nil || registeredToken != nil {
            stopRemoteDelivery()
        }
        scheduleSync()
    }

    private func stopRemoteDelivery() {
        UIApplication.shared.unregisterForRemoteNotifications()
        center.removeAllDeliveredNotifications()
        deviceToken = nil
        registeredToken = nil
    }

    // Serialize POST and DELETE, including across sign-out and token rotation.
    private func enqueue(_ work: @escaping @MainActor () async -> Void) -> Task<Void, Never> {
        let previous = operation
        let next = Task {
            await previous?.value
            await work()
        }
        operation = next
        return next
    }

    private func scheduleSync() {
        _ = enqueue { await self.synchronize() }
    }

    private func synchronize() async {
        guard let session else { return }
        if !enabled || !systemAllowsNotifications {
            if await removeTokens(for: session), self.session?.client === session.client, !enabled {
                problem = nil
            }
            return
        }
        guard let token = deviceToken else { return }

        if registeredToken != token {
            do {
                let registration = PushDeviceRegistration(
                    token: token,
                    environment: .current,
                    appVersion: Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "1.0"
                )
                // Track the token before POST. A lost response can still mean the server registered it.
                track(token, for: session, removing: false)
                let body = try JSONEncoder().encode(registration)
                let reply = try await session.client.send("/api/push/devices", method: "POST", body: body, timeout: 8)
                guard reply.response.statusCode == 204 else { throw WaslaError.invalidResponse }
            } catch {
                if isCurrent(token, for: session) {
                    problem = "تعذّر تسجيل الإشعارات لدى الخادم. ستُعاد المحاولة عند فتح التطبيق."
                }
                return
            }
            guard isCurrent(token, for: session) else { return }
            registeredToken = token
        }
        if await removeTokens(for: session, except: token), isCurrent(token, for: session) {
            problem = nil
        }
    }

    private func isCurrent(_ token: String, for session: Session) -> Bool {
        self.session?.client === session.client && enabled && systemAllowsNotifications && deviceToken == token
    }

    // Tokens kept on disk are for DELETE only. Registration always uses the latest APNs callback.
    private var trackedTokens: [String: [String]] {
        defaults.dictionary(forKey: Self.cleanupKey) as? [String: [String]] ?? [:]
    }

    private func track(_ token: String, for session: Session, removing: Bool) {
        var accounts = trackedTokens
        var tokens = Set(accounts[session.account] ?? [])
        if removing { tokens.remove(token) } else { tokens.insert(token) }
        accounts[session.account] = tokens.isEmpty ? nil : tokens.sorted()
        defaults.set(accounts, forKey: Self.cleanupKey)
    }

    private func removeTokens(for session: Session, except current: String? = nil) async -> Bool {
        var removed = true
        for token in trackedTokens[session.account] ?? [] where token != current {
            do {
                let reply = try await session.client.send("/api/push/devices/\(token)", method: "DELETE", timeout: 8)
                guard reply.response.statusCode == 204 else { throw WaslaError.invalidResponse }
                track(token, for: session, removing: true)
            } catch {
                removed = false
                if self.session?.client === session.client {
                    problem = "تعذّر إلغاء تسجيل الهاتف لدى الخادم. ستُعاد المحاولة عند فتح التطبيق."
                }
            }
        }
        return removed
    }
}

@MainActor
final class PushNotificationDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    func application(_ application: UIApplication, didFinishLaunchingWithOptions options: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        return true
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken token: Data) {
        PushNotifications.shared.receivedDeviceToken(token)
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        PushNotifications.shared.deviceRegistrationFailed()
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        guard let route = PushNotificationRoute.decode(notification.request.content.userInfo) else { return [] }
        return await PushNotifications.shared.foregroundOptions(for: route)
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        guard response.actionIdentifier == UNNotificationDefaultActionIdentifier,
              let route = PushNotificationRoute.decode(response.notification.request.content.userInfo) else { return }
        await PushNotifications.shared.open(route)
    }
}
