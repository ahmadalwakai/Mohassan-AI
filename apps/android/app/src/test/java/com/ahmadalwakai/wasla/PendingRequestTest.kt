package com.ahmadalwakai.wasla

import kotlinx.serialization.json.Json
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.net.SocketTimeoutException
import java.net.UnknownHostException

// Production request rules, retrieved 2026-11-27.
// https://github.com/ahmadalwakai/Mohassan-AI/blob/29448aea3fa10d226ef82ec5bf0a65e723d6ec39/tests/chat-idempotency.test.ts
// https://github.com/ahmadalwakai/Mohassan-AI/blob/29448aea3fa10d226ef82ec5bf0a65e723d6ec39/packages/contracts/src/command-chat.ts
class PendingRequestTest {
    private val firstSend = 10_000L
    private val originalBody = CloudJson.encode(ChatCreate(goal = "مرحبا"))

    @Test
    fun retriesKeepTheSameKeyRouteAndBodyAfterRelaunch() {
        val body = originalBody.copyOf()
        val pending = PendingRequest.make(PendingRequest.Kind.CREATE, null, "مرحبا", body, nowMs = firstSend)
        body.fill(0)
        pending.body.fill(0)
        val restored = Json.decodeFromString<PendingRequest>(Json.encodeToString(PendingRequest.serializer(), pending))

        assertEquals("/api/chat/conversations", restored.path)
        assertEquals(pending.key, restored.key)
        assertArrayEquals(originalBody, restored.body)
        assertNotEquals(pending.key, PendingRequest.make(PendingRequest.Kind.CREATE, null, "مرحبا", originalBody).key)
    }

    @Test
    fun resendRequiresSupportAndStopsAfterFourAttemptsOrTwelveHours() {
        val pending = PendingRequest.make(PendingRequest.Kind.CREATE, null, "مرحبا", originalBody, nowMs = firstSend)
        val cutoff = firstSend + 12 * 60 * 60 * 1_000L

        val delays = (1..4).map { pending.retryDelayMillis(true, true, it, firstSend) }
        assertEquals(listOf(1_000L, 2_000L, 4_000L, 8_000L), delays)
        assertNull(pending.retryDelayMillis(true, true, 5, firstSend))
        assertNull(pending.retryDelayMillis(false, true, 1, firstSend))
        assertNull(pending.retryDelayMillis(true, false, 1, firstSend))
        assertNull(pending.retryDelayMillis(true, true, 1, cutoff - 1_000))
        assertTrue(pending.canResend(true, cutoff - 1))
        assertFalse(pending.canResend(true, cutoff))
    }

    @Test
    fun refusedFirstAttemptReturnsToDraftAndPriorAmbiguityKeepsTheKey() {
        val forbidden = CloudHttpError(403, "MEMBER_FORBIDDEN", "")
        assertEquals(PendingFailure.RETURN_TO_DRAFT, pendingFailure(forbidden, firstAttempt = true))
        assertEquals(PendingFailure.KEEP, pendingFailure(forbidden, firstAttempt = false))
    }

    @Test
    fun offlineAndRateLimitsWaitForUserAndAmbiguousRepliesAllowBackoff() {
        assertEquals(PendingFailure.KEEP, pendingFailure(UnknownHostException(), firstAttempt = true))
        assertEquals(PendingFailure.KEEP, pendingFailure(CloudHttpError(429, null, ""), firstAttempt = false))
        assertEquals(PendingFailure.RETRY, pendingFailure(SocketTimeoutException(), firstAttempt = true))
        assertEquals(PendingFailure.RETRY, pendingFailure(CloudHttpError(500, null, ""), firstAttempt = true))
        assertEquals(PendingFailure.RETRY,
            pendingFailure(CloudHttpError(409, "CHAT_REQUEST_IN_PROGRESS", ""), firstAttempt = false))
        assertEquals(PendingFailure.KEEP,
            pendingFailure(CloudHttpError(409, "CHAT_REQUEST_KEY_REUSED", ""), firstAttempt = false))
    }
}
