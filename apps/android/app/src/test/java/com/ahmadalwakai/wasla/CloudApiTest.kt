package com.ahmadalwakai.wasla

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.net.SocketTimeoutException
import java.time.Instant
import java.util.UUID

/**
 * Contract examples authored from production source, retrieved 2026-11-27:
 * https://github.com/ahmadalwakai/Mohassan-AI/blob/29448ae/apps/server/src/app.ts#L228-L304
 * https://github.com/ahmadalwakai/Mohassan-AI/blob/29448ae/apps/server/src/members.ts#L35-L64
 * https://github.com/ahmadalwakai/Mohassan-AI/blob/29448ae/apps/server/src/members.ts#L137-L143
 * https://github.com/ahmadalwakai/Mohassan-AI/blob/29448ae/apps/server/src/member-data-request.ts#L13-L25
 * https://github.com/ahmadalwakai/Mohassan-AI/blob/29448ae/apps/server/src/command-chat.ts#L4654-L4744
 * https://github.com/ahmadalwakai/Mohassan-AI/blob/29448ae/apps/server/src/chat-wait.ts#L14-L22
 * https://github.com/ahmadalwakai/Mohassan-AI/blob/29448ae/packages/contracts/src/command-chat.ts#L132-L298
 * https://github.com/ahmadalwakai/Mohassan-AI/blob/5853c599ab49/apps/ios/Wasla/Security.swift#L128-L143
 */
class CloudApiTest {
    private val conversationId = randomId()
    private val replyId = randomId()
    private val userId = randomId()
    private val controlId = randomId()
    private val version = randomId().replace("-", "").take(24)
    private val date = Instant.now().toString()
    private val cookie = "__Secure-better-auth.session_token=${randomId()}%3D"
    private val chat = "/api/chat/conversations"

    @Test
    fun signInCarriesWebOriginAndStoresOnlyTheUnmodifiedSessionCookie() = runBlocking {
        val vault = MemoryVault()
        val transport = RecordingTransport()
        val api = CloudApi(vault, transport)
        transport.reply = {
            json("""{"user":{"id":"$userId","email":"owner@example.test","name":"صاحب الحساب"}}""").copy(
                headers = mapOf("set-cookie" to listOf("unrelated=value; Path=/", "$cookie; Path=/; HttpOnly; Secure")),
            )
        }
        val password = randomId()
        assertEquals("owner@example.test", api.signIn("owner@example.test", password).user?.email)
        val login = transport.requests.single()
        assertEquals("POST", login.method)
        assertEquals("/api/auth/sign-in/email", login.path)
        assertEquals("https://www.mohassansy.com", login.headers["Origin"])
        assertEquals("application/json", login.headers["Content-Type"])
        assertNull(login.headers["Cookie"])
        val payload = CloudJson.decode<JsonObject>(requireNotNull(login.body))
        assertEquals("owner@example.test", payload.getValue("email").jsonPrimitive.contentOrNull)
        assertEquals(password, payload.getValue("password").jsonPrimitive.contentOrNull)
        assertTrue(payload.getValue("rememberMe").jsonPrimitive.boolean)
        assertEquals(cookie, vault.cookie)

        transport.reply = { access("owner", listOf("all")) }
        assertTrue(api.refreshAccess().isOwner)
        assertEquals("GET", transport.requests.last().method)
        assertEquals("/api/access", transport.requests.last().path)
        assertEquals(cookie, transport.requests.last().headers["Cookie"])
        assertNull(transport.requests.last().headers["Authorization"])

        transport.reply = { json("""{"success":true}""") }
        api.signOut()
        assertEquals("/api/auth/sign-out", transport.requests.last().path)
        assertEquals(cookie, transport.requests.last().headers["Cookie"])
        assertNull(vault.cookie)
        assertNull(api.access.value)
        assertFalse(api.signedIn.value)
    }

