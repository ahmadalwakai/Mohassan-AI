package com.ahmadalwakai.wasla

import kotlinx.serialization.Serializable
import java.util.UUID

/** Retains the original request bytes for every attempt. */
@Serializable
class PendingRequest private constructor(
    val kind: Kind,
    val conversationId: String?,
    val text: String,
    private val encodedBody: ByteArray,
    val imageIds: List<String>,
    val key: String,
    val createdAtMs: Long,
) {
    enum class Kind { CREATE, MESSAGE, FIELDS, OPTION, APPROVE }

    val body: ByteArray get() = encodedBody.copyOf()
    val fromComposer get() = kind == Kind.CREATE || kind == Kind.MESSAGE
    val path: String
        get() {
            val conversations = "/api/chat/conversations"
            return when (kind) {
                Kind.CREATE -> conversations
                Kind.MESSAGE, Kind.FIELDS -> "$conversations/$conversationId/messages"
                Kind.OPTION -> "$conversations/$conversationId/respond"
                Kind.APPROVE -> "$conversations/$conversationId/approve"
            }
        }

    fun canResend(requestKeys: Boolean, nowMs: Long = System.currentTimeMillis()): Boolean =
        requestKeys && nowMs - createdAtMs in 0 until MAX_AGE_MS

    fun retryDelayMillis(
        requestKeys: Boolean,
        foreground: Boolean,
        failedAttempts: Int,
        nowMs: Long = System.currentTimeMillis(),
    ): Long? {
        if (!foreground || failedAttempts !in 1..4 || !canResend(requestKeys, nowMs)) return null
        val delay = 1_000L shl (failedAttempts - 1)
        return delay.takeIf { canResend(requestKeys, nowMs + it) }
    }

    companion object {
        private const val MAX_AGE_MS = 12 * 60 * 60 * 1_000L

        fun make(
            kind: Kind,
            conversationId: String?,
            text: String,
            body: ByteArray,
            imageIds: List<String> = emptyList(),
            nowMs: Long = System.currentTimeMillis(),
        ): PendingRequest {
            require(if (kind == Kind.CREATE) conversationId == null else conversationId != null)
            return PendingRequest(
                kind, conversationId, text, body.copyOf(), imageIds.toList(), UUID.randomUUID().toString(), nowMs,
            )
        }
    }
}
