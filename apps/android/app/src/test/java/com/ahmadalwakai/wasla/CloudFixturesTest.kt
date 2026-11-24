package com.ahmadalwakai.wasla

import java.io.File
import java.net.URI
import java.util.Base64
import java.util.UUID
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.Serializable
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.double
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class CloudFixturesTest {
    private val fixtures = generateSequence(File("").absoluteFile) { it.parentFile }
        .map { it.resolve("tests/fixtures/cloud-phone") }
        .first { it.resolve("index.json").isFile }
    private val index = WaslaJson.decodeFromString<FixtureIndex>(fixtures.resolve("index.json").readText())

    @Test
    fun everyRecordedExchangeDecodesWithCloudModels() {
        val entries = index.fixtures
        assertEquals(52, entries.size)
        assertEquals(entries.size, entries.map { it.file }.toSet().size)

        for (entry in entries) {
            val (request, response) = fixture(entry.file)
            assertEquals(entry.file, entry.status, response.status)
            val bytes = response.bytes
            val path = request.path
            when {
                response.status >= 400 -> {
                    val fault = CloudHttpError.from(response.status, bytes)
                    val detail = (response.body["error"] as? JsonObject) ?: response.body
                    assertEquals(entry.file, detail.string("code"), fault.code)
                    assertEquals(entry.file, detail.string("message"), fault.message)
                }
                path == "/api/auth/sign-out" ->
                    assertTrue(response.body.getValue("success").jsonPrimitive.boolean)
                path.startsWith("/api/auth/") ->
                    assertEquals("phone-owner@example.test", CloudJson.decode<SignInReply>(bytes).user?.email)
                path == "/api/chat/images" -> assertTrue(CloudJson.decode<ChatImageAvailability>(bytes).available)
                path == "/api/chat/conversations" && request.method == "GET" -> {
                    val list = CloudJson.decode<ChatList>(bytes)
                    assertEquals(entry.file, true, list.requestKeys)
                    assertEquals(entry.file == "list-empty", list.conversations.isEmpty())
                    list.conversations.forEach { UUID.fromString(it.id) }
                }
                path == "/api/windows" -> {
                    val overview = CloudJson.decode<WindowsOverview>(bytes)
                    assertTrue(overview.enabled)
                    assertEquals(entry.file == "windows-empty", overview.devices.isEmpty())
                }
                path == "/api/windows/pairing" -> {
                    val pairing = CloudJson.decode<WindowsPairing>(bytes)
                    assertTrue(pairing.code.matches(Regex("[A-Za-z0-9_-]{16}")))
                }
                path.endsWith("/grants") ->
                    assertEquals("control", CloudJson.decode<WindowsGrant>(bytes).scope)
                path.endsWith("/frame") -> {
                    val frame = CloudJson.decode<WindowsFrameReply>(bytes)
                    assertEquals(frame.frame.targetKey, frame.grant.targetKey)
                    val jpeg = Base64.getDecoder().decode(frame.frame.jpeg)
                    assertArrayEquals(byteArrayOf(0xff.toByte(), 0xd8.toByte(), 0xff.toByte()), jpeg.copyOf(3))
                    assertArrayEquals(jpeg, frame.frame.imageData)
                }
                path.endsWith("/actions") ->
                    assertEquals(entry.conversationStatus, CloudJson.decode<WindowsActionReply>(bytes).status)
                path.endsWith("/stop") || request.method == "DELETE" ->
                    assertEquals(true, CloudJson.decode<OkReply>(bytes).ok)
                else -> {
                    val conversation = CloudJson.decode<ChatConversation>(bytes)
                    UUID.fromString(conversation.id)
                    assertEquals(entry.file, entry.conversationStatus, conversation.status)
                    assertTrue("${entry.file} version", conversation.version.orEmpty().matches(Regex("[0-9a-f]{24}")))
                }
            }
        }
    }

    @Test
    fun everyRecordedWriteUsesTheExpectedBodyAndHeaders() = runBlocking {
        for (entry in index.fixtures) {
            val (request, response) = fixture(entry.file)
            if (request.method == "GET") continue
            val login = request.path == "/api/auth/sign-in/email"
            val expectedCookie = if (login) null else fixtureCookie()
            val transport = RecordingTransport(response.http)
            val api = CloudApi(MemoryVault(expectedCookie), transport)
            api.restore()
            try {
                performWrite(api, request)
                assertTrue("${entry.file} should fail", response.status < 400)
            } catch (error: CloudHttpError) {
                assertEquals(entry.file, response.status, error.status)
            } catch (error: CloudInvalidCredentials) {
                assertTrue(login && response.status == 401)
            }
            val sent = transport.requests.single()
            assertEquals(entry.file, request.method, sent.method)
            assertEquals(entry.file, request.path, sent.path)
            assertEquals(entry.file, request.idempotencyKey, sent.headers["Idempotency-Key"])
            assertEquals(entry.file, ORIGIN, sent.headers["Origin"])
            assertEquals(entry.file, expectedCookie, sent.headers["Cookie"])

            // The recording includes rememberMe. The Android sign-in contract sends email and password.
            val expected = if (login) JsonObject(request.body.orEmpty() - "rememberMe") else request.body
            val actual = sent.body?.let { WaslaJson.parseToJsonElement(it.decodeToString()) }
            assertEquals(entry.file, expected, actual)
        }
    }

    @Test
    fun authPreservesTheCookieAndAnAuthenticated401SignsOut() {
        val login = fixture("auth-sign-in").request
        val transport = RecordingTransport(fixture("auth-sign-in").response.http)
        val vault = MemoryVault()
        val api = CloudApi(vault, transport)

        runBlocking { performWrite(api, login) }
        val original = fixtureCookie()
        assertTrue(original.endsWith("%3D"))
        assertEquals(original, vault.cookie)
        assertTrue(api.signedIn.value)

        transport.response = fixture("error-signed-out").response.http
        assertThrows(CloudSignedOut::class.java) { runBlocking { api.chatList() } }
        assertEquals(original, transport.requests.last().headers["Cookie"])
        assertNull(vault.cookie)
        assertFalse(api.signedIn.value)

        val wrong = fixture("auth-sign-in-wrong-password")
        transport.response = wrong.response.http
        assertThrows(CloudInvalidCredentials::class.java) { runBlocking { performWrite(api, wrong.request) } }
        assertNull(transport.requests.last().headers["Cookie"])
        assertNull(vault.cookie)
        assertFalse(api.signedIn.value)
    }

    @Test
    fun secureSessionCookieIsSelectedAndForwardedVerbatim() = runBlocking {
        val login = fixture("auth-sign-in")
        val cookie = "__Secure-" + fixtureCookie()
        val response = login.response.http.copy(
            headers = mapOf("Set-Cookie" to listOf("theme=dark; Path=/", "$cookie; Path=/; HttpOnly; Secure"))
        )
        val transport = RecordingTransport(response)
        val vault = MemoryVault()
        val api = CloudApi(vault, transport)
        performWrite(api, login.request)
        assertEquals(cookie, vault.cookie)

        transport.response = fixture("windows-active").response.http
        api.windows()
        assertEquals(cookie, transport.requests.last().headers["Cookie"])

        transport.response = fixture("auth-sign-out").response.http
        api.signOut()
        assertEquals(cookie, transport.requests.last().headers["Cookie"])
        assertNull(vault.cookie)
        assertFalse(api.signedIn.value)
    }

    @Test
    fun late401FromAnOldSessionKeepsTheReplacementSession() = runBlocking {
        val original = fixtureCookie()
        val replacement = "__Secure-$original"
        val login = fixture("auth-sign-in")
        val oldRequest = CompletableDeferred<CloudRequest>()
        val releaseOldRequest = CompletableDeferred<Unit>()
        val vault = MemoryVault(original)
        val api = CloudApi(vault, CloudTransport { request ->
            when (request.path) {
                "/api/auth/sign-in/email" -> login.response.http.copy(
                    headers = mapOf("Set-Cookie" to listOf("$replacement; Path=/; HttpOnly; Secure")),
                )
                "/api/chat/conversations" -> {
                    oldRequest.complete(request)
                    releaseOldRequest.await()
                    fixture("error-signed-out").response.http
                }
                else -> error("Unexpected route ${request.path}")
            }
        })
        api.restore()
        val oldCall = async { runCatching { api.chatList() } }
        assertEquals(original, withTimeout(5_000) { oldRequest.await() }.headers["Cookie"])
        performWrite(api, login.request)
        releaseOldRequest.complete(Unit)

        assertTrue(oldCall.await().exceptionOrNull() is CloudSignedOut)
        assertEquals(replacement, vault.cookie)
        assertTrue(api.signedIn.value)
    }

    @Test
    fun longPollUsesTheServerWaitCapAndKeepsTheVersion() = runBlocking {
        val completed = fixture("detail-completed")
        val held = fixture("detail-held-unchanged")
        val id = completed.response.body.string("id")
        val transport = RecordingTransport(completed.response.http)
        val api = CloudApi(MemoryVault(fixtureCookie()), transport)
        api.restore()
        val version = api.conversation(id).version
        assertNotNull(version)
        transport.response = held.response.http
        assertEquals(version, api.conversation(id, version).version)
        assertEquals(mapOf("since" to version, "wait" to "8000"), transport.requests.last().query)
    }

    @Test
    fun photoAndSecureBodiesUseTheContractWithoutRecordedWrites() = runBlocking {
        val detail = fixture("detail-completed").response
        val id = detail.body.string("id")
        val photo = Base64.getDecoder().decode(fixture("windows-frame").response.body
            .getValue("frame").jsonObject.string("jpeg"))
        val encoded = Base64.getEncoder().encodeToString(photo)
        val transport = RecordingTransport(detail.http)
        val api = CloudApi(MemoryVault(fixtureCookie()), transport)
        api.restore()

        api.secure(id, ChatSecureSubmit(id, "skip"))
        assertEquals("/api/chat/conversations/$id/secure", transport.requests.last().path)
        assertEquals("""{"requestId":"$id","action":"skip"}""", transport.requests.last().body?.decodeToString())
        api.secure(id, ChatSecureSubmit(id, "submit", mapOf("code" to "123456")))
        val submitted = WaslaJson.parseToJsonElement(transport.requests.last().body!!.decodeToString()).jsonObject
        assertEquals("submit", submitted.string("action"))
        assertEquals("123456", submitted.getValue("values").jsonObject.string("code"))

        transport.response = CloudResponse(200, """{"id":"$id","width":400,"height":200}""".encodeToByteArray())
        assertEquals(id, api.uploadImage("image/jpeg", photo).id)
        assertEquals("/api/chat/images", transport.requests.last().path)
        val uploaded = WaslaJson.parseToJsonElement(transport.requests.last().body!!.decodeToString()).jsonObject
        assertEquals("image/jpeg", uploaded.string("mimeType"))
        assertEquals(encoded, uploaded.string("data"))

        transport.response = detail.http
        val body = CloudJson.encode(ChatSend(text = "", images = listOf(id)))
        api.sendKeyed("/api/chat/conversations/$id/messages", body, "phone-photo-0001")
        val message = WaslaJson.parseToJsonElement(transport.requests.last().body!!.decodeToString()).jsonObject
        assertEquals("", message.string("text"))
        assertEquals(id, message.getValue("images").jsonArray.single().jsonPrimitive.content)

        transport.response = CloudResponse(200, photo, mapOf("Content-Type" to listOf("image/jpeg")))
        assertArrayEquals(photo, api.image(id))
        assertEquals("/api/chat/images/$id", transport.requests.last().path)
        assertArrayEquals(photo, api.screen(id))
        assertEquals("/api/chat/conversations/$id/screen", transport.requests.last().path)
    }

    @Test
    fun windowsActionVariantsKeepTheirContractFields() {
        val cases = listOf(
            WindowsAction.Click(x = -1.0, y = 2.0, right = true) to
                """{"type":"click","x":0.0,"y":1.0,"button":"right"}""",
            WindowsAction.Scroll(9) to """{"type":"scroll","delta":3}""",
            WindowsAction.Key("Enter") to """{"type":"key","key":"Enter"}""",
            WindowsAction.Text("مرحبا") to """{"type":"text","text":"مرحبا"}""",
        )
        for ((action, expected) in cases) {
            val actual = WaslaJson.parseToJsonElement(CloudJson.encode<WindowsAction>(action).decodeToString())
            assertEquals(WaslaJson.parseToJsonElement(expected), actual)
        }
    }

    private suspend fun performWrite(api: CloudApi, request: RecordedRequest) {
        val path = request.path
        val id = path.trimStart('/').split('/').getOrNull(3).orEmpty()
        val body = request.body.orEmpty()
        val json = request.body?.toString().orEmpty()
        when {
            path == "/api/auth/sign-in/email" ->
                api.signIn(body.string("email"), body.string("password"))
            path == "/api/auth/sign-out" -> api.signOut()
            path == "/api/windows/pairing" -> api.pairWindows()
            path.endsWith("/grants") -> api.windowsGrant(id, WaslaJson.decodeFromString<WindowsGrantRequest>(json))
            path.endsWith("/actions") -> {
                val action = body.getValue("action").jsonObject
                val click = WindowsAction.Click(
                    x = action.getValue("x").jsonPrimitive.double,
                    y = action.getValue("y").jsonPrimitive.double,
                    right = action.string("button") == "right"
                )
                val actionRequest = WindowsActionRequest(body.string("grantId"), body.string("nonce"), body.string("frameId"), click)
                api.windowsAction(id, actionRequest)
            }
            path.endsWith("/stop") -> api.windowsStop(id)
            path.endsWith("/cancel") -> api.cancel(id)
            path.endsWith("/feedback") -> api.feedback(id, WaslaJson.decodeFromString<ChatFeedback>(json))
            request.method == "DELETE" -> api.deleteConversation(id)
            else -> {
                val encoded = when {
                    path.endsWith("/messages") -> CloudJson.encode(WaslaJson.decodeFromString<ChatSend>(json))
                    path.endsWith("/respond") -> CloudJson.encode(WaslaJson.decodeFromString<ChatRespond>(json))
                    path.endsWith("/approve") -> CloudJson.encode(WaslaJson.decodeFromString<ChatApprove>(json))
                    path == "/api/chat/conversations" -> CloudJson.encode(WaslaJson.decodeFromString<ChatCreate>(json))
                    else -> error("No write handler for $path")
                }
                api.sendKeyed(path, encoded, requireNotNull(request.idempotencyKey))
            }
        }
    }

    private fun fixture(name: String): Exchange =
        WaslaJson.decodeFromString(fixtures.resolve("$name.json").readText())

    private fun fixtureCookie(): String =
        fixture("auth-sign-in").response.headers.getValue("set-cookie").single().substringBefore(';')

    private class RecordingTransport(var response: CloudResponse) : CloudTransport {
        val requests = mutableListOf<CloudRequest>()
        override suspend fun execute(request: CloudRequest): CloudResponse {
            requests.add(request)
            return response
        }
    }

    private class MemoryVault(var cookie: String? = null) : SessionVault {
        override fun read(): String? = cookie
        override fun save(cookie: String) { this.cookie = cookie }
        override fun clear() { cookie = null }
    }

    @Serializable
    private data class FixtureIndex(val fixtures: List<IndexEntry>)

    @Serializable
    private data class IndexEntry(val file: String, val status: Int, val conversationStatus: String? = null)

    @Serializable
    private data class Exchange(val request: RecordedRequest, val response: RecordedResponse)

    @Serializable
    private data class RecordedRequest(
        val method: String,
        val url: String,
        val body: JsonObject? = null,
        val idempotencyKey: String? = null
    ) {
        val path: String get() = URI(url).path
    }

    @Serializable
    private data class RecordedResponse(
        val status: Int,
        val body: JsonObject,
        val headers: Map<String, List<String>> = emptyMap()
    ) {
        val bytes: ByteArray get() = body.toString().encodeToByteArray()
        val http: CloudResponse get() = CloudResponse(status, bytes, headers)
    }

    private fun Map<String, JsonElement>.string(key: String): String = getValue(key).jsonPrimitive.content

    private companion object {
        const val ORIGIN = "https://www.mohassansy.com"
    }
}