    @Test
    fun listDetailAndLongPollReadProductionChatShapes() = runBlocking {
        val transport = RecordingTransport()
        val api = restored(transport)
        transport.reply = { list(conversations = "[]") }
        assertTrue(api.chatList().conversations.isEmpty())

        transport.reply = { list(conversations = """[{"id":"$conversationId","title":"محادثة","status":"idle","updatedAt":"$date","browserAccount":null}]""") }
        val result = api.chatList()
        assertEquals(conversationId, result.conversations.single().id)
        assertEquals(true, result.requestKeys)
        assertEquals(listOf("computation"), result.capabilities?.available)

        transport.reply = { detail() }
        val view = api.conversation(conversationId)
        assertEquals(chat + "/$conversationId", transport.requests.last().path)
        assertEquals("جار العمل", view.progress)
        assertEquals("الناتج ٤", view.messages.single().text)
        assertEquals("assistant", view.messages.single().role)
        assertEquals("فحص الحساب", view.steps.single().text)
        assertNull(view.question)
        assertEquals(version, view.version)
        assertEquals(view, api.conversation(conversationId, view.version))
        assertEquals(mapOf("since" to version, "wait" to "8000"), transport.requests.last().query)
    }

    @Test
    fun retryAfterLostResponseKeepsThePathBodyAndIdempotencyKey() = runBlocking {
        val transport = RecordingTransport()
        val api = restored(transport)
        val path = "$chat/$conversationId/messages"
        val message = "احسب ٢ + ٢"
        val pending = PendingRequest.make(
            PendingRequest.Kind.MESSAGE, conversationId, message, CloudJson.encode(ChatSend(message)),
        )
        val binding = api.sessionBinding()

        transport.reply = { throw SocketTimeoutException() }
        val first = runCatching { api.sendKeyed(pending.path, pending.body, pending.key, binding) }
        assertTrue(first.exceptionOrNull() is SocketTimeoutException)

        val restored = CloudJson.decode<PendingRequest>(CloudJson.encode(pending))
        transport.reply = { detail() }
        assertEquals(replyId, api.sendKeyed(restored.path, restored.body, restored.key, binding).messages.single().id)

        val writes = transport.requests.filter { it.method == "POST" }
        assertEquals(2, writes.size)
        for (request in writes) {
            assertEquals(path, request.path)
            assertEquals("https://www.mohassansy.com", request.headers["Origin"])
            assertEquals(cookie, request.headers["Cookie"])
            assertEquals(pending.key, request.headers["Idempotency-Key"])
            assertArrayEquals("""{"text":"احسب ٢ + ٢"}""".encodeToByteArray(), request.body)
        }
        val unsupported = runCatching { api.sendKeyed("$chat/$conversationId/secure", pending.body, pending.key) }
        assertTrue(unsupported.exceptionOrNull() is IllegalArgumentException)
        assertEquals(writes.last(), transport.requests.last())
    }

    @Test
    fun localizesHttpFailuresAndClearsOnlyAnExpiredSession() = runBlocking {
        val transport = RecordingTransport()
        val vault = MemoryVault(cookie)
        val api = restored(transport, vault = vault)
        val failures = listOf(
            Triple(403, "MEMBER_FORBIDDEN", "هذه الخدمة غير متاحة لحسابك."),
            Triple(429, "MEMBER_DAILY_LIMIT", "بلغت حدّ الطلبات اليومي لحسابك. حاول لاحقًا."),
            Triple(503, "SERVICE_UNAVAILABLE", "تعذّر على الخادم إكمال الطلب. أعد المحاولة بعد قليل."),
            Triple(401, "SERVICE_UNAUTHORIZED", "تعذّر التحقق من الاتصال بالخادم. أعد المحاولة."),
        )
        for ((status, code, message) in failures) {
            transport.reply = { json("""{"error":{"code":"$code","message":"An upstream error"}}""", status) }
            val fault = runCatching { api.chatList() }.exceptionOrNull() as CloudHttpError
            assertEquals(status, fault.status)
            assertEquals(code, fault.code)
            assertEquals(message, fault.message)
            assertEquals(cookie, vault.cookie)
            assertTrue(api.signedIn.value)
        }

        transport.reply = { json("""{"error":{"code":"UNAUTHORIZED","message":"سجل الدخول للمتابعة."}}""", 401) }
        assertTrue(runCatching { api.chatList() }.exceptionOrNull() is CloudSignedOut)
        assertNull(vault.cookie)
        assertNull(api.access.value)
        assertFalse(api.signedIn.value)
        transport.reply = { json("""{"code":"INVALID_EMAIL_OR_PASSWORD","message":"Invalid credentials"}""", 401) }
        assertTrue(runCatching { api.signIn("owner@example.test", randomId()) }.exceptionOrNull() is CloudInvalidCredentials)
        assertNull(transport.requests.last().headers["Cookie"])
    }

