package com.ahmadalwakai.wasla

import kotlinx.serialization.Serializable
import kotlinx.serialization.Transient
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import java.net.URI
import java.util.UUID

// The wire shapes of the Wasla service on the computer (apps/wasla-service/wasla/server.py)
// and of Mohassan's chat behind it (packages/contracts/src/command-chat.ts). Unknown
// fields are ignored, so newer servers stay readable; absent optional fields are left out
// of requests, as the service checks the exact field set.

/** One JSON configuration for every request and response. */
val WaslaJson: Json = Json {
    ignoreUnknownKeys = true
    explicitNulls = false
    coerceInputValues = true
}

private val UUID_PATTERN = Regex("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")

fun isUuid(value: String?): Boolean = value != null && UUID_PATTERN.matches(value)

fun newRequestId(): String = UUID.randomUUID().toString().lowercase()

/** Counts what the computer counts: Unicode code points, as Python does. */
fun String.codePoints(): Int = codePointCount(0, length)

class WaslaException(val kind: Kind, message: String, val status: Int = 0) : Exception(message) {
    enum class Kind { INVALID_ADDRESS, INVALID_FINGERPRINT, INVALID_PAIRING_CODE, INVALID_RESPONSE, NOT_PAIRED, CERTIFICATE, STORAGE, SERVER, MESSAGE, NETWORK }

    val isServer404: Boolean get() = kind == Kind.SERVER && status == 404

    companion object {
        fun invalidAddress() = WaslaException(Kind.INVALID_ADDRESS, "أدخل عنوان HTTPS فقط، دون اسم مستخدم أو مسار أو معاملات إضافية.")
        fun invalidFingerprint() = WaslaException(Kind.INVALID_FINGERPRINT, "بصمة الشهادة يجب أن تتكون من 64 حرفًا من الأرقام والحروف a–f. انسخها من شاشة الكمبيوتر الموثوقة.")
        fun invalidPairingCode() = WaslaException(Kind.INVALID_PAIRING_CODE, "أدخل رمز الربط من ٨ أرقام كما يظهر على الكمبيوتر.")
        fun invalidResponse() = WaslaException(Kind.INVALID_RESPONSE, "وصل رد غير متوقع من الكمبيوتر.")
        fun notPaired() = WaslaException(Kind.NOT_PAIRED, "اربط الكمبيوتر أولًا.")
        fun certificate() = WaslaException(Kind.CERTIFICATE, "تعذّر التحقق من هوية الكمبيوتر أو صلاحية شهادته. راجع العنوان والبصمة والوقت على الجهازين.")
        fun storage(detail: String) = WaslaException(Kind.STORAGE, "تعذّر حفظ بيانات الاقتران في المخزن الآمن ($detail).")
        fun server(status: Int, message: String) = WaslaException(Kind.SERVER, message, status)
        fun message(text: String) = WaslaException(Kind.MESSAGE, text)
        fun network() = WaslaException(Kind.NETWORK, "تعذّر الوصول إلى الكمبيوتر. شغّل خدمة موحسن وTailscale على الكمبيوتر، وتأكد من اتصال Tailscale على الهاتف.")
    }
}

/** The paired computer: its HTTPS address, the SHA-256 of its certificate, and the device id it gave this phone. */
@Serializable
data class ServerIdentity(val baseUrl: String, val fingerprint: String, val deviceId: String = "", val name: String = "الكمبيوتر") {
    /** The host as the certificate names it: lowercase, an IPv6 address without brackets. */
    val host: String get() = URI(baseUrl).host.orEmpty().trim('[', ']').lowercase()
    val port: Int get() = URI(baseUrl).port.let { if (it == -1) 443 else it }

