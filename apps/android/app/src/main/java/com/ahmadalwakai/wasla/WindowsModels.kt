package com.ahmadalwakai.wasla

import kotlinx.serialization.Serializable
import java.time.Instant
import java.time.format.DateTimeParseException
import java.util.Base64

@Serializable data class WindowsTarget(val key: String, val mode: String, val title: String, val width: Int, val height: Int)
@Serializable data class WindowsState(
    val approvalNonce: String,
    val safeDesktop: Boolean,
    val localView: Boolean,
    val localControl: Boolean,
    val target: WindowsTarget?,
    val status: String,
)
@Serializable data class WindowsGrant(val id: String, val scope: String, val targetKey: String, val approvalNonce: String, val expiresAt: String) {
    val controls: Boolean get() = scope == "control"
    val expiry: Instant? get() = parseWindowsTime(expiresAt)
}
@Serializable data class WindowsDevice(
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
@Serializable data class WindowsFrame(val id: String, val targetKey: String, val capturedAt: String, val width: Int, val height: Int, val jpeg: String) {
    fun imageData(): ByteArray? {
        val bytes = try { Base64.getDecoder().decode(jpeg) } catch (error: IllegalArgumentException) { return null }
        return bytes.takeIf(::isJpeg)
    }
}
@Serializable data class WindowsFrameReply(val frame: WindowsFrame, val grant: WindowsGrant)
@Serializable data class WindowsActionRequest(val grantId: String, val nonce: String, val frameId: String, val action: WindowsAction)
@Serializable data class WindowsActionReply(val id: String, val status: String)

@Serializable
data class WindowsAction private constructor(
    val type: String,
    val x: Double? = null,
    val y: Double? = null,
    val button: String? = null,
    val text: String? = null,
    val key: String? = null,
    val delta: Int? = null,
) {
    companion object {
        fun click(x: Double, y: Double, right: Boolean = false): WindowsAction =
            WindowsAction("click", x.coerceIn(0.0, 1.0), y.coerceIn(0.0, 1.0), if (right) "right" else "left")

        fun scroll(delta: Int): WindowsAction = WindowsAction("scroll", delta = delta.coerceIn(-3, 3))
        fun text(value: String): WindowsAction = WindowsAction("text", text = value)
        fun key(value: String): WindowsAction = WindowsAction("key", key = value)
        fun textFits(value: String): Boolean = value.length in 1..120 && value.none { it.code < 32 || it.code == 127 }
    }
}

internal fun isJpeg(bytes: ByteArray): Boolean = bytes.size >= 4 &&
    bytes[0] == 0xff.toByte() && bytes[1] == 0xd8.toByte() &&
    bytes[bytes.lastIndex - 1] == 0xff.toByte() && bytes.last() == 0xd9.toByte()

internal fun parseWindowsTime(value: String): Instant? = try { Instant.parse(value) } catch (error: DateTimeParseException) { null }

internal object RemoteTiming {
    const val RENEW_EVERY_MS = 15_000L
    const val FRAME_EVERY_MS = 900L
    private const val CONTROL_SECONDS = 120
    private const val VIEW_SECONDS = 30
    private const val RENEW_BELOW_SECONDS = 35L

    fun shouldRenew(grant: WindowsGrant?, now: Instant): Boolean =
        grant?.takeIf { it.controls }?.expiry?.isBefore(now.plusSeconds(RENEW_BELOW_SECONDS)) ?: true

    fun request(state: WindowsState, control: Boolean): WindowsGrantRequest? = state.target?.let { target ->
        WindowsGrantRequest(
            scope = if (control) "control" else "view",
            durationSeconds = if (control) CONTROL_SECONDS else VIEW_SECONDS,
            targetKey = target.key,
            approvalNonce = state.approvalNonce,
        )
    }
}

sealed class RemoteReadiness(val title: String, val advice: String) {
    val on: Boolean get() = this is Active
    val canTurnOn: Boolean get() = this is Ready || this is Active

    data object Disabled : RemoteReadiness("التحكم بـ Windows متوقف على الخادم", "")
    data object NoDevice : RemoteReadiness(
        "لا يوجد كمبيوتر مرتبط",
        "اضغط «ربط كمبيوتر»، ثم ألصق الرمز في برنامج Mohassan Companion على الكمبيوتر خلال دقيقتين.",
    )
    data class Offline(val name: String) : RemoteReadiness(
        "$name غير متصل الآن",
        "شغّل Mohassan Companion على الكمبيوتر وتأكد من اتصاله بالإنترنت.",
    )
    data class Unsafe(val name: String) : RemoteReadiness(
        "$name مقفل أو على شاشة محمية",
        "افتح قفل الكمبيوتر واسمح بالمشاهدة والتحكم من جديد.",
    )
    data class NeedsLocalView(val name: String) : RemoteReadiness(
        "يلزم السماح على $name",
        "اختر النافذة وفعّل الموافقة المحلية على المشاهدة والإدخال في Mohassan Companion.",
    )
    data class NeedsLocalControl(val name: String) : RemoteReadiness(
        "يلزم السماح على $name",
        "فعّل الموافقة المحلية على الإدخال ضمن النطاق المحدد في Mohassan Companion.",
    )
    data class Ready(val device: WindowsDevice) : RemoteReadiness(
        "جاهز: ${device.name}",
        "شغّل المفتاح ليتحكم هذا الهاتف وموحسن بالنافذة المسموحة على الكمبيوتر.",
    )
    data class Active(val device: WindowsDevice, val grant: WindowsGrant) : RemoteReadiness(
        "التحكم مفعّل: ${device.name}",
        "يتجدد الإذن ما دام المفتاح مشغّلًا والتطبيق مفتوحًا.",
    )

    companion object {
        fun device(overview: WindowsOverview, preferred: String?): WindowsDevice? {
            val linked = overview.devices.filterNot { it.revoked }
            return linked.firstOrNull { it.id == preferred } ?: linked.firstOrNull { it.online } ?: linked.firstOrNull()
        }

        fun of(overview: WindowsOverview, preferred: String?): RemoteReadiness {
            if (!overview.enabled) return Disabled
            val device = device(overview, preferred) ?: return NoDevice
            if (!device.online) return Offline(device.name)
            val state = device.state?.takeIf { it.safeDesktop } ?: return Unsafe(device.name)
            if (!state.localView || state.target == null) return NeedsLocalView(device.name)
            if (!state.localControl) return NeedsLocalControl(device.name)
            val grant = device.grant?.takeIf { it.controls && it.targetKey == state.target.key && it.approvalNonce == state.approvalNonce }
            return if (grant == null) Ready(device) else Active(device, grant)
        }
    }
}
