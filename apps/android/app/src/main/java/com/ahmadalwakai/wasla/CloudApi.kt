package com.ahmadalwakai.wasla

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.asExecutor
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.net.URI
import java.net.URLEncoder
import java.nio.charset.CharacterCodingException
import java.security.MessageDigest
import java.util.Base64
import javax.net.ssl.HttpsURLConnection

// Production web relay: https://github.com/ahmadalwakai/Mohassan-AI/blob/29448ae/README.md#L160-L162 (retrieved 2026-11-27).
const val CLOUD_ORIGIN = "https://www.mohassansy.com"

/** Stores only the exact Cookie header value. The Android implementation encrypts it on this device. */
interface SessionVault {
    fun read(): String?
    fun save(cookie: String)
    fun clear()
}

class SessionCookie private constructor(val name: String, val value: String) {
    val header: String get() = "$name=$value"

    companion object {
        private const val PAIR = "((?:__Secure-)?better-auth\\.session_token)=([A-Za-z0-9._~%+/=-]{16,4096})"
        private val exact = Regex(PAIR)
        private val setCookie = Regex("(?:^|,)\\s*$PAIR(?=\\s*(?:[;,]|$))")

        fun fromHeader(header: String): SessionCookie? = exact.matchEntire(header)?.let(::cookie)

        fun fromSetCookie(headers: List<String>): SessionCookie? =
            headers.firstNotNullOfOrNull { header -> setCookie.find(header)?.let(::cookie) }

        private fun cookie(match: MatchResult): SessionCookie =
            SessionCookie(match.groupValues[1], match.groupValues[2])
    }
}

class CloudSignedOut : IOException("انتهت جلستك. سجّل الدخول من جديد.")
class CloudInvalidCredentials : IOException("البريد أو كلمة المرور غير صحيحة.")
class CloudInvalidResponse(
    message: String = "وصل رد غير متوقع من الخادم.",
    cause: Throwable? = null,
) : IOException(message, cause)

class CloudHttpError(val status: Int, val code: String?, message: String) : IOException(message) {
    companion object {
        private const val FORBIDDEN = "هذه الخدمة غير متاحة لحسابك."

        fun memberForbidden() = CloudHttpError(403, "MEMBER_FORBIDDEN", FORBIDDEN)

        fun from(status: Int, bytes: ByteArray): CloudHttpError {
            val body = runCatching { CloudJson.decode<JsonObject>(bytes) }.getOrNull()
            val error = body?.get("error") as? JsonObject
            fun field(name: String): String? = error?.text(name) ?: body?.text(name)
            val code = field("code")
            val message = when (status) {
                in 300..399 -> "رفض التطبيق إعادة توجيه الاتصال."
                401 -> "تعذّر التحقق من الاتصال بالخادم. أعد المحاولة."
                403 -> if (code == "ORIGIN_DENIED") "رفض الخادم مصدر الاتصال." else FORBIDDEN
                429 -> when (code) {
                    "CHAT_IMAGE_QUOTA" -> "بلغت حدّ الصور المرفقة اليوم."
                    "MEMBER_DAILY_LIMIT" -> "بلغت حدّ الطلبات اليومي لحسابك. حاول لاحقًا."
                    else -> "طلبات كثيرة في وقت قصير. انتظر قليلًا ثم أعد المحاولة."
                }
                in 500..599 -> "تعذّر على الخادم إكمال الطلب. أعد المحاولة بعد قليل."
                else -> field("message")?.takeIf { value ->
                    value.any { Character.UnicodeScript.of(it.code) == Character.UnicodeScript.ARABIC }
                } ?: "تعذّر إكمال الطلب ($status)."
            }
            return CloudHttpError(status, code, message)
        }

        private fun JsonObject.text(name: String): String? =
            (get(name) as? JsonPrimitive)?.takeIf { it.isString }?.content
    }
}

class CloudRequest(
    val method: String,
    val path: String,
    val query: Map<String, String> = emptyMap(),
    val headers: Map<String, String> = emptyMap(),
    val body: ByteArray? = null,
    val timeoutMillis: Int = 30_000,
)

data class CloudResponse(val status: Int, val body: ByteArray, val headers: Map<String, List<String>> = emptyMap())

fun interface CloudTransport {
    suspend fun execute(request: CloudRequest): CloudResponse
}

