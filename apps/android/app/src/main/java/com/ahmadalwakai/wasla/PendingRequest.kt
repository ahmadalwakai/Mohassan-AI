package com.ahmadalwakai.wasla

import kotlinx.coroutines.delay
import kotlinx.serialization.Serializable

@Serializable
data class PendingRequest internal constructor(
    val key: String,
    val kind: Kind,
    val conversationId: String?,
    val text: String,
    internal val body: String,
    val attachments: List<ChatAttachment> = emptyList(),
    val phase: Phase = Phase.SENDING,
    val note: String? = null,
    val createdAt: Long,
) {
    enum class Kind { CREATE, MESSAGE, FIELDS, OPTION, APPROVE }
    enum class Phase { SENDING, UNCONFIRMED }

    val fromComposer: Boolean get() = kind == Kind.CREATE || kind == Kind.MESSAGE

    internal fun belongsTo(id: String?): Boolean = conversationId == id

    internal fun request(): CloudRequest {
        val path = when (kind) {
            Kind.CREATE -> CHAT_CONVERSATIONS
            Kind.MESSAGE, Kind.FIELDS -> "$CHAT_CONVERSATIONS/$conversationId/messages"
            Kind.OPTION -> "$CHAT_CONVERSATIONS/$conversationId/respond"
            Kind.APPROVE -> "$CHAT_CONVERSATIONS/$conversationId/approve"
        }
        return CloudRequest(path, "POST", body.encodeToByteArray(), key, timeoutSeconds = 150)
    }

    fun resendable(now: Long = System.currentTimeMillis()): Boolean = now - createdAt in 0 until MAX_AGE_MS

    internal fun retryDelay(attempt: Int, mayRetry: Boolean, now: Long): Long? {
        if (!mayRetry || attempt !in 1..4 || !resendable(now)) return null
        val delay = 1_000L shl (attempt - 1)
        return delay.takeIf { resendable(now + delay) }
    }

    internal fun valid(): Boolean = validKey(key) && when (kind) {
        Kind.CREATE -> conversationId == null
        else -> isUuid(conversationId)
    }

    companion object {
        private val KEY = Regex("[a-zA-Z0-9_-]{8,128}")
        private const val MAX_AGE_MS = 12 * 60 * 60 * 1_000L

        internal fun validKey(value: String): Boolean = KEY.matches(value)
    }
}

internal const val CHAT_CONVERSATIONS = "/api/chat/conversations"

/** A retry uses one immutable request, so its encoded body and key cannot diverge. */
internal suspend fun sendPending(
    client: CloudClient,
    pending: PendingRequest,
    mayRetry: () -> Boolean,
    now: () -> Long = System::currentTimeMillis,
    sleep: suspend (Long) -> Unit = { delay(it) },
): CloudReply {
    val wire = pending.request()
    var failures = 0
    while (true) {
        try {
            return client.request(wire)
        } catch (error: WaslaException) {
            if (error.kind == WaslaException.Kind.SIGNED_OUT || error.refusesSend()) throw error
            val wait = pending.retryDelay(++failures, mayRetry(), now()) ?: throw error
            sleep(wait)
            if (!mayRetry() || !pending.resendable(now())) throw error
        }
    }
}

internal fun WaslaException.refusesSend(): Boolean =
    status in 400..499 && status != 408 && status != 499 && code != "CHAT_REQUEST_IN_PROGRESS"
