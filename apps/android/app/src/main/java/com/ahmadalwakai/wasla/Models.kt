package com.ahmadalwakai.wasla

import kotlinx.serialization.Serializable
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import java.net.URI
import java.net.URLDecoder

/** Cloud responses can acquire new fields without changing what this app can display. */
val WaslaJson: Json = Json {
    ignoreUnknownKeys = true
    explicitNulls = false
}

object CloudJson {
    inline fun <reified T> encode(value: T): ByteArray =
        WaslaJson.encodeToString(value).encodeToByteArray()

    inline fun <reified T> decode(body: ByteArray): T =
        WaslaJson.decodeFromString(body.decodeToString(throwOnInvalidSequence = true))
}

private val UUID_PATTERN = Regex("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")

fun isUuid(value: String?): Boolean = value != null && UUID_PATTERN.matches(value)

fun String.codePointLength(): Int = codePointCount(0, length)

// ChatSendSchema and ChatCreateSchema, retrieved 2026-11-27.
// https://github.com/ahmadalwakai/Mohassan-AI/blob/29448ae/packages/contracts/src/command-chat.ts
fun mohassanTextFits(text: String): Boolean = text.length <= 4_000

/** An HTTPS URL with a host and no credentials, control characters or backslashes. */
fun safeHttpsUrl(value: String?): String? {
    if (value.isNullOrBlank() || '\\' in value || value.any { it.isWhitespace() || it.isISOControl() }) return null
    val uri = runCatching { URI(value) }.getOrNull() ?: return null
    if (!"https".equals(uri.scheme, ignoreCase = true) || uri.host.isNullOrEmpty() || uri.rawUserInfo != null) return null
    return uri.toString()
}

fun hostOf(url: String?): String = runCatching { URI(url.orEmpty()).host }.getOrNull().orEmpty()

@Serializable data class SignInBody(val email: String, val password: String, val rememberMe: Boolean)
@Serializable
data class SignInReply(val user: User? = null) {
    @Serializable data class User(val email: String? = null, val name: String? = null)
}
@Serializable data object EmptyBody
// Access projection and limited-member response, retrieved 2026-11-27.
// https://github.com/ahmadalwakai/Mohassan-AI/blob/29448ae/apps/server/src/members.ts
// https://github.com/ahmadalwakai/Mohassan-AI/blob/29448ae/apps/server/src/member-data-request.ts
@Serializable
data class CloudAccess(
    val user: User,
    val role: String,
    val services: List<String>,
    val dataOnly: Boolean = false,
) {
    @Serializable data class User(val id: String, val name: String, val email: String)

    val isOwner: Boolean get() = role == "owner"
    val canChat: Boolean get() = !dataOnly && (isOwner || role == "member" && "chat" in services)
}

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

@Serializable data class ChatBrowserVisibility(val canView: Boolean)

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
    val visibility: ChatBrowserVisibility? = null,
    val campaign: MohassanCampaignStream? = null,
) {
    val working: Boolean get() = status == ChatStatus.RUNNING
    val waiting: Boolean get() = ChatStatus.isWaiting(status)
    val fieldsQuestion: ChatQuestion? get() = question?.takeIf { status == ChatStatus.WAITING_USER && it.hasFields }
}

// Production supplies campaign evidence inline. Account observations remain readable from the owner's
// snapshot shape when present. Both sources retrieved 2026-11-27.
// https://github.com/ahmadalwakai/Mohassan-AI/blob/29448ae/packages/contracts/src/campaign-progress.ts
// https://github.com/ahmadalwakai/Mohassan-AI/blob/2a4498e1de09edf9c4a7b2847754d197e5146b85/apps/android/app/src/main/java/com/ahmadalwakai/wasla/Models.kt
@Serializable data class MohassanCampaignRange(val start: String, val end: String)
@Serializable data class MohassanCampaignAccount(val customerId: String, val currency: String, val timeZone: String, val range: MohassanCampaignRange, val checkedAt: String)
@Serializable data class MohassanCampaignCheck(val id: String, val passed: Boolean, val detail: String)
@Serializable data class MohassanCampaignVerification(val authority: String, val scope: String, val passed: Boolean, val checks: List<MohassanCampaignCheck> = emptyList())
@Serializable data class MohassanCampaignOperation(val operation: String, val outcome: String, val campaignResourceName: String? = null, val readAttempts: Int = 0)
@Serializable data class MohassanCampaignCompletion(val outcome: String, val campaignResourceName: String? = null)
@Serializable data class MohassanCampaignEvent(val taskId: String, val seq: Int, val type: String, val at: String = "", val data: JsonObject = JsonObject(emptyMap()))
data class MohassanCampaignObservedCheck(val value: MohassanCampaignVerification, val at: String)
@Serializable
data class MohassanCampaignStream(val taskId: String, val lastSeq: Int = 0, val events: List<MohassanCampaignEvent> = emptyList()) {
    // A replay or an unknown future event never changes a fact already recorded by the server.
    private val ordered: List<MohassanCampaignEvent> get() = events.filter { it.taskId == taskId }.distinctBy { it.seq }.sortedBy { it.seq }.let { ordered ->
        val terminal = ordered.indexOfFirst { it.type in setOf("task_completed", "task_failed", "task_cancelled") }
        if (terminal >= 0) ordered.take(terminal + 1) else ordered
    }
    val account: MohassanCampaignAccount? get() = ordered.lastOrNull { it.type == "account_observed" }?.decodeData()
    val verifications: List<MohassanCampaignObservedCheck> get() = ordered.filter { it.type == "verification_completed" }
        .mapNotNull { event -> event.decodeData<MohassanCampaignVerification>()?.let { MohassanCampaignObservedCheck(it, event.at) } }
        .groupBy { it.value.scope }.values.map { it.last() }
    val operations: List<MohassanCampaignOperation> get() = ordered.filter { it.type == "external_operation_reconciled" }
        .mapNotNull { it.decodeData<MohassanCampaignOperation>() }.groupBy { it.operation }.values.map { it.last() }
    val completion: MohassanCampaignCompletion? get() = ordered.lastOrNull { it.type == "task_completed" }?.decodeData()
}
private inline fun <reified T> MohassanCampaignEvent.decodeData(): T? = runCatching { WaslaJson.decodeFromString<T>(data.toString()) }.getOrNull()

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

internal fun ByteArray.isJpeg(): Boolean = size >= 4 &&
    this[0] == 0xff.toByte() && this[1] == 0xd8.toByte() &&
    this[size - 2] == 0xff.toByte() && this[size - 1] == 0xd9.toByte()
