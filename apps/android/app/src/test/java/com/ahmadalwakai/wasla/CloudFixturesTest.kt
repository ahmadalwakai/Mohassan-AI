package com.ahmadalwakai.wasla

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.junit.runners.Parameterized
import java.io.File

@RunWith(Parameterized::class)
class CloudFixturesTest(private val expected: Entry) {
    @Serializable data class Entry(val file: String, val status: Int, val conversationStatus: String? = null) {
        override fun toString(): String = file
    }
    @Serializable private data class Index(val fixtures: List<Entry>)
    @Serializable private data class Exchange(val request: Request, val response: Response)
    @Serializable private data class Request(
        val method: String,
        val url: String,
        val body: JsonObject? = null,
        val idempotencyKey: String? = null,
    )
    @Serializable private data class Response(
        val status: Int,
        val body: JsonObject,
        val headers: Map<String, List<String>> = emptyMap(),
    )

    @Test
    fun requestAndResponseMatchCloudContract() {
        val exchange = read<Exchange>(expected.file)
        val request = exchange.request
        val response = exchange.response
        val path = request.url.substringBefore('?')
        val endpoint = path.substringAfterLast('/')
        val body = request.body
        assertEquals(expected.status, response.status)
        request.idempotencyKey?.let { assertTrue(PendingRequest.validKey(it)) }
        when {
            body == null -> assertTrue(request.method == "GET" || request.method == "DELETE")
            endpoint == "email" -> roundTrip<SignInBody>(body)
            endpoint == "conversations" -> roundTrip<MohassanCreate>(body)
            endpoint == "messages" -> roundTrip<MohassanSend>(body)
            endpoint == "respond" -> roundTrip<MohassanRespond>(body)
            endpoint == "approve" -> roundTrip<MohassanApprove>(body)
            endpoint == "feedback" -> roundTrip<ChatFeedback>(body)
            endpoint == "grants" -> roundTrip<WindowsGrantRequest>(body)
            endpoint == "actions" -> roundTrip<WindowsActionRequest>(body)
            endpoint in setOf("pairing", "cancel", "stop", "sign-out") -> roundTrip<EmptyBody>(body)
            else -> error("No request decoder for ${expected.file}")
        }

        val bytes = encode(response.body)
        when {
            response.status >= 400 -> {
                val fault = decode<ServerFault>(bytes)
                assertNotNull(fault.error?.code ?: fault.code)
            }
            endpoint == "email" || endpoint == "get-session" -> {
                val account = decode<SignInReply>(bytes)
                assertEquals("phone-owner@example.test", account.user?.email)
                if (endpoint == "email") {
                    val headers = response.headers.getValue("set-cookie")
                    assertEquals(headers.single().substringBefore(';'), SessionCookie.fromSetCookies(headers)?.header)
                }
            }
            endpoint == "sign-out" -> assertEquals(true, decode<OkReply>(bytes).success)
            endpoint == "images" -> assertTrue(decode<ChatImageAvailability>(bytes).available)
            endpoint == "conversations" && request.method == "GET" -> {
                val list = decode<MohassanList>(bytes)
                assertEquals(true, list.requestKeys)
                assertTrue(list.conversations.all { isUuid(it.id) })
            }
            request.method == "DELETE" || path.startsWith("/api/windows/devices") && endpoint == "stop" ->
                assertEquals(true, decode<OkReply>(bytes).ok)
            path.startsWith("/api/chat/conversations") -> {
                val conversation = decode<MohassanConversation>(bytes)
                assertTrue(isUuid(conversation.id))
                assertEquals(expected.conversationStatus, conversation.status)
                assertNotNull(conversation.version)
            }
            endpoint == "windows" -> assertTrue(decode<WindowsOverview>(bytes).enabled)
            endpoint == "pairing" -> assertNotNull(decode<WindowsPairing>(bytes).code)
            endpoint == "grants" -> assertEquals("control", decode<WindowsGrant>(bytes).scope)
            endpoint == "frame" -> assertNotNull(decode<WindowsFrameReply>(bytes).frame.imageData())
            endpoint == "actions" -> assertEquals(expected.conversationStatus, decode<WindowsActionReply>(bytes).status)
            else -> error("No response decoder for ${expected.file}")
        }
    }

    private inline fun <reified T> roundTrip(body: JsonObject) {
        val encoded = encode(decode<T>(encode(body)))
        assertEquals("Request body for ${expected.file}", body, decode<JsonElement>(encoded))
    }

    companion object {
        private val dir: File = generateSequence(File(System.getProperty("user.dir"))) { it.parentFile }
            .map { it.resolve("tests/fixtures/cloud-phone") }
            .first { it.isDirectory }

        private inline fun <reified T> read(name: String): T = decode(dir.resolve("$name.json").readBytes())

        @JvmStatic
        @Parameterized.Parameters(name = "{0}")
        fun fixtures(): List<Entry> {
            val index = read<Index>("index")
            check(index.fixtures.size == 52)
            check(index.fixtures.map { "${it.file}.json" }.toSet() + "index.json" == dir.list().orEmpty().toSet())
            return index.fixtures
        }
    }
}