    companion object {
        fun validate(address: String, fingerprint: String, deviceId: String = "", name: String = "الكمبيوتر"): ServerIdentity {
            val clean = address.trim()
            if (clean.isEmpty() || '\\' in clean || '%' in clean || clean.any { it.isWhitespace() || it.code < 32 }) throw WaslaException.invalidAddress()
            val uri = try { URI(clean) } catch (_: Exception) { throw WaslaException.invalidAddress() }
            val host = uri.host
            if (!"https".equals(uri.scheme, ignoreCase = true) || host.isNullOrEmpty() || uri.rawUserInfo != null
                || uri.rawQuery != null || uri.rawFragment != null || !(uri.rawPath.isNullOrEmpty() || uri.rawPath == "/")
                || (uri.port != -1 && uri.port !in 1..65535)) throw WaslaException.invalidAddress()
            val pin = fingerprint.trim().lowercase()
            if (pin.length != 64 || !pin.all { it in '0'..'9' || it in 'a'..'f' }) throw WaslaException.invalidFingerprint()
            val normalized = "https://" + host.lowercase() + if (uri.port == -1) "" else ":${uri.port}"
            return ServerIdentity(normalized, pin, deviceId, name)
        }
    }
}

/** The computer shipped inside this build (assets/ConnectionDefaults.json), the same file as the iOS app. */
@Serializable
data class BundledConnection(val server_url: String, val certificate_sha256: String, val computer_name: String) {
    companion object {
        fun decode(json: String): ServerIdentity {
            val settings = WaslaJson.decodeFromString(serializer(), json)
            return ServerIdentity.validate(settings.server_url, settings.certificate_sha256, name = settings.computer_name)
        }
    }
}

object PairingCode {
    private const val LOCALIZED_DIGITS = "٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹"

    /** Arabic-Indic and Persian digits become ASCII; leading zeros stay. */
    fun normalized(value: String): String = value.trim().map { char ->
        val index = LOCALIZED_DIGITS.indexOf(char)
        if (index >= 0) '0' + (index % 10) else char
    }.joinToString("")

    /** Eight digits from the Windows panel, or a longer token from an older computer service. */
    fun isValid(value: String): Boolean {
        val bytes = normalized(value).toByteArray(Charsets.UTF_8)
        if (bytes.size == 8 && bytes.all { it.toInt() in 48..57 }) return true
        return bytes.size in 16..512 && bytes.all { it.toInt() in 33..126 }
    }
}

/** An https URL with a host and no credentials, control characters or backslashes; anything else is not opened. */
fun safeHttpsUrl(value: String?): String? {
    if (value.isNullOrBlank() || '\\' in value || value.any { it.code < 32 || it.code == 127 }) return null
    val uri = try { URI(value) } catch (_: Exception) { return null }
    if (!"https".equals(uri.scheme, ignoreCase = true) || uri.host.isNullOrEmpty() || uri.rawUserInfo != null) return null
    return uri.toString()
}

fun hostOf(url: String?): String = try { URI(url ?: "").host ?: "" } catch (_: Exception) { "" }

// MARK: - Pairing and status

@Serializable data class PairRequest(val code: String, val device_name: String)
@Serializable data class PairResponse(val token: String, val device_id: String, val name: String = "الكمبيوتر")
@Serializable data class ServerFault(val error: Detail = Detail()) {
    @Serializable data class Detail(val code: String = "", val message: String = "")
}
/** `{}` on the wire; also reads any acknowledgement whose fields do not matter. */
@Serializable class EmptyBody

sealed class BusyState {
    data object Idle : BusyState()
    data class Working(val name: String) : BusyState()

    val isBusy: Boolean get() = this !is Idle
    val label: String get() = (this as? Working)?.name ?: "جاهز"

    companion object {
        /** The service sends null, a boolean or the name of the running task. */
        fun from(element: JsonElement?): BusyState {
            if (element == null || element is JsonNull) return Idle
            val primitive = element as? JsonPrimitive ?: return Working("الجهاز مشغول")
            if (primitive.isString) return if (primitive.content.isEmpty()) Idle else Working(primitive.content)
            primitive.booleanOrNull?.let { return if (it) Working("الجهاز مشغول") else Idle }
            return Working("الجهاز مشغول")
        }
    }
}

