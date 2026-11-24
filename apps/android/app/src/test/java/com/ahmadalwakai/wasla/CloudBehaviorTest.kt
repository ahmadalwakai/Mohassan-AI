package com.ahmadalwakai.wasla

import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonElement
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.IOException
import java.time.Instant

class CloudBehaviorTest {
    @Test
    fun oneExactSessionCookieIsSentAndAnAuthenticated401ClearsIt() = runBlocking {
        val header = "__Secure-better-auth.session_token=${"A".repeat(16)}%2F%3D"
        val cookie = SessionCookie.fromSetCookies(listOf(
            "other=unrelated; Path=/",
            "better-auth.session_token=; Max-Age=0; Path=/, $header; Secure; Path=/",
        ))
        assertNotNull(cookie)
        assertNull(SessionCookie.fromSetCookies(listOf("prefix-$header; Secure")))
        var signedOutCalls = 0
        var requests = 0
        val client = CloudClient(cookie, { signedOutCalls += 1 }, CloudTransport { request, headers ->
            requests += 1
            assertEquals(header, headers["Cookie"])
            assertEquals(if (request.method == "GET") null else CLOUD_ORIGIN, headers["Origin"])
            CloudReply(if (requests == 3) 401 else 200, "{}".encodeToByteArray())
        })
        client.request(CloudRequest(CHAT_CONVERSATIONS))
        client.request(CloudRequest("$CHAT_CONVERSATIONS/test", method = "DELETE"))
        assertEquals(WaslaException.Kind.SIGNED_OUT, requestFailure(client).kind)
        assertEquals(WaslaException.Kind.SIGNED_OUT, requestFailure(client).kind)
        assertEquals(1, signedOutCalls)
        assertEquals(3, requests)
    }

    private suspend fun requestFailure(client: CloudClient): WaslaException = try {
        client.request(CloudRequest(CHAT_CONVERSATIONS))
        error("Expected a failure")
    } catch (error: WaslaException) {
        error
    }

    @Test
    fun unauthenticated401IsARefusalAndRedirectIsRejected() = runBlocking {
        var signedOut = false
        var status = 401
        val client = CloudClient(onSignedOut = { signedOut = true }, transport = CloudTransport { _, headers ->
            assertNull(headers["Cookie"])
            CloudReply(status, "{}".encodeToByteArray())
        })
        assertEquals(401, requestFailure(client).status)
        status = 302
        assertEquals(302, requestFailure(client).status)
        assertFalse(signedOut)
    }

    @Test
    fun retryUsesSameKeyAndBytesAndBacksOffFourTimes() = runBlocking {
        val sent = mutableListOf<CloudRequest>()
        val waits = mutableListOf<Long>()
        var now = 1_000L
        val pending = pending(now)
        val restored = decode<PendingRequest>(encode(pending))
        assertEquals(pending.createdAt, restored.createdAt)
        val client = CloudClient(transport = CloudTransport { request, headers ->
            sent.add(request)
            assertEquals(restored.key, headers["Idempotency-Key"])
            if (sent.size < 5) throw IOException("lost reply")
            CloudReply(200, "{}".encodeToByteArray())
        })
        sendPending(client, restored, { true }, { now }) { wait ->
            waits.add(wait)
            now += wait
        }
        assertEquals(listOf(1_000L, 2_000L, 4_000L, 8_000L), waits)
        assertEquals(5, sent.size)
        assertTrue(sent.all { it.key == pending.key && it.body!!.contentEquals(pending.request().body!!) })
    }

    @Test
    fun retryRequiresAdvertisedKeysAndTwelveHourWindow() = runBlocking {
        val ageLimit = 43_200_000L
        for ((keys, now) in listOf(false to 1L, true to ageLimit, true to (ageLimit - 500))) {
            var count = 0
            val client = CloudClient(transport = CloudTransport { _, _ ->
                count += 1
                throw IOException("lost reply")
            })
            val result = runCatching { sendPending(client, pending(0), { keys }, { now }) { error("Unexpected sleep") } }
            assertTrue(result.exceptionOrNull() is WaslaException)
            assertEquals(1, count)
        }
        assertFalse(pending(0).resendable(ageLimit))
    }

    @Test
    fun switchReplacesGrantsAndChecksExpirationAtFifteenSecondIntervals() {
        val now = Instant.parse("2026-11-23T22:00:00Z")
        val target = WindowsTarget("key", "window", "allowed window", 320, 240)
        val state = WindowsState("nonce", safeDesktop = true, localView = true, localControl = true, target, "ready")
        val control = RemoteTiming.request(state, control = true)!!
        val view = RemoteTiming.request(state, control = false)!!
        assertEquals(WindowsGrantRequest("control", 120, "key", "nonce"), control)
        assertEquals(WindowsGrantRequest("view", 30, "key", "nonce"), view)
        assertEquals(15_000L, RemoteTiming.RENEW_EVERY_MS)
        assertEquals(900L, RemoteTiming.FRAME_EVERY_MS)
        fun grant(scope: String, remaining: Long) = WindowsGrant("grant", scope, "key", "nonce", now.plusSeconds(remaining).toString())
        assertFalse(RemoteTiming.shouldRenew(grant("control", 35), now))
        assertTrue(RemoteTiming.shouldRenew(grant("control", 34), now))
        assertTrue(RemoteTiming.shouldRenew(grant("view", 50), now))
        assertTrue(RemoteTiming.shouldRenew(null, now))
        assertNull(RemoteTiming.request(state.copy(target = null), control = true))
    }

    @Test
    fun additionalBodiesFollowTheContract() {
        fun checkBody(expected: String, actual: ByteArray) =
            assertEquals(decode<JsonElement>(expected.encodeToByteArray()), decode<JsonElement>(actual))
        checkBody("""{"requestId":"id","action":"submit","values":{"password":"test-value"}}""",
            encode(ChatSecureSubmit("id", "submit", mapOf("password" to "test-value"))))
        checkBody("""{"requestId":"id","action":"skip"}""", encode(ChatSecureSubmit("id", "skip")))
        checkBody("""{"images":["photo"]}""", encode(MohassanCreate(images = listOf("photo"))))
        checkBody("""{"text":"","images":["photo"]}""", encode(MohassanSend("", images = listOf("photo"))))
        checkBody("""{"mimeType":"image/jpeg","data":"/9j/2Q=="}""", encode(ChatImageUpload("image/jpeg", "/9j/2Q==")))
        checkBody("""{"type":"scroll","delta":-3}""", encode(WindowsAction.scroll(-4)))
        checkBody("""{"type":"text","text":"input"}""", encode(WindowsAction.text("input")))
        checkBody("""{"type":"key","key":"Enter"}""", encode(WindowsAction.key("Enter")))
    }

    private fun pending(created: Long) =
        PendingRequest("test-request-key", PendingRequest.Kind.CREATE, null, "مرحبا",
            encode(MohassanCreate("مرحبا")).decodeToString(), createdAt = created)
}
