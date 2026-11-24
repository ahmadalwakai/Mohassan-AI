package com.ahmadalwakai.wasla

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runInterruptible
import kotlinx.serialization.Serializable
import kotlinx.serialization.SerializationException
import kotlinx.serialization.encodeToString
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.io.InputStream
import java.net.URL
import java.net.URLEncoder
import java.util.concurrent.atomic.AtomicReference
import javax.net.ssl.HttpsURLConnection

const val CLOUD_ORIGIN = "https://www.mohassansy.com"

class WaslaException(val kind: Kind, message: String, val status: Int = 0, val code: String? = null) : Exception(message) {
    enum class Kind { INVALID_RESPONSE, SIGNED_OUT, SERVER, NETWORK, STORAGE, MESSAGE }

    companion object {
        fun invalidResponse() = WaslaException(Kind.INVALID_RESPONSE, "وصل رد غير متوقع من الخادم.")
        fun signedOut() = WaslaException(Kind.SIGNED_OUT, "انتهت جلستك. سجّل الدخول من جديد.")
        fun storage() = WaslaException(Kind.STORAGE, "تعذّر حفظ الجلسة في مخزن الهاتف الآمن.")
        fun network() = WaslaException(Kind.NETWORK, "تعذّر الوصول إلى الخادم. تحقق من اتصال الهاتف بالإنترنت.")
        fun message(text: String) = WaslaException(Kind.MESSAGE, text)
    }
}

@JvmInline
value class SessionCookie private constructor(val header: String) {
    companion object {
        private val pair = Regex("(?:__Secure-)?better-auth\\.session_token=[A-Za-z0-9._~%+/=\\-]{16,4096}")
        private val pairAtBoundary = Regex("(?:^|[ ,;])(${pair.pattern})(?=$|[ ,;])")

        fun fromHeader(header: String): SessionCookie? = header.takeIf(pair::matches)?.let(::SessionCookie)

        fun fromSetCookies(headers: List<String>): SessionCookie? =
            headers.firstNotNullOfOrNull { header -> pairAtBoundary.find(header)?.groupValues?.get(1)?.let(::SessionCookie) }
    }
}

@Serializable data class SignInBody(val email: String, val password: String, val rememberMe: Boolean)
@Serializable data class SignInReply(val user: User? = null) {
    @Serializable data class User(val email: String? = null)
}

@Serializable
internal data class ServerFault(val error: Detail? = null, val code: String? = null, val message: String? = null) {
    @Serializable data class Detail(val code: String? = null, val message: String? = null)
}

internal data class CloudReply(val status: Int, val data: ByteArray, val setCookies: List<String> = emptyList())
internal fun interface CloudTransport {
    suspend fun exchange(request: CloudRequest, headers: Map<String, String>): CloudReply
}

internal data class CloudRequest(
    val path: String,
    val method: String = "GET",
    val body: ByteArray? = null,
    val key: String? = null,
    val query: Map<String, String> = emptyMap(),
    val timeoutSeconds: Int = 30,
    val accept: String = "application/json",
)

