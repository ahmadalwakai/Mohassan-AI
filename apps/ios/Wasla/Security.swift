import Foundation
import Security

/// The owner's session cookie, kept in the Keychain on this device only.
actor SessionVault {
    static let shared = SessionVault()
    private let service = "app.mohassan.cloud-session"
    private let account = "web-session"
    private var query: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account]
    }
    func read() throws -> SessionCookie? {
        var request = query
        request[kSecReturnData as String] = true
        request[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(request as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = result as? Data else { throw WaslaError.storage(status) }
        guard let cookie = try? JSONDecoder().decode(SessionCookie.self, from: data), cookie.valid else {
            try? delete()
            return nil
        }
        return cookie
    }
    func save(_ cookie: SessionCookie) throws {
        let data = try JSONEncoder().encode(cookie)
        let attributes: [String: Any] = [kSecValueData as String: data, kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly]
        let updated = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if updated == errSecItemNotFound {
            let added = SecItemAdd(query.merging(attributes) { _, new in new } as CFDictionary, nil)
            guard added == errSecSuccess else { throw WaslaError.storage(added) }
        } else if updated != errSecSuccess { throw WaslaError.storage(updated) }
    }
    func delete() throws {
        let status = SecItemDelete(query as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw WaslaError.storage(status) }
    }
    /// The pairing token of the app's earlier version, which talked to the PC directly: of no use now.
    func forgetLegacyPairing() {
        let legacy: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: "app.wasla.local-device", kSecAttrAccount as String: "paired-device-token"]
        _ = SecItemDelete(legacy as CFDictionary)
    }
}

/// Refuses every redirect: each call goes to the configured origin and nowhere else.
final class NoRedirects: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

/// Calls the cloud server through the web site, exactly as the web does: the site's Origin, the session cookie,
/// JSON, and an Idempotency-Key on changing calls. The phone keeps no other state about the server.
final class CloudClient: @unchecked Sendable {
    let origin: URL
    let cookie: SessionCookie?
    private let session: URLSession
    private let originHeader: String

    struct Reply { let data: Data; let response: HTTPURLResponse }

    init(origin: URL, cookie: SessionCookie?) {
        self.origin = origin
        self.cookie = cookie
        originHeader = CloudDefaults.header(origin)
        let configuration = URLSessionConfiguration.ephemeral
        configuration.urlCache = nil
        configuration.httpCookieStorage = nil
        configuration.httpShouldSetCookies = false
        configuration.urlCredentialStorage = nil
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.timeoutIntervalForRequest = 60
        configuration.timeoutIntervalForResource = 300
        configuration.tlsMinimumSupportedProtocolVersion = .TLSv12
        session = URLSession(configuration: configuration, delegate: NoRedirects(), delegateQueue: nil)
    }
    deinit { session.invalidateAndCancel() }

    /// A path under /api on the configured origin; anything else is refused before a request is made.
    func url(_ path: String, query: [URLQueryItem] = []) throws -> URL {
        guard path.hasPrefix("/api/"), !path.contains(".."), !path.contains("//"), !path.contains("%"),
              !path.contains("?"), !path.contains("#"), !path.contains("\\"),
              path.unicodeScalars.allSatisfy({ $0.isASCII && !CharacterSet.whitespacesAndNewlines.contains($0) }),
              var components = URLComponents(url: origin, resolvingAgainstBaseURL: false) else { throw WaslaError.invalidAddress }
        components.path = path
        components.queryItems = query.isEmpty ? nil : query
        guard let url = components.url, url.scheme == "https", url.host?.lowercased() == origin.host?.lowercased() else { throw WaslaError.invalidAddress }
        return url
    }

    func send(_ path: String, query: [URLQueryItem] = [], method: String = "GET", body: Data? = nil, key: String? = nil,
              timeout: TimeInterval = 30, signedIn: Bool = true) async throws -> Reply {
        let target = try url(path, query: query)
        var request = URLRequest(url: target)
        request.httpMethod = method
        request.timeoutInterval = timeout
        request.httpBody = body
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue(originHeader, forHTTPHeaderField: "Origin")
        if body != nil { request.setValue("application/json", forHTTPHeaderField: "Content-Type") }
        if signedIn, let cookie { request.setValue(cookie.header, forHTTPHeaderField: "Cookie") }
        if let key {
            guard PendingRequest.validKey(key) else { throw WaslaError.invalidResponse }
            request.setValue(key, forHTTPHeaderField: "Idempotency-Key")
        }
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse, http.url?.host?.lowercased() == target.host?.lowercased(),
              data.count <= 25 * 1024 * 1024 else { throw WaslaError.invalidResponse }
        if http.statusCode == 401, signedIn, cookie != nil { throw WaslaError.signedOut }
        guard (200...299).contains(http.statusCode) else { throw ServerFault.error(status: http.statusCode, data: data) }
        return Reply(data: data, response: http)
    }

    func get<Response: Decodable>(_ path: String, query: [URLQueryItem] = [], timeout: TimeInterval = 30) async throws -> Response {
        let reply = try await send(path, query: query, timeout: timeout)
        return try JSONDecoder().decode(Response.self, from: reply.data)
    }
    func post<Body: Encodable, Response: Decodable>(_ path: String, body: Body, key: String? = nil, timeout: TimeInterval = 30) async throws -> Response {
        let encoded = try JSONEncoder().encode(body)
        let reply = try await send(path, method: "POST", body: encoded, key: key, timeout: timeout)
        return try JSONDecoder().decode(Response.self, from: reply.data)
    }
    func delete(_ path: String) async throws {
        _ = try await send(path, method: "DELETE", timeout: 20)
    }

    /// Signs in with the owner's account, as the web does, and returns the session cookie the server set.
    func signIn(email: String, password: String) async throws -> (SessionCookie, SignInReply) {
        let body = try JSONEncoder().encode(SignInBody(email: email, password: password, rememberMe: true))
        let reply: Reply
        do { reply = try await send("/api/auth/sign-in/email", method: "POST", body: body, timeout: 30, signedIn: false) }
        catch let failure as WaslaError {
            if case .server(401, _, _) = failure { throw WaslaError.invalidCredentials }
            throw failure
        }
        let header = reply.response.value(forHTTPHeaderField: "Set-Cookie") ?? ""
        guard let cookie = SessionCookie.from(setCookie: header) else { throw WaslaError.message("لم يُرسل الخادم مفتاح الجلسة. أعد المحاولة.") }
        let user = (try? JSONDecoder().decode(SignInReply.self, from: reply.data)) ?? SignInReply(user: nil)
        return (cookie, user)
    }

    /// Ends the session on the server; the server also revokes this session's Windows grants.
    func signOut() async {
        _ = try? await send("/api/auth/sign-out", method: "POST", body: Data("{}".utf8), timeout: 15)
    }
}
