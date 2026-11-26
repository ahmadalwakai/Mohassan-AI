package com.ahmadalwakai.wasla

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import android.util.Log
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.encodeToString
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.io.InputStream
import java.net.InetAddress
import java.net.Socket
import java.net.URL
import java.security.KeyStore
import java.security.MessageDigest
import java.security.SecureRandom
import java.security.cert.CertificateException
import java.security.cert.X509Certificate
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import javax.net.ssl.HostnameVerifier
import javax.net.ssl.HttpsURLConnection
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLException
import javax.net.ssl.SSLSocket
import javax.net.ssl.SSLSocketFactory
import javax.net.ssl.X509TrustManager

/**
 * The device token, sealed with a key that never leaves the Android Keystore (AES-GCM) and
 * kept only on this device: the counterpart of the iOS Keychain item, and excluded from backups.
 */
object TokenVault {
    private const val PREFS = "wasla.vault"
    private const val ENTRY = "paired-device-token"
    private const val ALIAS = "wasla.device.token"
    private const val PROVIDER = "AndroidKeyStore"
    private const val IV_BYTES = 12

    private fun key(create: Boolean): SecretKey? {
        val store = KeyStore.getInstance(PROVIDER).apply { load(null) }
        (store.getKey(ALIAS, null) as? SecretKey)?.let { return it }
        if (!create) return null
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, PROVIDER)
        generator.init(
            KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build()
        )
        return generator.generateKey()
    }

    suspend fun read(context: Context): String? = withContext(Dispatchers.IO) {
        val stored = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(ENTRY, null) ?: return@withContext null
        try {
            val raw = Base64.decode(stored, Base64.NO_WRAP)
            if (raw.size <= IV_BYTES) return@withContext null
            val key = key(create = false) ?: return@withContext null
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(128, raw, 0, IV_BYTES))
            String(cipher.doFinal(raw, IV_BYTES, raw.size - IV_BYTES), Charsets.UTF_8)
        } catch (ignored: Exception) {
            null
        }
    }

    suspend fun save(context: Context, token: String) = withContext(Dispatchers.IO) {
        try {
            val key = key(create = true) ?: throw IllegalStateException("keystore")
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.ENCRYPT_MODE, key)
            val sealed = cipher.iv + cipher.doFinal(token.toByteArray(Charsets.UTF_8))
            val written = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
                .putString(ENTRY, Base64.encodeToString(sealed, Base64.NO_WRAP)).commit()
            if (!written) throw IllegalStateException("commit")
        } catch (error: Exception) {
            throw WaslaException.storage(error.javaClass.simpleName)
        }
    }

    suspend fun delete(context: Context) = withContext(Dispatchers.IO) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().remove(ENTRY).commit()
        try { KeyStore.getInstance(PROVIDER).apply { load(null) }.deleteEntry(ALIAS) } catch (ignored: Exception) {}
        Unit
    }
}

/**
 * Trusts exactly one certificate: the one whose SHA-256 the owner copied from the computer.
 * The chain, the system roots and any user-added roots play no part. The certificate must also
 * be valid now, name the computer's address and be issued for a server, as on iOS.
 */
class PinnedTrustManager(host: String, fingerprint: String) : X509TrustManager {
    private val host = host.trim('[', ']').lowercase()
    private val fingerprint = fingerprint.lowercase()

    override fun checkClientTrusted(chain: Array<X509Certificate>?, authType: String?) {
        throw CertificateException("Client certificates are not used.")
    }

    override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()

    override fun checkServerTrusted(chain: Array<X509Certificate>?, authType: String?) {
        val leaf = chain?.firstOrNull() ?: throw CertificateException("The computer sent no certificate.")
        val actual = sha256Hex(leaf.encoded)
        if (!MessageDigest.isEqual(actual.toByteArray(), fingerprint.toByteArray())) throw CertificateException("The certificate is not the pinned one.")
        try { leaf.checkValidity() } catch (ignored: Exception) { throw CertificateException("The certificate is not valid now.") }
        if (!hostMatches(leaf, host)) throw CertificateException("The certificate does not name this computer.")
        val usage = try { leaf.extendedKeyUsage } catch (ignored: Exception) { null }
        if (usage != null && SERVER_AUTH !in usage) throw CertificateException("The certificate is not for a server.")
    }

    companion object {
        private const val SERVER_AUTH = "1.3.6.1.5.5.7.3.1"
        private val IPV4 = Regex("^\\d{1,3}(\\.\\d{1,3}){3}$")

        fun sha256Hex(bytes: ByteArray): String = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }

        private fun isLiteral(value: String): Boolean = IPV4.matches(value) || (':' in value && value.all { it.isDigit() || it in 'a'..'f' || it == ':' || it == '.' })

        /** Without DNS: only two address literals are ever resolved, and literals never leave the device. */
        private fun sameAddress(certificateName: String, host: String): Boolean {
            if (certificateName == host) return true
            if (!isLiteral(certificateName) || !isLiteral(host)) return false
            return try { InetAddress.getByName(certificateName).address.contentEquals(InetAddress.getByName(host).address) } catch (ignored: Exception) { false }
        }

        private fun dnsMatches(pattern: String, host: String): Boolean {
            if (isLiteral(host)) return false
            if (pattern == host) return true
            if (!pattern.startsWith("*.")) return false
            val dot = host.indexOf('.')
            return dot > 0 && host.substring(dot) == pattern.substring(1) && host.count { it == '.' } == pattern.count { it == '.' }
        }

        /** True when a subject alternative name (IP or DNS) of the certificate is the host. */
        fun hostMatches(certificate: X509Certificate, host: String): Boolean {
            val wanted = host.trim('[', ']').lowercase()
            val names = try { certificate.subjectAlternativeNames } catch (ignored: Exception) { null } ?: return false
            for (entry in names) {
                val type = entry.getOrNull(0) as? Int ?: continue
                val value = (entry.getOrNull(1) as? String)?.lowercase() ?: continue
                when (type) {
                    7 -> if (sameAddress(value, wanted)) return true
                    2 -> if (dnsMatches(value, wanted)) return true
                }
            }
            return false
        }
    }
}

/** TLS 1.2 or newer only, whatever the device's defaults are. */
class TlsSocketFactory(private val delegate: SSLSocketFactory) : SSLSocketFactory() {
    private val allowed = setOf("TLSv1.3", "TLSv1.2")
    private fun harden(socket: Socket): Socket {
        if (socket is SSLSocket) socket.enabledProtocols = socket.supportedProtocols.filter { it in allowed }.toTypedArray()
        return socket
    }
    override fun getDefaultCipherSuites(): Array<String> = delegate.defaultCipherSuites
    override fun getSupportedCipherSuites(): Array<String> = delegate.supportedCipherSuites
    override fun createSocket(): Socket = harden(delegate.createSocket())
    override fun createSocket(s: Socket?, host: String?, port: Int, autoClose: Boolean): Socket = harden(delegate.createSocket(s, host, port, autoClose))
    override fun createSocket(host: String?, port: Int): Socket = harden(delegate.createSocket(host, port))
    override fun createSocket(host: String?, port: Int, localHost: InetAddress?, localPort: Int): Socket = harden(delegate.createSocket(host, port, localHost, localPort))
    override fun createSocket(host: InetAddress?, port: Int): Socket = harden(delegate.createSocket(host, port))
    override fun createSocket(address: InetAddress?, port: Int, localAddress: InetAddress?, localPort: Int): Socket = harden(delegate.createSocket(address, port, localAddress, localPort))
}

/**
 * HTTPS to the paired computer only: the pinned certificate, no redirects, no caches, no
 * cookies, JSON in and out, and bounded response sizes. Every call runs off the main thread.
 */
class ApiClient(val identity: ServerIdentity, private val token: String? = null) {
    private val socketFactory: SSLSocketFactory
    private val hostnameVerifier: HostnameVerifier

    init {
        val trust = PinnedTrustManager(identity.host, identity.fingerprint)
        val context = SSLContext.getInstance("TLS")
        context.init(null, arrayOf(trust), SecureRandom())
        socketFactory = TlsSocketFactory(context.socketFactory)
        hostnameVerifier = HostnameVerifier { name, session ->
            val leaf = try { session.peerCertificates.firstOrNull() as? X509Certificate } catch (ignored: Exception) { null }
            name.trim('[', ']').equals(identity.host, ignoreCase = true) && leaf != null && PinnedTrustManager.hostMatches(leaf, identity.host)
        }
    }

