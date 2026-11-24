package com.ahmadalwakai.wasla

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import java.net.URI
import java.net.URLDecoder
import java.time.Instant
import java.time.format.DateTimeParseException
import java.util.Base64
import java.util.UUID

/** Cloud responses can acquire new fields without changing what this app can display. */
val WaslaJson: Json = Json {
    ignoreUnknownKeys = true
    explicitNulls = false
    classDiscriminator = "type"
}

object CloudJson {
    inline fun <reified T> encode(value: T): ByteArray =
        WaslaJson.encodeToString(value).encodeToByteArray()

    inline fun <reified T> decode(body: ByteArray): T =
        WaslaJson.decodeFromString(body.decodeToString(throwOnInvalidSequence = true))
}

private val UUID_PATTERN = Regex("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")

fun isUuid(value: String?): Boolean = value != null && UUID_PATTERN.matches(value)

fun newRequestId(): String = UUID.randomUUID().toString()

fun String.codePointLength(): Int = codePointCount(0, length)

/** The chat contract limits messages to 4,000 UTF-16 units. */
fun mohassanTextFits(text: String): Boolean = text.length <= 4_000

/** An HTTPS URL with a host and no credentials, control characters or backslashes. */
fun safeHttpsUrl(value: String?): String? {
    if (value.isNullOrBlank() || '\\' in value || value.any { it.isWhitespace() || it.isISOControl() }) return null
    val uri = runCatching { URI(value) }.getOrNull() ?: return null
    if (!"https".equals(uri.scheme, ignoreCase = true) || uri.host.isNullOrEmpty() || uri.rawUserInfo != null) return null
    return uri.toString()
}

fun hostOf(url: String?): String = runCatching { URI(url.orEmpty()).host }.getOrNull().orEmpty()

@Serializable data class SignInBody(val email: String, val password: String)
@Serializable
data class SignInReply(val user: User? = null) {
    @Serializable data class User(val email: String? = null, val name: String? = null)
}
@Serializable data object EmptyBody
@Serializable data class OkReply(val ok: Boolean? = null)

object ChatStatus {
    const val IDLE = "idle"
    const val RUNNING = "running"
    const val WAITING_USER = "waiting_user"
    const val WAITING_INPUT = "waiting_input"
    const val WAITING_APPROVAL = "waiting_approval"
    const val FAILED = "failed"
    const val CANCELLED = "cancelled"
    private val waiting = setOf(WAITING_USER, WAITING_INPUT, WAITING_APPROVAL)

    fun isWaiting(status: String): Boolean = status in waiting

    fun title(status: String): String = when (status) {
        RUNNING -> "موحسن يعمل…"
        WAITING_USER -> "ينتظر إجابتك"
        WAITING_INPUT -> "ينتظر خطوة منك"
        WAITING_APPROVAL -> "ينتظر موافقتك"
        FAILED -> "تعذّر الإكمال"
        CANCELLED -> "أُوقف"
        else -> "جاهز"
    }
}

@Serializable data class ChatOption(val id: String, val label: String)
@Serializable data class ChatSuggestion(val label: String, val reason: String? = null)
@Serializable
data class ChatField(
    val id: String,
    val prompt: String,
    val suggestions: List<ChatSuggestion> = emptyList(),
    val multiple: Boolean? = null,
    val multiline: Boolean? = null,
    val initialValue: String? = null,
    val selected: List<Int>? = null,
    val placeholder: String? = null,
) {
    val allowsSeveral: Boolean get() = multiple == true
    val keepsLines: Boolean get() = multiline == true
    val preselected: Set<Int> get() = selected.orEmpty().filterTo(mutableSetOf()) { it in suggestions.indices }
}

/** Older conversations can still carry a clarification. */
@Serializable
data class ChatClarification(
    val reason: String = "",
    val recommendedOptionId: String? = null,
    val allowText: Boolean = false,
)

@Serializable
data class ChatQuestion(
    val id: String,
    val prompt: String,
    val options: List<ChatOption> = emptyList(),
    val action: String? = null,
    val fields: List<ChatField>? = null,
    val clarification: ChatClarification? = null,
) {
    val phoneOptions: List<ChatOption>
        get() = if (action == "google_ads_connect") options.filter { it.id != "connect" } else options
    val phoneFields: List<ChatField> get() = fields.orEmpty()
    val hasFields: Boolean get() = phoneFields.isNotEmpty()
    val acceptsText: Boolean get() = !hasFields && (clarification?.allowText ?: options.isEmpty())
    val stopOption: ChatOption? get() = options.firstOrNull { it.id == "stop" }
}

