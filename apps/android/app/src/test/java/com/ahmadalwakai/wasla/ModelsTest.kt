package com.ahmadalwakai.wasla

import kotlinx.serialization.decodeFromString
import kotlinx.serialization.encodeToString
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ModelsTest {
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
        assertEquals("{}", WaslaJson.encodeToString(EmptyBody()))
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
    fun identifiersAndMessageLengthAreChecked() {
        assertTrue(isUuid("1B4E28BA-2FA1-11D2-883F-0016D3CCA427"))
        assertFalse(isUuid("1b4e28ba2fa111d2883f0016d3cca427"))
        assertFalse(isUuid(null))
        assertTrue(mohassanTextFits("م".repeat(4_000)))
        assertFalse(mohassanTextFits("م".repeat(4_001)))
    }
}