@Serializable data class DesktopInfo(val width: Int = 0, val height: Int = 0, val monitor: String? = null, val error: String? = null)
@Serializable
data class ServerStatus(
    val name: String = "Wasla Windows",
    val model: String = "",
    val busy: JsonElement? = null,
    val desktop_enabled: Boolean = false,
    val desktop: DesktopInfo? = null,
    val app_actions_enabled: Boolean? = null,
) {
    val busyState: BusyState get() = BusyState.from(busy)
}

// MARK: - The local fallback chat (/v1/chat), used only while Mohassan is not linked

@Serializable
data class ChatMessage(val role: String, val content: String) {
    @Transient val id: String = UUID.randomUUID().toString()
}

enum class ChatMode(val wire: String, val title: String) {
    AUTOMATIC("auto", "تلقائي"), LIVE_WEB("live_web", "بحث مباشر"), LOCAL("local", "محلي")
}

@Serializable
data class ChatRequest(
    val messages: List<ChatMessage>,
    val request_id: String,
    val mode: String,
    val remember: Boolean,
    val use_memory: Boolean,
    val conversation_id: String? = null,
)

@Serializable
data class ChatSource(val id: String = "", val title: String = "", val url: String? = null, val snippet: String? = null) {
    val safeUrl: String? get() = safeHttpsUrl(url)
}

@Serializable
data class ChatEvidence(val level: String = "", val note: String? = null) {
    val title: String get() = when (level) {
        "grounded" -> "مستندة إلى أدلة"
        "limited" -> "أدلة محدودة"
        "unverified" -> "تحتاج تحققًا"
        else -> "حالة الأدلة غير محددة"
    }
}

@Serializable
data class ChatResponse(
    val content: String = "",
    val model: String = "",
    val route: String? = null,
    val sources: List<ChatSource>? = null,
    val evidence: ChatEvidence? = null,
    val warnings: List<String>? = null,
    val timing_ms: Double? = null,
    val cache_hit: Boolean? = null,
    val memory_saved: Boolean? = null,
    val conversation_id: String? = null,
) {
    val routeTitle: String? get() = when (route) {
        null -> null
        "calculator" -> "حساب مباشر"
        "unit_conversion" -> "تحويل وحدات"
        "knowledge" -> "المعرفة المحفوظة"
        "research", "live_web" -> "بحث بمصادر"
        "local" -> "النموذج المحلي"
        "actions" -> "إجراء في التطبيق"
        "cloud" -> "محرك سحابي"
        else -> route
    }

    companion object {
        fun warningMessage(code: String): String = when (code) {
            "source_instructions_ignored" -> "استُبعدت تعليمات غير مرتبطة بسؤالك وردت داخل بعض المصادر."
            "duplicate_or_similar_sources_omitted" -> "استُبعدت المصادر المكررة أو شديدة التشابه."
            "knowledge_version_unavailable" -> "تعذّر التأكد من آخر تحديث للمعرفة المحفوظة."
            "invalid_conversion" -> "تعذّر تحويل هذه الوحدات. راجع الوحدات والقيمة."
            "invalid_calculation" -> "تعذّر حساب هذا التعبير. راجع الأرقام والعمليات المطلوبة."
            "knowledge_unavailable" -> "تعذّر الوصول إلى معرفتك المحفوظة لهذه الإجابة."
            "knowledge_not_configured" -> "استخدام المعرفة المحفوظة غير مهيأ في اتصالك الحالي."
            "search_query_truncated_to_400_characters" -> "استخدم البحث الجزء الأول من سؤالك الطويل."
            "search_query_simplified" -> "بُسّطت صياغة البحث للتركيز على موضوع سؤالك."
            "search_unavailable" -> "تعذّر البحث في الإنترنت الآن. لم يتأكد الحصول على معلومات حديثة."
            "possible_source_conflict" -> "قد توجد أرقام غير متفقة في المقتطفات؛ لم يتأكد سبب الاختلاف."
            "summary_unavailable" -> "تعذّر إعداد ملخص. يمكنك مراجعة مقتطفات المصادر المعروضة."
            "draft_rejected_or_insufficient_evidence" -> "تعذّر تقديم خلاصة مدعومة بما يكفي، لذا عُرضت مقتطفات المصادر."
            "search_total_cost_not_determined_from_usage" -> "التكلفة الإجمالية للبحث السحابي غير متاحة في بيانات الاستخدام."
            "unsupported_links_rejected" -> "لم تُعرض إجابة احتوت على روابط لم تُرجعها خدمة البحث."
            "insufficient_web_citations" -> "لم تتوفر استشهادات ويب كافية لدعم الإجابة."
            "memory_save_failed" -> "وصلت الإجابة، لكن لم يتأكد حفظ المحادثة."
            "usage_record_failed" -> "لم يتأكد تحديث إحصاءات الاستخدام لهذه الإجابة."
            else -> "تفاصيل الأدلة محدودة. راجع المصادر قبل الاعتماد على الإجابة."
        }
    }
}