/** Uses the system TLS trust store and sends every request directly to the web origin. */
class HttpsCloudTransport : CloudTransport {
    override suspend fun execute(request: CloudRequest): CloudResponse = suspendCancellableCoroutine { continuation ->
        require(API_PATH.matches(request.path) && "//" !in request.path)
        val query = request.query.entries.joinToString("&") { (name, value) ->
            "${URLEncoder.encode(name, "UTF-8")}=${URLEncoder.encode(value, "UTF-8")}"
        }.let { if (it.isEmpty()) it else "?$it" }
        val url = URI.create(CLOUD_ORIGIN + request.path + query).toURL()
        val connection = url.openConnection() as HttpsURLConnection
        continuation.invokeOnCancellation { io.execute(connection::disconnect) }
        io.execute {
            if (continuation.isActive) {
                continuation.resumeWith(runCatching { exchange(connection, request) })
            }
        }
    }

    private fun exchange(connection: HttpsURLConnection, request: CloudRequest): CloudResponse =
        try {
            connection.instanceFollowRedirects = false
            connection.useCaches = false
            connection.connectTimeout = minOf(15_000, request.timeoutMillis)
            connection.readTimeout = request.timeoutMillis
            connection.requestMethod = request.method
            request.headers.forEach(connection::setRequestProperty)
            request.body?.let { body ->
                connection.doOutput = true
                // Streaming mode disables implicit replay of the request body by HttpURLConnection.
                connection.setFixedLengthStreamingMode(body.size)
                connection.outputStream.use { it.write(body) }
            }
            val status = connection.responseCode
            val headers = connection.headerFields.filterKeys { it != null }
            val stream = if (status in 200..299) connection.inputStream else connection.errorStream
            val body = stream?.use { input ->
                val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
                val output = ByteArrayOutputStream()
                while (true) {
                    val count = input.read(buffer)
                    if (count == -1) break
                    if (output.size() + count > MAX_RESPONSE_BYTES) throw CloudInvalidResponse()
                    output.write(buffer, 0, count)
                }
                output.toByteArray()
            } ?: byteArrayOf()
            CloudResponse(status, body, headers)
        } finally {
            connection.disconnect()
        }

    private companion object {
        const val MAX_RESPONSE_BYTES = 25 * 1024 * 1024
        val API_PATH = Regex("/api/[A-Za-z0-9_/-]+")
        val io = Dispatchers.IO.asExecutor()
    }
}

class CloudApi(private val vault: SessionVault, private val transport: CloudTransport = HttpsCloudTransport()) {
    private class ActiveSession(val cookie: SessionCookie) {
        val binding: String = MessageDigest.getInstance("SHA-256")
            .digest(cookie.header.encodeToByteArray()).joinToString("") { "%02x".format(it) }
    }

    private val sessionLock = Any()
    private val auth = Mutex()
    @Volatile private var session: ActiveSession? = null
    private val account = MutableStateFlow(false)
    val signedIn: StateFlow<Boolean> = account.asStateFlow()
    private val accountAccess = MutableStateFlow<CloudAccess?>(null)
    val access: StateFlow<CloudAccess?> = accountAccess.asStateFlow()

    fun sessionBinding(): String? = session?.binding

    suspend fun restore() = auth.withLock {
        withContext(Dispatchers.IO) {
            synchronized(sessionLock) {
                val stored = vault.read()
                val cookie = stored?.let(SessionCookie::fromHeader)
                if (stored != null && cookie == null) vault.clear()
                setSession(cookie)
            }
        }
    }

    suspend fun signIn(email: String, password: String): SignInReply = auth.withLock {
        val reply = try {
            val body = CloudJson.encode(SignInBody(email, password, rememberMe = true))
            send("POST", "/api/auth/sign-in/email", body = body, authenticated = false)
        } catch (error: CloudHttpError) {
            if (error.status == 401 && error.code != SERVICE_UNAUTHORIZED) throw CloudInvalidCredentials()
            throw error
        }
        val cookies = reply.headers.entries.filter { it.key.equals("Set-Cookie", ignoreCase = true) }.flatMap { it.value }
        val cookie = SessionCookie.fromSetCookie(cookies)
            ?: throw CloudInvalidResponse("لم يُرسل الخادم مفتاح الجلسة. أعد المحاولة.")
        val user = runCatching { CloudJson.decode<SignInReply>(reply.body) }.getOrDefault(SignInReply())

        currentCoroutineContext().ensureActive()
        withContext(Dispatchers.IO + NonCancellable) {
            synchronized(sessionLock) {
                vault.save(cookie.header)
                setSession(cookie)
            }
        }
        user
    }