@Serializable
data class ChatApproval(
    val id: String,
    val prompt: String,
    val detail: String = "",
    val target: String? = null,
    val consequence: String? = null,
    val reversible: Boolean? = null,
) {
    val bindingLines: List<String> get() = listOfNotNull(
        target?.takeIf { it.isNotBlank() }?.let { "الهدف: $it" },
        consequence?.takeIf { it.isNotBlank() }?.let { "ما سيحدث: $it" },
        reversible?.let { if (it) "يمكن التراجع عنه." else "لا يمكن التراجع عنه." },
    )
}

@Serializable data class ChatSecureField(val id: String, val label: String, val type: String)
@Serializable
data class ChatSecure(
    val id: String,
    val kind: String,
    val site: String,
    val prompt: String,
    val note: String? = null,
    val fields: List<ChatSecureField> = emptyList(),
) {
    val handsOn: Boolean get() = kind == "hands_on"
}

@Serializable data class ChatImageRef(val id: String, val width: Int, val height: Int)
@Serializable
data class ChatMessage(
    val id: String,
    val role: String,
    val text: String,
    val createdAt: String? = null,
    val images: List<ChatImageRef>? = null,
) {
    val mine: Boolean get() = role == "user"
}

@Serializable data class ChatStep(val id: String, val text: String)

@Serializable
data class ChatBrowser(val url: String, val title: String, val live: Boolean, val screenUrl: String) {
    val host: String get() = hostOf(url).ifEmpty { url }

    /** Accept only this conversation's own relative screenshot path. */
    fun screenQuery(conversationId: String): Map<String, String>? {
        val uri = runCatching { URI(screenUrl) }.getOrNull() ?: return null
        if (uri.scheme != null || uri.rawAuthority != null || uri.rawFragment != null ||
            uri.rawPath != "/api/chat/conversations/$conversationId/screen"
        ) return null
        val version = uri.rawQuery.orEmpty().split('&').firstOrNull { it.startsWith("v=") }
            ?.substringAfter('=')?.let { URLDecoder.decode(it, "UTF-8") }
        return if (version == null) emptyMap() else mapOf("v" to version)
    }

    fun screenVersion(conversationId: String): String? = screenQuery(conversationId)?.get("v")
}

@Serializable
data class ChatCapabilities(val chatModel: Boolean, val available: List<String>) {
    val localModeText: String?
        get() {
            if (chatModel) return null
            val supported = available.mapNotNull(labels::get)
            val header = "لا يتصل بهذه الجلسة نموذج لغوي، فالردود الحرة غير متاحة."
            return if (supported.isEmpty()) header else "$header ما يعمل الآن دون نموذج: ${supported.joinToString("، ")}."
        }

    private companion object {
        val labels = mapOf(
            "computation" to "الحساب", "web" to "البحث في الويب", "browser" to "فتح الصفحات وقراءتها",
            "memory" to "الذاكرة", "knowledge" to "مستنداتك المحفوظة", "documents" to "ملفات PDF",
            "sites" to "بناء المواقع", "skills" to "المهارات المفعّلة", "planner" to "تخطيط الأسبوع",
            "letters" to "قوالب الرسائل", "imageReading" to "قراءة النص في الصور", "ads" to "إعلانات Google",
            "pc" to "التحكم بالكمبيوتر",
        )
    }
}

@Serializable data class ChatSummary(val id: String, val title: String, val status: String, val updatedAt: String)
@Serializable
data class ChatList(
    val conversations: List<ChatSummary>,
    val capabilities: ChatCapabilities? = null,
    val requestKeys: Boolean? = null,
)

@Serializable
data class ChatConversation(
    val id: String,
    val title: String = "",
    val status: String,
    val updatedAt: String = "",
    val messages: List<ChatMessage> = emptyList(),
    val question: ChatQuestion? = null,
    val approval: ChatApproval? = null,
    val secure: ChatSecure? = null,
    val browser: ChatBrowser? = null,
    val progress: String? = null,
    val steps: List<ChatStep> = emptyList(),
    val error: String? = null,
    val capabilities: ChatCapabilities? = null,
    val version: String? = null,
    val olderMessages: Int? = null,
) {
    val working: Boolean get() = status == ChatStatus.RUNNING
    val waiting: Boolean get() = ChatStatus.isWaiting(status)
    val fieldsQuestion: ChatQuestion? get() = question?.takeIf { status == ChatStatus.WAITING_USER && it.hasFields }
}

