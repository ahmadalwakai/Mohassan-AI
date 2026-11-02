import Foundation
import Security
import CryptoKit

actor TokenVault {
    static let shared = TokenVault()
    private let service = "app.wasla.local-device"
    private let account = "paired-device-token"
    private var query: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account]
    }
    func read() throws -> String? {
        var request = query
        request[kSecReturnData as String] = true
        request[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(request as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = result as? Data, let token = String(data: data, encoding: .utf8) else { throw WaslaError.storage(status) }
        return token
    }
    func save(_ token: String) throws {
        let attributes: [String: Any] = [kSecValueData as String: Data(token.utf8), kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly]
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
}

// Reads only the standard X.509 validity sequence. Unknown or malformed DER fails closed.
// Explicit dates avoid relying on how a trust anchor's validity is treated by the OS.
enum CertificateDates {
    private struct Node { let tag: UInt8; let bytes: [UInt8] }
    private struct Reader {
        var bytes: [UInt8]
        var offset = 0
        mutating func next() throws -> Node {
            guard offset + 2 <= bytes.count else { throw WaslaError.certificate }
            let tag = bytes[offset]; offset += 1
            let first = bytes[offset]; offset += 1
            var length = Int(first)
            if first & 0x80 != 0 {
                let count = Int(first & 0x7f)
                guard count > 0, count <= 4, offset + count <= bytes.count, bytes[offset] != 0 else { throw WaslaError.certificate }
                length = 0
                for _ in 0..<count { length = (length << 8) | Int(bytes[offset]); offset += 1 }
                guard length >= 128 else { throw WaslaError.certificate }
            }
            guard length <= bytes.count - offset else { throw WaslaError.certificate }
            let result = Node(tag: tag, bytes: Array(bytes[offset..<(offset + length)]))
            offset += length
            return result
        }
    }
    private static func date(_ node: Node) throws -> Date {
        guard let string = String(bytes: node.bytes, encoding: .ascii), string.last == "Z" else { throw WaslaError.certificate }
        let isUTC = node.tag == 0x17
        guard isUTC || node.tag == 0x18, string.count == (isUTC ? 13 : 15) else { throw WaslaError.certificate }
        let digits = Array(string.dropLast())
        guard digits.allSatisfy({ $0.isASCII && $0.isNumber }) else { throw WaslaError.certificate }
        func number(_ start: Int, _ length: Int) -> Int { Int(String(digits[start..<(start + length)])) ?? -1 }
        let yearWidth = isUTC ? 2 : 4
        var year = number(0, yearWidth)
        if isUTC { year += year >= 50 ? 1900 : 2000 }
        var parts = DateComponents()
        parts.year = year; parts.month = number(yearWidth, 2); parts.day = number(yearWidth + 2, 2)
        parts.hour = number(yearWidth + 4, 2); parts.minute = number(yearWidth + 6, 2); parts.second = number(yearWidth + 8, 2)
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(secondsFromGMT: 0)!
        guard let value = calendar.date(from: parts) else { throw WaslaError.certificate }
        let verified = calendar.dateComponents([.year, .month, .day, .hour, .minute, .second], from: value)
        guard verified.year == parts.year, verified.month == parts.month, verified.day == parts.day,
              verified.hour == parts.hour, verified.minute == parts.minute, verified.second == parts.second else { throw WaslaError.certificate }
        return value
    }
    static func validNow(_ data: Data, now: Date = Date()) -> Bool {
        do {
            var certificate = Reader(bytes: Array(data))
            let outer = try certificate.next()
            guard outer.tag == 0x30, certificate.offset == certificate.bytes.count else { return false }
            var outerReader = Reader(bytes: outer.bytes)
            let tbs = try outerReader.next()
            guard tbs.tag == 0x30 else { return false }
            var fields = Reader(bytes: tbs.bytes)
            var serial = try fields.next()
            if serial.tag == 0xa0 { serial = try fields.next() }
            guard serial.tag == 0x02, try fields.next().tag == 0x30, try fields.next().tag == 0x30 else { return false }
            let validity = try fields.next()
            guard validity.tag == 0x30 else { return false }
            var dates = Reader(bytes: validity.bytes)
            let before = try date(dates.next())
            let after = try date(dates.next())
            return dates.offset == dates.bytes.count && before <= now && now <= after && before < after
        } catch { return false }
    }
}

final class PinnedSessionDelegate: NSObject, URLSessionDelegate, URLSessionTaskDelegate, @unchecked Sendable {
    private let host: String
    private let port: Int
    private let fingerprint: String
    init(identity: ServerIdentity) {
        host = identity.baseURL.host!.lowercased()
        port = identity.baseURL.port ?? 443
        fingerprint = identity.fingerprint
    }
    func urlSession(_ session: URLSession, didReceive challenge: URLAuthenticationChallenge, completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        authenticate(challenge, completionHandler: completionHandler)
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, didReceive challenge: URLAuthenticationChallenge, completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        authenticate(challenge, completionHandler: completionHandler)
    }
    private func authenticate(_ challenge: URLAuthenticationChallenge, completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        let space = challenge.protectionSpace
        guard space.authenticationMethod == NSURLAuthenticationMethodServerTrust,
              space.host.lowercased() == host, space.port == port, challenge.previousFailureCount == 0,
              let trust = space.serverTrust,
              SecTrustSetNetworkFetchAllowed(trust, false) == errSecSuccess,
              let chain = SecTrustCopyCertificateChain(trust) as? [SecCertificate],
              let leaf = chain.first else { completionHandler(.cancelAuthenticationChallenge, nil); return }
        let data = SecCertificateCopyData(leaf) as Data
        let actual = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
        guard actual == fingerprint, CertificateDates.validNow(data),
              SecTrustSetPolicies(trust, SecPolicyCreateSSL(true, host as CFString)) == errSecSuccess,
              SecTrustSetAnchorCertificates(trust, [leaf] as CFArray) == errSecSuccess,
              SecTrustSetAnchorCertificatesOnly(trust, true) == errSecSuccess,
              SecTrustSetNetworkFetchAllowed(trust, false) == errSecSuccess,
              SecTrustSetVerifyDate(trust, Date() as CFDate) == errSecSuccess,
              SecTrustEvaluateWithError(trust, nil) else { completionHandler(.cancelAuthenticationChallenge, nil); return }
        completionHandler(.useCredential, URLCredential(trust: trust))
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

final class APIClient: @unchecked Sendable {
    let identity: ServerIdentity
    private let token: String?
    private let session: URLSession
    init(identity: ServerIdentity, token: String? = nil) {
        self.identity = identity; self.token = token
        let configuration = URLSessionConfiguration.ephemeral
        configuration.urlCache = nil
        configuration.httpCookieStorage = nil
        configuration.httpShouldSetCookies = false
        configuration.urlCredentialStorage = nil
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.timeoutIntervalForRequest = 90
        configuration.timeoutIntervalForResource = 180
        configuration.tlsMinimumSupportedProtocolVersion = .TLSv12
        session = URLSession(configuration: configuration, delegate: PinnedSessionDelegate(identity: identity), delegateQueue: nil)
    }
    deinit { session.invalidateAndCancel() }
    func data(path: String, method: String = "GET", body: Data? = nil, desktopSession: String? = nil, timeout: TimeInterval = 90) async throws -> Data {
        guard path.hasPrefix("/v1/"), !path.contains(".."), !path.contains("//"), !path.contains("%"),
              !path.contains("?"), !path.contains("#"), !path.contains("\\"),
              var components = URLComponents(url: identity.baseURL, resolvingAgainstBaseURL: false) else { throw WaslaError.invalidAddress }
        components.path = path
        guard let url = components.url, url.host?.lowercased() == identity.baseURL.host?.lowercased(), url.scheme == "https", url.port == identity.baseURL.port else { throw WaslaError.invalidAddress }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.timeoutInterval = timeout
        request.httpBody = body
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if body != nil { request.setValue("application/json", forHTTPHeaderField: "Content-Type") }
        if let token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        if let desktopSession {
            guard !desktopSession.isEmpty, desktopSession.utf8.count <= 512,
                  !desktopSession.unicodeScalars.contains(where: { CharacterSet.whitespacesAndNewlines.union(.controlCharacters).contains($0) }) else { throw WaslaError.invalidResponse }
            request.setValue(desktopSession, forHTTPHeaderField: "X-Wasla-Session")
        }
        let result: (Data, URLResponse)
        do { result = try await session.data(for: request) }
        catch let error as URLError where error.code == .cancelled && !Task.isCancelled {
            // Rejecting an authentication challenge can surface as -999 rather than -1202.
            throw WaslaError.certificate
        }
        let (data, response) = result
        guard let http = response as? HTTPURLResponse, http.url?.host?.lowercased() == url.host?.lowercased(), http.url?.port == url.port, http.url?.scheme == "https", data.count <= 25 * 1024 * 1024 else { throw WaslaError.invalidResponse }
        guard (200...299).contains(http.statusCode) else {
            let fault = try? JSONDecoder().decode(ServerFault.self, from: data)
            let fallback = (300...399).contains(http.statusCode) ? "رفض التطبيق إعادة توجيه الاتصال لحماية بيانات الاقتران." : "تعذّر إكمال الطلب (\(http.statusCode))."
            throw WaslaError.server(http.statusCode, fault?.error.message ?? fallback)
        }
        return data
    }
    func get<Response: Decodable>(_ path: String) async throws -> Response {
        try JSONDecoder().decode(Response.self, from: await data(path: path))
    }
    func post<Body: Encodable, Response: Decodable>(_ path: String, body: Body, desktopSession: String? = nil) async throws -> Response {
        let encoded = try JSONEncoder().encode(body)
        return try JSONDecoder().decode(Response.self, from: await data(path: path, method: "POST", body: encoded, desktopSession: desktopSession))
    }
    func delete(_ path: String, desktopSession: String? = nil) async throws {
        _ = try await data(path: path, method: "DELETE", desktopSession: desktopSession, timeout: 10)
    }
}
