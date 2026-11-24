package com.ahmadalwakai.wasla

import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.net.SocketTimeoutException

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
    fun serverSupportPermitsTheSamePostAfterALostReply() = runBlocking {
        val sent = mutableListOf<CloudRequest>()
        val api = CloudApi(
            vault = object : SessionVault {
                override fun read() = "better-auth.session_token=0123456789012345"
                override fun save(cookie: String) = Unit
                override fun clear() = Unit
            },
            transport = CloudTransport { request ->
                if (request.method == "GET") {
                    CloudResponse(200, """{"conversations":[],"requestKeys":true}""".encodeToByteArray())
                } else {
                    sent += request
                    if (sent.size == 1) throw SocketTimeoutException()
                    CloudResponse(200, """{"id":"aeb9dcbf-a151-407e-8bdf-50ef61e60454","status":"idle","messages":[]}""".encodeToByteArray())
                }
            },
        )
        api.restore()
        val pending = PendingRequest.make(PendingRequest.Kind.CREATE, null, "مرحبا", originalBody, nowMs = firstSend)
        val failure = runCatching { api.sendKeyed(pending.path, pending.body, pending.key) }.exceptionOrNull()

        assertTrue(failure is SocketTimeoutException)
        assertTrue(pending.canResend(api.chatList().requestKeys == true, firstSend + 1_000))
        api.sendKeyed(pending.path, pending.body, pending.key)

        assertEquals(2, sent.size)
        assertEquals(pending.key, sent.first().headers["Idempotency-Key"])
        assertEquals(sent.first().headers, sent.last().headers)
        assertEquals(sent.first().path, sent.last().path)
        assertArrayEquals(sent.first().body, sent.last().body)
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
}
