package com.ahmadalwakai.wasla

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import java.net.URI
import java.util.UUID

val WaslaJson: Json = Json {
    ignoreUnknownKeys = true
    explicitNulls = false
    coerceInputValues = true
}

private val UUID_PATTERN = Regex("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")

fun isUuid(value: String?): Boolean = value != null && UUID_PATTERN.matches(value)

fun newRequestId(): String = UUID.randomUUID().toString()

/** An https URL with a host and no credentials, control characters or backslashes; anything else is not opened. */
fun safeHttpsUrl(value: String?): String? {
    if (value.isNullOrBlank() || '\\' in value || value.any { it.code < 32 || it.code == 127 }) return null
    val uri = try { URI(value) } catch (ignored: Exception) { return null }
    if (!"https".equals(uri.scheme, ignoreCase = true) || uri.host.isNullOrEmpty() || uri.rawUserInfo != null) return null
    return uri.toString()
}

fun hostOf(url: String?): String = try { URI(url ?: "").host ?: "" } catch (ignored: Exception) { "" }

@Serializable class EmptyBody
@Serializable data class OkReply(val ok: Boolean? = null, val success: Boolean? = null)

object MohassanStatus {
    const val RUNNING = "running"
    const val WAITING_USER = "waiting_user"
    const val WAITING_INPUT = "waiting_input"
    const val WAITING_APPROVAL = "waiting_approval"
    const val FAILED = "failed"
    const val CANCELLED = "cancelled"
    val WAITING = setOf(WAITING_USER, WAITING_INPUT, WAITING_APPROVAL)

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

@Serializable data class MohassanOption(val id: String, val label: String)
@Serializable data class MohassanClarification(val reason: String = "", val recommendedOptionId: String? = null, val allowText: Boolean = false)
/** One suggested answer, taken by the brain from the owner's own site or sentence. */
@Serializable data class MohassanSuggestion(val label: String, val reason: String? = null)
/** One of several questions asked together; the owner picks suggestions or writes another answer. */
@Serializable
data class MohassanField(
    val id: String,
    val prompt: String,
    val suggestions: List<MohassanSuggestion> = emptyList(),
    val multiple: Boolean? = null,
    val multiline: Boolean? = null,
    val initialValue: String? = null,
    val selected: List<Int>? = null,
    val placeholder: String? = null,
)

@Serializable
data class MohassanQuestion(
    val id: String,
    val prompt: String,
    val options: List<MohassanOption> = emptyList(),
    val action: String? = null,
    /** Older servers explain a clarification and may allow a typed answer through `respond`. */
    val clarification: MohassanClarification? = null,
    /** Newer servers ask several questions in one card; the answers go together as one numbered reply. */
    val fields: List<MohassanField>? = null,
) {
    /** Google's consent page cannot open from the phone; that option stays on the web. */
    val phoneOptions: List<MohassanOption> get() = if (action == "google_ads_connect") options.filter { it.id != "connect" } else options
    val hasFields: Boolean get() = !fields.isNullOrEmpty()
    val acceptsText: Boolean get() = !hasFields && (clarification?.allowText ?: options.isEmpty())
    val stopOption: MohassanOption? get() = options.firstOrNull { it.id == "stop" }
}

/**
 * An approval card. `target`, `consequence` and `reversible` are what the server's permission gate bound the approval to
 * (2026-11-23): the exact thing the action touches, what follows, and whether it can be undone (null: the server cannot tell).
 */
@Serializable
data class MohassanApproval(
    val id: String,
    val prompt: String,
    val detail: String = "",
    val target: String? = null,
    val consequence: String? = null,
    val reversible: Boolean? = null,
) {
    /** The card's lines about the bound action, in the order the web shows them; empty for an older server. */
    val bindingLines: List<String> get() = listOfNotNull(
        target?.takeIf { it.isNotBlank() }?.let { "الهدف: $it" },
        consequence?.takeIf { it.isNotBlank() }?.let { "ما سيحدث: $it" },
        reversible?.let { if (it) "يمكن التراجع عنه." else "لا يمكن التراجع عنه." },
    )
}
@Serializable data class MohassanSecureField(val id: String, val label: String, val type: String)
@Serializable data class MohassanSecure(
    val id: String,
    val kind: String = "",
    val site: String = "",
    val prompt: String = "",
    val note: String? = null,
    val fields: List<MohassanSecureField> = emptyList(),
)
@Serializable data class ChatImageRef(val id: String, val width: Int, val height: Int)
@Serializable data class MohassanMessage(val id: String, val role: String, val text: String, val images: List<ChatImageRef>? = null)
@Serializable data class MohassanStep(val id: String, val text: String)
@Serializable data class MohassanSummary(val id: String, val title: String = "", val status: String = "", val updatedAt: String = "")
/** Mohassan wraps the list: `{"conversations": [...]}`. */
@Serializable data class MohassanList(
    val conversations: List<MohassanSummary> = emptyList(),
    val capabilities: ChatCapabilities? = null,
    val requestKeys: Boolean? = null,
)
@Serializable
data class MohassanConversation(
    val id: String,
    val title: String = "",
    val status: String = "",
    val messages: List<MohassanMessage> = emptyList(),
    val question: MohassanQuestion? = null,
    val approval: MohassanApproval? = null,
    val secure: MohassanSecure? = null,
    val progress: String? = null,
    val steps: List<MohassanStep> = emptyList(),
    val error: String? = null,
    val version: String? = null,
    val browser: ChatBrowser? = null,
    val capabilities: ChatCapabilities? = null,
    val olderMessages: Int? = null,
) {
    val working: Boolean get() = status == MohassanStatus.RUNNING
}
@Serializable data class MohassanCreate(val goal: String? = null, val images: List<String>? = null)
@Serializable data class ChatFieldAnswer(val fieldId: String, val value: String)
@Serializable data class MohassanSend(
    val text: String,
    val questionId: String? = null,
    val answers: List<ChatFieldAnswer>? = null,
    val images: List<String>? = null,
)
@Serializable data class MohassanRespond(val questionId: String, val optionId: String)
@Serializable data class ChatSecureSubmit(val requestId: String, val action: String, val values: Map<String, String>? = null)
@Serializable data class ChatFeedback(val messageId: String, val verdict: String)
@Serializable data class ChatImageUpload(val mimeType: String, val data: String)
@Serializable data class ChatImageAvailability(val available: Boolean)
@Serializable data class ChatAttachment(val id: String, val preview: ByteArray)
@Serializable data class ChatBrowser(val url: String, val title: String, val live: Boolean, val screenUrl: String)
@Serializable data class ChatCapabilities(val chatModel: Boolean, val available: List<String>)
@Serializable data class MohassanApprove(val approvalId: String, val approved: Boolean)

/** Mohassan accepts up to 4,000 UTF-16 units per message. */
fun mohassanTextFits(text: String): Boolean = text.length <= 4_000