    suspend fun signOut() = auth.withLock {
        val previous = session
        withContext(Dispatchers.IO + NonCancellable) {
            synchronized(sessionLock) {
                setSession(null)
                vault.clear()
            }
        }
        if (previous != null) {
            try {
                send(
                    "POST", "/api/auth/sign-out", body = CloudJson.encode(EmptyBody), timeoutMillis = 15_000,
                    authenticated = false, cookieOverride = previous.cookie,
                )
            } catch (_: CloudSignedOut) {
                // The server has already ended this session.
            }
        }
        Unit
    }

    /** Reads the same account role the web uses before enabling chat and owner-only operations. */
    suspend fun refreshAccess(): CloudAccess {
        val active = session ?: throw CloudSignedOut()
        val result = decode<CloudAccess>(send("GET", ACCESS, expectedBinding = active.binding))
        if (result.role != "owner" && result.role != "member") throw CloudInvalidResponse()
        synchronized(sessionLock) {
            if (active !== session) throw CloudSignedOut()
            accountAccess.value = result
        }
        return result
    }

    suspend fun chatList(): ChatList = get(CONVERSATIONS)

    suspend fun conversation(id: String, since: String? = null): ChatConversation {
        require(since == null || CHAT_VERSION.matches(since))
        val query = if (since == null) emptyMap() else mapOf("since" to since, "wait" to "8000")
        return get(conversationPath(id), query, timeoutMillis = if (since == null) 30_000 else 20_000)
    }

    suspend fun sendKeyed(path: String, body: ByteArray, key: String, expectedBinding: String? = null): ChatConversation {
        require(path == CONVERSATIONS || KEYED_PATH.matches(path))
        require(KEY_PATTERN.matches(key))
        return decode(send("POST", path, body = body, key = key, timeoutMillis = 150_000, expectedBinding = expectedBinding))
    }

    suspend fun feedback(id: String, body: ChatFeedback): ChatConversation =
        post(conversationPath(id, "/feedback"), body, timeoutMillis = 20_000)

    suspend fun secure(id: String, body: ChatSecureSubmit): ChatConversation =
        post(conversationPath(id, "/secure"), body, timeoutMillis = 120_000)

    suspend fun cancel(id: String): ChatConversation =
        post(conversationPath(id, "/cancel"), EmptyBody, timeoutMillis = 45_000)

    suspend fun deleteConversation(id: String) {
        send("DELETE", conversationPath(id), timeoutMillis = 20_000)
    }

    suspend fun screen(id: String, version: String? = null): ByteArray {
        val query = if (version == null) emptyMap() else mapOf("v" to version)
        val image = send("GET", conversationPath(id, "/screen"), query, accept = "image/jpeg").body
        if (!image.isJpeg()) throw CloudInvalidResponse()
        return image
    }

    suspend fun imagesAvailable(): Boolean = get<ChatImageAvailability>(IMAGES, timeoutMillis = 15_000).available

    suspend fun uploadImage(mimeType: String, bytes: ByteArray): ChatImageUploaded {
        val allowed = mimeType in IMAGE_TYPES
        if (!allowed || bytes.size !in 10..MAX_IMAGE_BYTES) {
            throw CloudInvalidResponse("تعذّر إرفاق الصورة. اختر صورة صالحة لا تتجاوز ٥ ميغابايت.")
        }
        val binding = sessionBinding() ?: throw CloudSignedOut()
        val body = withContext(Dispatchers.Default) {
            CloudJson.encode(ChatImageUpload(mimeType, Base64.getEncoder().encodeToString(bytes)))
        }
        if (body.size > MAX_IMAGE_REQUEST_BYTES) throw CloudInvalidResponse("حجم مرفق الصورة أكبر من الحد المسموح.")
        return decode(send("POST", IMAGES, body = body, timeoutMillis = 90_000, expectedBinding = binding))
    }

    suspend fun image(id: String): ByteArray =
        send("GET", "$IMAGES/${checkedId(id)}", accept = "image/*").body

