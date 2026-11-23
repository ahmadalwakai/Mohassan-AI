package com.ahmadalwakai.wasla

import kotlinx.serialization.decodeFromString
import kotlinx.serialization.encodeToString
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class ModelsTest {
    private val pin = "f48f8843dec987fd6ffba198978ec273ba5ca092846e547e53b5b551ba65b476"

    @Test
    fun bundledDefaultsValidate() {
        val identity = BundledConnection.decode("""{"server_url": "https://100.72.126.108:47621", "certificate_sha256": "${pin.uppercase()}", "computer_name": "كمبيوترك"}""")
        assertEquals("https://100.72.126.108:47621", identity.baseUrl)
        assertEquals(pin, identity.fingerprint)
        assertEquals("100.72.126.108", identity.host)
        assertEquals(47621, identity.port)
        assertEquals("كمبيوترك", identity.name)
    }

    @Test
    fun addressesAreNormalized() {
        assertEquals("https://desk-pc", ServerIdentity.validate("HTTPS://Desk-PC/", pin).baseUrl)
        assertEquals(443, ServerIdentity.validate("https://desk-pc", pin).port)
        assertEquals("https://[::1]:47621", ServerIdentity.validate("https://[::1]:47621", pin).baseUrl)
        assertEquals("::1", ServerIdentity.validate("https://[::1]:47621", pin).host)
        assertEquals("https://192.168.1.10:47621", ServerIdentity.validate("  https://192.168.1.10:47621  ", pin).baseUrl)
    }

    @Test
    fun badAddressesAreRefused() {
        val bad = listOf(
            "http://10.0.0.1:47621", "https://user@10.0.0.1:47621", "https://user:pw@10.0.0.1:47621", "https://10.0.0.1:47621/api",
            "https://10.0.0.1:47621?x=1", "https://10.0.0.1:47621#f", "https://10.0.0.1:99999", "https://10.0.0.1:0", "https://",
            "ftp://10.0.0.1", "https://10.0.0.1 :47621", "https://10.0.0.1:47621%2f", "https://10.0.0.1\\x", "", "10.0.0.1:47621",
        )
        for (address in bad) {
            try { ServerIdentity.validate(address, pin); fail("accepted $address") } catch (error: WaslaException) { assertEquals(address, WaslaException.Kind.INVALID_ADDRESS, error.kind) }
        }
    }

    @Test
    fun badFingerprintsAreRefused() {
        for (fingerprint in listOf("", pin.dropLast(1), pin + "a", pin.replaceRange(0, 1, "g"), pin.replaceRange(0, 1, " "))) {
            try { ServerIdentity.validate("https://10.0.0.1:47621", fingerprint); fail("accepted '$fingerprint'") } catch (error: WaslaException) { assertEquals(WaslaException.Kind.INVALID_FINGERPRINT, error.kind) }
        }
    }

    @Test
    fun pairingCodesAcceptLocalDigitsAndLeadingZeros() {
        assertEquals("00123456", PairingCode.normalized(" ٠٠١٢٣٤٥٦ "))
        assertEquals("98765432", PairingCode.normalized("۹۸۷۶۵۴۳۲"))
        assertTrue(PairingCode.isValid("٠٠١٢٣٤٥٦"))
        assertTrue(PairingCode.isValid("00123456"))
        assertTrue(PairingCode.isValid("a".repeat(16)))
        assertFalse(PairingCode.isValid("1234567"))
        assertFalse(PairingCode.isValid("123456789"))
        assertFalse(PairingCode.isValid("1234 5678"))
        assertFalse(PairingCode.isValid("a".repeat(15)))
        assertFalse(PairingCode.isValid("ب".repeat(16)))
    }

    @Test
    fun statusReadsEveryBusyShape() {
        val base = """"name": "Wasla Windows", "model": "qwen3.5:9b-coding-local", "desktop_enabled": false, "capabilities": ["chat"], "storage": {"kind": "sqlite"}"""
        assertFalse(WaslaJson.decodeFromString<ServerStatus>("""{$base}""").busyState.isBusy)
        assertFalse(WaslaJson.decodeFromString<ServerStatus>("""{$base, "busy": null}""").busyState.isBusy)
        assertFalse(WaslaJson.decodeFromString<ServerStatus>("""{$base, "busy": false}""").busyState.isBusy)
        assertFalse(WaslaJson.decodeFromString<ServerStatus>("""{$base, "busy": ""}""").busyState.isBusy)
        assertEquals("الجهاز مشغول", WaslaJson.decodeFromString<ServerStatus>("""{$base, "busy": true}""").busyState.label)
        assertEquals("إنشاء صورة", WaslaJson.decodeFromString<ServerStatus>("""{$base, "busy": "إنشاء صورة"}""").busyState.label)
        assertTrue(WaslaJson.decodeFromString<ServerStatus>("""{$base, "busy": {"task": "x"}}""").busyState.isBusy)
    }

    @Test
    fun mohassanListIsWrapped() {
        val list = WaslaJson.decodeFromString<MohassanList>("""{"conversations": [{"id": "1b4e28ba-2fa1-11d2-883f-0016d3cca427", "title": "خطة", "status": "waiting_user", "updatedAt": "2026-11-22T00:00:00.000Z", "browserAccount": null}]}""")
        assertEquals(1, list.conversations.size)
        assertEquals("ينتظر إجابتك", MohassanStatus.title(list.conversations[0].status))
    }

    @Test
    fun mohassanConversationReadsBothQuestionShapes() {
        val id = "1b4e28ba-2fa1-11d2-883f-0016d3cca427"
        val fields = WaslaJson.decodeFromString<MohassanConversation>(
            """{"id": "$id", "title": "حملة", "status": "waiting_user", "updatedAt": "x", "messages": [{"id": "$id", "role": "user", "text": "أنشئ حملة", "createdAt": "x"}],
               "question": {"id": "$id", "prompt": "أحتاج تفاصيل:", "options": [{"id": "stop", "label": "توقف هنا"}],
                 "fields": [{"id": "goal", "prompt": "ما هدف الحملة؟", "suggestions": [{"label": "مكالمات", "reason": "موقعك فيه رقم هاتف"}], "selected": [0]},
                            {"id": "places", "prompt": "أين؟", "suggestions": [{"label": "الرياض"}, {"label": "جدة"}], "multiple": true}]},
               "approval": null, "secure": null, "progress": null, "steps": [], "error": null, "configured": true, "campaign": null}"""
        )
        assertTrue(fields.question!!.hasFields)
        assertFalse(fields.question!!.acceptsText)
        assertEquals("stop", fields.question!!.stopOption?.id)
        assertEquals(listOf(0), fields.question!!.fields!![0].selected)
        assertEquals(true, fields.question!!.fields!![1].multiple)

        val clarification = WaslaJson.decodeFromString<MohassanConversation>(
            """{"id": "$id", "title": "", "status": "waiting_user", "messages": [], "steps": [],
               "question": {"id": "$id", "prompt": "أي حساب؟", "options": [{"id": "a", "label": "الأول"}, {"id": "connect", "label": "ربط"}], "action": "google_ads_connect",
                 "clarification": {"reason": "يوجد حسابان", "recommendedOptionId": "a", "allowText": true}}}"""
        )
        assertEquals(listOf("a"), clarification.question!!.phoneOptions.map { it.id })
        assertTrue(clarification.question!!.acceptsText)
        assertEquals("a", clarification.question!!.clarification?.recommendedOptionId)

        val plain = WaslaJson.decodeFromString<MohassanConversation>("""{"id": "$id", "status": "waiting_user", "question": {"id": "$id", "prompt": "اكتب", "options": []}}""")
        assertTrue(plain.question!!.acceptsText)
        assertTrue(WaslaJson.decodeFromString<MohassanConversation>("""{"id": "$id", "status": "running"}""").working)
    }

    @Test
    fun requestsLeaveAbsentFieldsOut() {
        assertEquals("""{"questionId":"q","optionId":"a"}""", WaslaJson.encodeToString(MohassanRespond("q", optionId = "a")))
        assertEquals("""{"questionId":"q","text":"نعم"}""", WaslaJson.encodeToString(MohassanRespond("q", text = "نعم")))
        assertEquals("""{"action":"click","button":"left"}""", WaslaJson.encodeToString(DesktopCommand("click", button = "left")))
        assertEquals("{}", WaslaJson.encodeToString(EmptyBody()))
        val chat = WaslaJson.encodeToString(ChatRequest(listOf(ChatMessage("user", "مرحبا")), "abc12345", "auto", remember = false, use_memory = false))
        assertEquals("""{"messages":[{"role":"user","content":"مرحبا"}],"request_id":"abc12345","mode":"auto","remember":false,"use_memory":false}""", chat)
        assertEquals("""{"prompt":"a cabin","negative_prompt":"","seed":4294967295,"request_id":"r"}""", WaslaJson.encodeToString(ImageRequest("a cabin", "", 4294967295L, "r")))
    }

    @Test
    fun chatResponseExplainsRoutesAndWarnings() {
        val answer = WaslaJson.decodeFromString<ChatResponse>(
            """{"content": "الجواب", "model": "qwen", "route": "research", "sources": [{"id": "s1", "title": "مصدر", "url": "https://example.com/a", "snippet": "..."}, {"id": "s2", "title": "محلي", "url": "http://example.com/b"}],
               "evidence": {"level": "grounded", "note": null}, "warnings": ["search_query_simplified", "something_new"], "timing_ms": 1234.5, "cache_hit": false, "memory_saved": true, "conversation_id": "c", "usage": {"provider": "local"}}"""
        )
        assertEquals("بحث بمصادر", answer.routeTitle)
        assertEquals("مستندة إلى أدلة", answer.evidence?.title)
        assertEquals("https://example.com/a", answer.sources!![0].safeUrl)
        assertNull(answer.sources!![1].safeUrl)
        assertEquals("بُسّطت صياغة البحث للتركيز على موضوع سؤالك.", ChatResponse.warningMessage(answer.warnings!![0]))
        assertEquals("تفاصيل الأدلة محدودة. راجع المصادر قبل الاعتماد على الإجابة.", ChatResponse.warningMessage(answer.warnings!![1]))
    }

    @Test
    fun onlySafeHttpsLinksOpen() {
        assertEquals("https://example.com/path?q=1", safeHttpsUrl("https://example.com/path?q=1"))
        assertNull(safeHttpsUrl("http://example.com"))
        assertNull(safeHttpsUrl("https://user@example.com"))
        assertNull(safeHttpsUrl("https://example.com/a\\b"))
        assertNull(safeHttpsUrl("https://example.com/a\u0007"))
        assertNull(safeHttpsUrl("javascript:alert(1)"))
        assertNull(safeHttpsUrl(null))
        assertEquals("example.com", hostOf("https://example.com/x"))
    }

    @Test
    fun approvalCardsShowWhatTheGateBoundThemTo() {
        // A conversation from the server of 2026-11-23: the approval names its exact target, and the run view the phone
        // does not draw yet is skipped (ignoreUnknownKeys), never a decoding failure.
        val bound = WaslaJson.decodeFromString<MohassanConversation>("""{"id":"c","status":"waiting_approval","approval":{"id":"a","prompt":"أريد نقل الملف «old.txt» إلى سلة المحذوفات. هل أتابع؟","detail":"لا حذف نهائي.","target":"old.txt","consequence":"يُنقل العنصر إلى سلة المحذوفات.","reversible":true},"run":{"id":"r","phase":"awaiting_approval","permissions":[]}}""")
        assertEquals(listOf("الهدف: old.txt", "ما سيحدث: يُنقل العنصر إلى سلة المحذوفات.", "يمكن التراجع عنه."), bound.approval?.bindingLines)
        val older = WaslaJson.decodeFromString<MohassanApproval>("""{"id":"a","prompt":"هل أتابع؟","detail":"d"}""")
        assertEquals(emptyList<String>(), older.bindingLines)
        val unknown = WaslaJson.decodeFromString<MohassanApproval>("""{"id":"a","prompt":"p","target":"POST https://shop.test/pay","consequence":"","reversible":null}""")
        assertEquals(listOf("الهدف: POST https://shop.test/pay"), unknown.bindingLines)
    }

    @Test
    fun tokensAndIdsAreChecked() {
        assertTrue(WaslaStore.validToken("x".repeat(32)))
        assertFalse(WaslaStore.validToken("x".repeat(31)))
        assertFalse(WaslaStore.validToken("x".repeat(31) + " "))
        assertFalse(WaslaStore.validToken("x".repeat(31) + "\n"))
        assertTrue(isUuid("1B4E28BA-2FA1-11D2-883F-0016D3CCA427"))
        assertFalse(isUuid("1b4e28ba2fa111d2883f0016d3cca427"))
        assertFalse(isUuid(null))
        assertTrue(mohassanTextFits("م".repeat(4_000)))
        assertFalse(mohassanTextFits("م".repeat(4_001)))
        assertEquals(1, "😀".codePointLength())
    }
}