// MARK: - Images and search

@Serializable data class ImagePreparation(val description: String, val style: String)
@Serializable data class PreparedImage(val prompt: String, val negative_prompt: String, val seed: Long)
@Serializable data class ImageRequest(val prompt: String, val negative_prompt: String, val seed: Long, val request_id: String)
@Serializable data class ImageJob(val request_id: String? = null, val status: String = "", val image_url: String? = null, val error: String? = null)
@Serializable data class SearchRequest(val query: String)
@Serializable
data class SearchResult(val title: String = "", val url: String = "", val snippet: String = "") {
    val safeUrl: String? get() = safeHttpsUrl(url)
}
@Serializable data class SearchResponse(val query: String = "", val results: List<SearchResult> = emptyList(), val provider: String = "")

// MARK: - Mohassan, through the Wasla service on the computer (/v1/mohassan/*)

@Serializable data class MohassanLink(val linked: Boolean = false, val reachable: Boolean = false, val error: String? = null)

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

@Serializable data class MohassanApproval(val id: String, val prompt: String, val detail: String = "")
@Serializable data class MohassanSecure(val id: String, val kind: String = "", val site: String = "", val prompt: String = "")
@Serializable data class MohassanMessage(val id: String, val role: String, val text: String)
@Serializable data class MohassanStep(val id: String, val text: String)
@Serializable data class MohassanSummary(val id: String, val title: String = "", val status: String = "", val updatedAt: String = "")
/** Mohassan wraps the list: `{"conversations": [...]}`. */
@Serializable data class MohassanList(val conversations: List<MohassanSummary> = emptyList())
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
) {
    val working: Boolean get() = status == MohassanStatus.RUNNING
}
@Serializable data class MohassanCreated(val id: String)
@Serializable data class MohassanCreate(val goal: String)
@Serializable data class MohassanSend(val text: String)
/** Absent values are left out, as Mohassan expects either an option or a typed answer. */
@Serializable data class MohassanRespond(val questionId: String, val optionId: String? = null, val text: String? = null)
@Serializable data class MohassanApprove(val approvalId: String, val approved: Boolean)

/** Mohassan accepts up to 4,000 UTF-16 units per message. */
fun mohassanTextFits(text: String): Boolean = text.length <= 4_000

// MARK: - Desktop control

@Serializable data class DesktopSession(val session_id: String, val expires_at: Double)
@Serializable
data class DesktopCommand(
    val action: String,
    val x: Double? = null,
    val y: Double? = null,
    val button: String? = null,
    val dy: Int? = null,
    val key: String? = null,
    val text: String? = null,
)