    @Test
    fun lateUnauthorizedReplyCannotClearAReplacementSession() = runBlocking {
        val transport = RecordingTransport()
        val vault = MemoryVault(cookie)
        val api = restored(transport, vault = vault)
        val originalBinding = api.sessionBinding()
        val started = CompletableDeferred<Unit>()
        val release = CompletableDeferred<Unit>()
        val replacement = "__Secure-better-auth.session_token=${randomId()}%3D"
        transport.reply = { request ->
            when (request.path) {
                chat -> {
                    started.complete(Unit)
                    release.await()
                    json("""{"error":{"code":"UNAUTHORIZED"}}""", 401)
                }
                "/api/auth/sign-out" -> json("""{"success":true}""")
                "/api/auth/sign-in/email" -> json("{}").copy(
                    headers = mapOf("Set-Cookie" to listOf("$replacement; Path=/; Secure; HttpOnly")),
                )
                "/api/access" -> access("owner", listOf("all"))
                else -> error("Unexpected route ${request.path}")
            }
        }

        val lateFailure = async { runCatching { api.chatList() }.exceptionOrNull() }
        try {
            withTimeout(5_000) { started.await() }
            api.signOut()
            api.signIn("owner@example.test", randomId())
            api.refreshAccess()
        } finally {
            release.complete(Unit)
        }

        assertTrue(lateFailure.await() is CloudSignedOut)
        assertEquals(replacement, vault.cookie)
        assertTrue(api.signedIn.value)
        assertTrue(api.access.value?.isOwner == true)
        val requestCount = transport.requests.size
        val replay = runCatching {
            api.sendKeyed(chat, CloudJson.encode(ChatCreate("مرحبا")), randomId(), originalBinding)
        }
        assertTrue(replay.exceptionOrNull() is CloudSignedOut)
        assertEquals(requestCount, transport.requests.size)
    }

    @Test
    fun membersUseChatMutationsButDoNotReachOwnerOnlyMediaOrFeedbackRoutes() = runBlocking {
        val transport = RecordingTransport()
        // The role response can advertise images even though MEMBER_ROUTES does not include the chat image routes.
        val api = restored(transport, role = "member", services = listOf("chat", "images"))
        assertFalse(api.access.value?.isOwner ?: true)
        assertTrue(api.access.value?.canChat ?: false)
        val before = transport.requests.size
        val blocked = listOf<suspend () -> Any>(
            { api.feedback(conversationId, ChatFeedback(replyId, "useful")) },
            { api.imagesAvailable() },
            { api.uploadImage("image/jpeg", ByteArray(64)) },
            { api.image(replyId) },
        )
        for (action in blocked) {
            val error = runCatching { action() }.exceptionOrNull() as CloudHttpError
            assertEquals(403, error.status)
            assertEquals("MEMBER_FORBIDDEN", error.code)
        }
        assertEquals(before, transport.requests.size)

        transport.reply = { detail() }
        val actions = listOf(
            Triple(chat, """{"goal":"محادثة"}""", CloudJson.encode(ChatCreate("محادثة"))),
            Triple("$chat/$conversationId/messages", """{"text":"","questionId":"$controlId","answers":[{"fieldId":"city","value":"لندن"}]}""", CloudJson.encode(ChatSend("", controlId, listOf(ChatFieldAnswer("city", "لندن"))))),
            Triple("$chat/$conversationId/respond", """{"questionId":"$controlId","optionId":"retry"}""", CloudJson.encode(ChatRespond(controlId, "retry"))),
            Triple("$chat/$conversationId/approve", """{"approvalId":"$controlId","approved":false}""", CloudJson.encode(ChatApprove(controlId, false))),
        )
        for ((path, expected, body) in actions) {
            val key = randomId()
            api.sendKeyed(path, body, key)
            val request = transport.requests.last()
            assertEquals(path, request.path)
            assertEquals(key, request.headers["Idempotency-Key"])
            assertEquals(CloudJson.decode<JsonObject>(expected.encodeToByteArray()), CloudJson.decode<JsonObject>(requireNotNull(request.body)))
        }
        api.secure(conversationId, ChatSecureSubmit(controlId, "skip"))
        assertEquals("$chat/$conversationId/secure", transport.requests.last().path)
        assertEquals("""{"requestId":"$controlId","action":"skip"}""", transport.requests.last().body?.decodeToString())
        assertNull(transport.requests.last().headers["Idempotency-Key"])
        api.cancel(conversationId)
        assertEquals("$chat/$conversationId/cancel", transport.requests.last().path)
        assertEquals("{}", transport.requests.last().body?.decodeToString())
        transport.reply = { json("""{"ok":true}""") }
        api.deleteConversation(conversationId)
        assertEquals("DELETE", transport.requests.last().method)
        assertEquals("$chat/$conversationId", transport.requests.last().path)
    }