    private fun setSession(cookie: SessionCookie?) {
        session = cookie?.let(::ActiveSession)
        accountAccess.value = null
        account.value = session != null
    }

    private suspend fun send(
        method: String,
        path: String,
        query: Map<String, String> = emptyMap(),
        body: ByteArray? = null,
        key: String? = null,
        timeoutMillis: Int = 30_000,
        accept: String = "application/json",
        authenticated: Boolean = true,
        expectedBinding: String? = null,
        cookieOverride: SessionCookie? = null,
    ): CloudResponse {
        val active = if (authenticated) synchronized(sessionLock) {
            val found = session ?: throw CloudSignedOut()
            if (expectedBinding != null && found.binding != expectedBinding) throw CloudSignedOut()
            if (path != ACCESS) requireChatAccess(path)
            found
        } else null
        val cookie = active?.cookie ?: cookieOverride
        val headers = buildMap {
            put("Accept", accept)
            if (method != "GET") put("Origin", CLOUD_ORIGIN)
            if (body != null) put("Content-Type", "application/json")
            if (cookie != null) put("Cookie", cookie.header)
            if (key != null) put("Idempotency-Key", key)
        }
        val reply = transport.execute(CloudRequest(method, path, query, headers, body, timeoutMillis))
        if (active != null && active !== session) throw CloudSignedOut()
        if (reply.status !in 200..299) {
            val error = CloudHttpError.from(reply.status, reply.body)
            if (reply.status == 401 && cookie != null && error.code != SERVICE_UNAUTHORIZED) {
                if (active != null) invalidate(active)
                throw CloudSignedOut()
            }
            throw error
        }
        return reply
    }

    private fun requireChatAccess(path: String) {
        val account = accountAccess.value ?: throw CloudInvalidResponse("تعذّر التحقق من صلاحيات الحساب. أعد المحاولة.")
        // https://github.com/ahmadalwakai/Mohassan-AI/blob/29448ae/apps/server/src/members.ts#L35-L64 (retrieved 2026-11-27).
        val ownerOnly = path == IMAGES || path.startsWith("$IMAGES/") || path.endsWith("/feedback")
        if (!account.canChat || ownerOnly && !account.isOwner) throw CloudHttpError.memberForbidden()
    }

    private suspend fun invalidate(active: ActiveSession) = withContext(Dispatchers.IO + NonCancellable) {
        synchronized(sessionLock) {
            if (active === session) {
                setSession(null)
                runCatching { vault.clear() }
            }
        }
    }

    private suspend inline fun <reified Response> get(
        path: String,
        query: Map<String, String> = emptyMap(),
        timeoutMillis: Int = 30_000,
    ): Response = decode(send("GET", path, query, timeoutMillis = timeoutMillis))

    private suspend inline fun <reified Body, reified Response> post(
        path: String,
        body: Body,
        timeoutMillis: Int,
    ): Response = decode(send("POST", path, body = CloudJson.encode(body), timeoutMillis = timeoutMillis))

    private inline fun <reified Response> decode(reply: CloudResponse): Response = try {
        CloudJson.decode(reply.body)
    } catch (error: IllegalArgumentException) {
        throw CloudInvalidResponse(cause = error)
    } catch (error: CharacterCodingException) {
        throw CloudInvalidResponse(cause = error)
    }

    private fun conversationPath(id: String, suffix: String = "") = "$CONVERSATIONS/${checkedId(id)}$suffix"

    private fun checkedId(id: String): String {
        require(isUuid(id))
        return id
    }

    companion object {
        const val CONVERSATIONS = "/api/chat/conversations"
        const val MAX_IMAGE_BYTES = 5 * 1024 * 1024
        const val MAX_IMAGE_REQUEST_BYTES = 7_500_000
        private const val ACCESS = "/api/access"
        private const val IMAGES = "/api/chat/images"
        private const val SERVICE_UNAUTHORIZED = "SERVICE_UNAUTHORIZED"
        private val IMAGE_TYPES = setOf("image/jpeg", "image/png", "image/webp")
        private val KEYED_PATH = Regex("$CONVERSATIONS/[0-9a-fA-F]{8}-(?:[0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}/(?:messages|respond|approve)")
        private val KEY_PATTERN = Regex("[a-zA-Z0-9_-]{8,128}")
        private val CHAT_VERSION = Regex("[0-9a-f]{24}")
    }
}