    suspend fun data(path: String, method: String = "GET", body: ByteArray? = null, desktopSession: String? = null, timeoutSeconds: Int = 90, idempotencyKey: String? = null): ByteArray = withContext(Dispatchers.IO) {
        if (!path.startsWith("/v1/") || ".." in path || "//" in path || '%' in path || '?' in path || '#' in path || '\\' in path
            || path.any { it.isWhitespace() || it.code < 32 }) throw WaslaException.invalidAddress()
        if (desktopSession != null && (desktopSession.isEmpty() || desktopSession.toByteArray().size > 512
                || desktopSession.any { it.isWhitespace() || it.code < 32 || it.code == 127 })) throw WaslaException.invalidResponse()
        if (idempotencyKey != null && !Regex("^[a-zA-Z0-9_-]{8,128}$").matches(idempotencyKey)) throw WaslaException.invalidResponse()
        val url = URL(identity.baseUrl + path)
        if (url.protocol != "https" || !url.host.trim('[', ']').equals(identity.host, ignoreCase = true)) throw WaslaException.invalidAddress()
        val connection = url.openConnection() as? HttpsURLConnection ?: throw WaslaException.invalidAddress()
        try {
            connection.sslSocketFactory = socketFactory
            connection.hostnameVerifier = hostnameVerifier
            connection.requestMethod = method
            connection.instanceFollowRedirects = false
            connection.useCaches = false
            connection.connectTimeout = 15_000
            connection.readTimeout = timeoutSeconds * 1000
            connection.setRequestProperty("Accept", "application/json")
            if (token != null) connection.setRequestProperty("Authorization", "Bearer $token")
            if (desktopSession != null) connection.setRequestProperty("X-Wasla-Session", desktopSession)
            if (idempotencyKey != null) connection.setRequestProperty("Idempotency-Key", idempotencyKey)
            if (body != null) {
                connection.doOutput = true
                connection.setRequestProperty("Content-Type", "application/json")
                connection.setFixedLengthStreamingMode(body.size)
                connection.outputStream.use { it.write(body) }
            }
            val status = connection.responseCode
            val stream = if (status in 200..299) connection.inputStream else connection.errorStream
            val bytes = stream?.use { readCapped(it) } ?: ByteArray(0)
            if (status !in 200..299) {
                val fault = runCatching { WaslaJson.decodeFromString(ServerFault.serializer(), bytes.decodeToString()).error.message }
                    .getOrNull()?.takeIf { it.isNotBlank() }
                val fallback = if (status in 300..399) "رفض التطبيق إعادة توجيه الاتصال لحماية بيانات الاقتران." else "تعذّر إكمال الطلب ($status)."
                throw WaslaException.server(status, fault ?: fallback)
            }
            bytes
        } catch (error: WaslaException) {
            throw error
        } catch (error: SSLException) {
            Log.w(TAG, "TLS to the computer failed for $method $path", error)
            throw WaslaException.certificate()
        } catch (error: CertificateException) {
            Log.w(TAG, "certificate check failed for $method $path", error)
            throw WaslaException.certificate()
        } catch (error: IOException) {
            // The message names the failure class only; no token, body or address beyond the path.
            Log.w(TAG, "request failed for $method $path: ${error.javaClass.simpleName}: ${error.message}")
            throw WaslaException.network()
        } finally {
            connection.disconnect()
        }
    }

    private fun readCapped(stream: InputStream): ByteArray {
        val out = ByteArrayOutputStream()
        val buffer = ByteArray(16 * 1024)
        while (true) {
            val read = stream.read(buffer)
            if (read < 0) break
            out.write(buffer, 0, read)
            if (out.size() > MAX_RESPONSE_BYTES) throw WaslaException.invalidResponse()
        }
        return out.toByteArray()
    }

    inline fun <reified R> decode(bytes: ByteArray): R = try {
        WaslaJson.decodeFromString<R>(bytes.decodeToString())
    } catch (ignored: Exception) {
        throw WaslaException.invalidResponse()
    }

    suspend inline fun <reified R> get(path: String, timeoutSeconds: Int = 90): R = decode(data(path, timeoutSeconds = timeoutSeconds))

    suspend inline fun <reified B, reified R> post(path: String, body: B, desktopSession: String? = null, timeoutSeconds: Int = 90): R =
        decode(data(path, "POST", WaslaJson.encodeToString(body).toByteArray(Charsets.UTF_8), desktopSession, timeoutSeconds))

    /** A POST whose acknowledgement does not matter. */
    suspend inline fun <reified B> send(path: String, body: B, desktopSession: String? = null, timeoutSeconds: Int = 90) {
        data(path, "POST", WaslaJson.encodeToString(body).toByteArray(Charsets.UTF_8), desktopSession, timeoutSeconds)
    }

    suspend fun delete(path: String, desktopSession: String? = null) {
        data(path, "DELETE", desktopSession = desktopSession, timeoutSeconds = 10)
    }

    companion object {
        const val MAX_RESPONSE_BYTES = 25 * 1024 * 1024
        private const val TAG = "Wasla"
    }
}