@Serializable data class ChatCreate(val goal: String? = null, val images: List<String>? = null)
@Serializable data class ChatFieldAnswer(val fieldId: String, val value: String)
@Serializable
data class ChatSend(
    val text: String,
    val questionId: String? = null,
    val answers: List<ChatFieldAnswer>? = null,
    val images: List<String>? = null,
)
@Serializable data class ChatRespond(val questionId: String, val optionId: String)
@Serializable data class ChatApprove(val approvalId: String, val approved: Boolean)
@Serializable data class ChatFeedback(val messageId: String, val verdict: String, val note: String? = null)
@Serializable data class ChatSecureSubmit(val requestId: String, val action: String, val values: Map<String, String>? = null)
@Serializable data class ChatImageUpload(val mimeType: String, val data: String)
@Serializable data class ChatImageAvailability(val available: Boolean)
@Serializable data class ChatImageUploaded(val id: String, val width: Int, val height: Int)

@Serializable data class WindowsTarget(val key: String, val mode: String, val title: String, val width: Int, val height: Int)
@Serializable
data class WindowsState(
    val approvalNonce: String,
    val safeDesktop: Boolean,
    val localView: Boolean,
    val localControl: Boolean,
    val target: WindowsTarget? = null,
    val status: String,
)

@Serializable
data class WindowsGrant(val id: String, val scope: String, val targetKey: String, val approvalNonce: String, val expiresAt: String) {
    val controls: Boolean get() = scope == "control"
    val expiry: Instant? get() = try {
        Instant.parse(expiresAt)
    } catch (_: DateTimeParseException) {
        null
    }
}

@Serializable
data class WindowsDevice(
    val id: String,
    val name: String,
    val revoked: Boolean,
    val online: Boolean,
    val lastSeenAt: String? = null,
    val state: WindowsState? = null,
    val grant: WindowsGrant? = null,
)

@Serializable data class WindowsOverview(val enabled: Boolean, val devices: List<WindowsDevice>)
@Serializable data class WindowsPairing(val id: String, val code: String, val expiresAt: String)
@Serializable data class WindowsGrantRequest(val scope: String, val durationSeconds: Int, val targetKey: String, val approvalNonce: String)
@Serializable
data class WindowsFrame(
    val id: String,
    val targetKey: String,
    val capturedAt: String,
    val width: Int,
    val height: Int,
    val jpeg: String,
) {
    val imageData: ByteArray?
        get() = runCatching { Base64.getDecoder().decode(jpeg) }.getOrNull()?.takeIf(ByteArray::isJpeg)
}

internal fun ByteArray.isJpeg(): Boolean = size >= 4 &&
    this[0] == 0xff.toByte() && this[1] == 0xd8.toByte() &&
    this[size - 2] == 0xff.toByte() && this[size - 1] == 0xd9.toByte()

@Serializable data class WindowsFrameReply(val frame: WindowsFrame, val grant: WindowsGrant)

@Serializable
sealed interface WindowsAction {
    @Serializable
    @SerialName("click")
    @ConsistentCopyVisibility
    data class Click private constructor(val x: Double, val y: Double, val button: String) : WindowsAction {
        constructor(x: Double, y: Double, right: Boolean = false) : this(
            x.coerceIn(0.0, 1.0), y.coerceIn(0.0, 1.0), if (right) "right" else "left",
        )
    }

    @Serializable
    @SerialName("text")
    data class Text(@SerialName("text") val value: String) : WindowsAction

    @Serializable
    @SerialName("key")
    data class Key(@SerialName("key") val value: String) : WindowsAction

    @Serializable
    @SerialName("scroll")
    @ConsistentCopyVisibility
    data class Scroll private constructor(val delta: Int) : WindowsAction {
        companion object {
            operator fun invoke(delta: Int): Scroll = Scroll(delta.coerceIn(-3, 3))
        }
    }

    companion object {
        val keys = listOf(
            "Enter", "Tab", "Escape", "Backspace", "Delete", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown",
            "Home", "End", "PageUp", "PageDown", "Space",
        )

        fun textFits(value: String): Boolean = value.length in 1..120 && value.none { it.code < 0x20 || it.code == 0x7f }
    }
}

@Serializable data class WindowsActionRequest(val grantId: String, val nonce: String, val frameId: String, val action: WindowsAction)
@Serializable data class WindowsActionReply(val id: String, val status: String)
