package com.ahmadalwakai.wasla

import kotlinx.serialization.Serializable
import java.io.IOException
import java.net.ConnectException
import java.net.UnknownHostException
import java.util.UUID
import javax.net.ssl.SSLException

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
        get() = when (kind) {
            Kind.CREATE -> CloudApi.CONVERSATIONS
            Kind.MESSAGE, Kind.FIELDS -> "${CloudApi.CONVERSATIONS}/$conversationId/messages"
            Kind.OPTION -> "${CloudApi.CONVERSATIONS}/$conversationId/respond"
            Kind.APPROVE -> "${CloudApi.CONVERSATIONS}/$conversationId/approve"
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
        // Leave a margin before the server's 24-hour eviction (command-chat.ts, retrieved 2026-11-27).
        // https://github.com/ahmadalwakai/Mohassan-AI/blob/29448aea3fa10d226ef82ec5bf0a65e723d6ec39/apps/server/src/command-chat.ts
        private const val MAX_AGE_MS = 12 * 60 * 60 * 1_000L

        fun make(
            kind: Kind,
            conversationId: String?,
            text: String,
            body: ByteArray,
            imageIds: List<String> = emptyList(),
            nowMs: Long = System.currentTimeMillis(),
        ): PendingRequest {
            require(if (kind == Kind.CREATE) conversationId == null else isUuid(conversationId))
            return PendingRequest(
                kind, conversationId, text, body.copyOf(), imageIds.toList(), UUID.randomUUID().toString(), nowMs,
            )
        }
    }
}

internal enum class PendingFailure { RETURN_TO_DRAFT, RETRY, KEEP }

/** A rejection after an ambiguous attempt cannot resolve the original attempt. */
internal fun pendingFailure(error: Exception, firstAttempt: Boolean): PendingFailure = when (error) {
    is CloudHttpError -> when {
        error.status == 429 -> PendingFailure.KEEP
        error.status == 409 && error.code == "CHAT_REQUEST_IN_PROGRESS" -> PendingFailure.RETRY
        error.status == 408 || error.status == 499 || error.status in 500..599 -> PendingFailure.RETRY
        firstAttempt && error.status in 400..499 -> PendingFailure.RETURN_TO_DRAFT
        else -> PendingFailure.KEEP
    }
    is ConnectException, is UnknownHostException, is SSLException -> PendingFailure.KEEP
    is IOException -> PendingFailure.RETRY
    else -> PendingFailure.KEEP
}