    @Test
    fun anUnverifiedOrDataOnlySessionDoesNotReachChat() = runBlocking {
        val transport = RecordingTransport()
        val api = CloudApi(MemoryVault(cookie), transport)
        api.restore()
        assertTrue(runCatching { api.chatList() }.exceptionOrNull() is CloudInvalidResponse)
        assertTrue(transport.requests.isEmpty())

        transport.reply = { access("member", dataOnly = true) }
        assertFalse(api.refreshAccess().canChat)
        assertTrue(runCatching { api.chatList() }.exceptionOrNull() is CloudHttpError)
        assertEquals(listOf("/api/access"), transport.requests.map { it.path })
        assertNotNull(api.sessionBinding())
    }

    private suspend fun restored(
        transport: RecordingTransport,
        role: String = "owner",
        vault: MemoryVault = MemoryVault(cookie),
        services: List<String> = listOf("all"),
    ): CloudApi {
        transport.reply = { access(role, services) }
        return CloudApi(vault, transport).also {
            it.restore()
            it.refreshAccess()
        }
    }

    private fun access(role: String, services: List<String> = emptyList(), dataOnly: Boolean = false): CloudResponse {
        val list = services.joinToString(",") { "\"$it\"" }
        return json("""{"user":{"id":"$userId","email":"owner@example.test","name":"صاحب الحساب"},"role":"$role","services":[$list],"dataOnly":$dataOnly}""")
    }

    private fun list(conversations: String) = json(
        """{"configured":false,"capabilities":{"chatModel":false,"available":["computation"]},"requestKeys":true,"conversations":$conversations}""",
    )

    private fun detail() = json(
        """{
            "id":"$conversationId","title":"محادثة","status":"running","updatedAt":"$date","browserAccount":null,
            "messages":[{"id":"$replyId","role":"assistant","text":"الناتج ٤","createdAt":"$date"}],
            "question":null,"approval":null,"secure":null,"browser":null,"progress":"جار العمل",
            "steps":[{"id":"$controlId","text":"فحص الحساب","createdAt":"$date"}],
            "error":null,"configured":false,"capabilities":{"chatModel":false,"available":["computation"]},
            "campaign":null,"version":"$version","run":null
        }""".trimIndent(),
    )

    private fun randomId() = UUID.randomUUID().toString()

    private fun json(body: String, status: Int = 200) = CloudResponse(status, body.encodeToByteArray())

    private class MemoryVault(var cookie: String? = null) : SessionVault {
        override fun read(): String? = cookie
        override fun save(cookie: String) { this.cookie = cookie }
        override fun clear() { cookie = null }
    }

    private class RecordingTransport : CloudTransport {
        val requests = mutableListOf<CloudRequest>()
        var reply: suspend (CloudRequest) -> CloudResponse = { error("Unexpected route ${it.path}") }

        override suspend fun execute(request: CloudRequest): CloudResponse {
            requests += request
            return reply(request)
        }
    }
}