internal class CloudClient(
    cookie: SessionCookie? = null,
    private val onSignedOut: () -> Unit = {},
    private val transport: CloudTransport = HttpsTransport,
) {
    private val session = AtomicReference(cookie?.header)
    private val authenticated = cookie != null

    suspend fun request(request: CloudRequest): CloudReply {
        if (!API_PATH.matches(request.path) || ".." in request.path || "//" in request.path ||
            request.key?.let { !PendingRequest.validKey(it) } == true
        ) throw WaslaException.invalidResponse()

        val cookie = session.get()
        if (authenticated && cookie == null) throw WaslaException.signedOut()
        val headers = buildMap {
            put("Accept", request.accept)
            if (request.method != "GET") put("Origin", CLOUD_ORIGIN)
            if (request.body != null) put("Content-Type", "application/json")
            if (cookie != null) put("Cookie", cookie)
            request.key?.let { put("Idempotency-Key", it) }
        }
        val reply = try {
            transport.exchange(request, headers)
        } catch (error: IOException) {
            throw WaslaException.network()
        }
        if (reply.status == 401 && cookie != null) {
            if (session.compareAndSet(cookie, null)) onSignedOut()
            throw WaslaException.signedOut()
        }
        if (reply.status !in 200..299) {
            val fault = runCatching { decode<ServerFault>(reply.data) }.getOrNull()
            val fallback = if (reply.status in 300..399) "رفض التطبيق إعادة توجيه الاتصال."
                else "تعذّر إكمال الطلب (${reply.status})."
            val message = (fault?.error?.message ?: fault?.message)?.takeIf(String::isNotBlank) ?: fallback
            throw WaslaException(WaslaException.Kind.SERVER, message, reply.status, fault?.error?.code ?: fault?.code)
        }
        return reply
    }

    suspend inline fun <reified R> get(path: String, timeoutSeconds: Int = 30, query: Map<String, String> = emptyMap()): R =
        decode(request(CloudRequest(path, timeoutSeconds = timeoutSeconds, query = query)).data)

    suspend inline fun <reified B, reified R> post(path: String, body: B, timeoutSeconds: Int = 30): R =
        decode(request(CloudRequest(path, "POST", encode(body), timeoutSeconds = timeoutSeconds)).data)

    suspend fun signIn(email: String, password: String): Pair<SessionCookie, SignInReply> {
        val reply = try {
            request(CloudRequest("/api/auth/sign-in/email", "POST", encode(SignInBody(email, password, rememberMe = true))))
        } catch (error: WaslaException) {
            if (error.status == 401) throw WaslaException.message("البريد أو كلمة المرور غير صحيحة.")
            throw error
        }
        val cookie = SessionCookie.fromSetCookies(reply.setCookies)
            ?: throw WaslaException.message("لم يُرسل الخادم مفتاح الجلسة. أعد المحاولة.")
        return cookie to decode<SignInReply>(reply.data)
    }

    companion object {
        private val API_PATH = Regex("/api/[A-Za-z0-9_/.-]+")
    }
}

internal inline fun <reified T> encode(value: T): ByteArray = WaslaJson.encodeToString(value).encodeToByteArray()

internal inline fun <reified T> decode(data: ByteArray): T = try {
    WaslaJson.decodeFromString<T>(data.decodeToString())
} catch (error: SerializationException) {
    throw WaslaException.invalidResponse()
}

private object HttpsTransport : CloudTransport {
    override suspend fun exchange(request: CloudRequest, headers: Map<String, String>): CloudReply =
        runInterruptible(Dispatchers.IO) {
            val query = request.query.entries.joinToString("&", prefix = "?") { (key, value) ->
                "${URLEncoder.encode(key, "UTF-8")}=${URLEncoder.encode(value, "UTF-8")}"
            }.takeIf { request.query.isNotEmpty() }.orEmpty()
            val connection = URL(CLOUD_ORIGIN + request.path + query).openConnection() as HttpsURLConnection
            try {
                connection.requestMethod = request.method
                connection.instanceFollowRedirects = false
                connection.useCaches = false
                connection.connectTimeout = 15_000
                connection.readTimeout = request.timeoutSeconds * 1_000
                for ((name, value) in headers) connection.setRequestProperty(name, value)
                request.body?.let { body ->
                    connection.doOutput = true
                    connection.setFixedLengthStreamingMode(body.size)
                    connection.outputStream.use { it.write(body) }
                }
                val status = connection.responseCode
                // Process an expired session even when the server closes its response body early.
                val stream = if (status in 200..299) connection.inputStream else connection.errorStream
                val bytes = stream?.use { if (status == 401) ByteArray(0) else readCapped(it) } ?: ByteArray(0)
                val cookies = connection.headerFields.entries
                    .filter { (name, _) -> name.equals("Set-Cookie", ignoreCase = true) }
                    .flatMap { (_, values) -> values }
                CloudReply(status, bytes, cookies)
            } finally {
                connection.disconnect()
            }
        }

    private fun readCapped(stream: InputStream): ByteArray {
        val output = ByteArrayOutputStream()
        val buffer = ByteArray(16 * 1024)
        while (true) {
            val count = stream.read(buffer)
            if (count < 0) break
            if (output.size() + count > 25 * 1024 * 1024) throw WaslaException.invalidResponse()
            output.write(buffer, 0, count)
        }
        return output.toByteArray()
    }
}
