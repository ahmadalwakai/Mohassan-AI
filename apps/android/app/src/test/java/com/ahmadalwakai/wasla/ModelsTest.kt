package com.ahmadalwakai.wasla

import kotlinx.serialization.decodeFromString
import kotlinx.serialization.encodeToString
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

// Chat projection and request schemas retrieved 2026-11-27.
// https://github.com/ahmadalwakai/Mohassan-AI/blob/29448ae/packages/contracts/src/command-chat.ts
class ModelsTest {
    @Test
    fun mohassanListIsWrapped() {
        val list = WaslaJson.decodeFromString<ChatList>("""{"conversations": [{"id": "1b4e28ba-2fa1-11d2-883f-0016d3cca427", "title": "خطة", "status": "waiting_user", "updatedAt": "2026-11-22T00:00:00.000Z", "browserAccount": null}]}""")
        assertEquals(1, list.conversations.size)
        assertEquals("ينتظر إجابتك", ChatStatus.title(list.conversations[0].status))
    }

    @Test
    fun mohassanConversationReadsBothQuestionShapes() {
        val id = "1b4e28ba-2fa1-11d2-883f-0016d3cca427"
        val fields = WaslaJson.decodeFromString<ChatConversation>(
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

        val clarification = WaslaJson.decodeFromString<ChatConversation>(
            """{"id": "$id", "title": "", "status": "waiting_user", "messages": [], "steps": [],
               "question": {"id": "$id", "prompt": "أي حساب؟", "options": [{"id": "a", "label": "الأول"}, {"id": "connect", "label": "ربط"}], "action": "google_ads_connect",
                 "clarification": {"reason": "يوجد حسابان", "recommendedOptionId": "a", "allowText": true}}}"""
        )
        assertEquals(listOf("a"), clarification.question!!.phoneOptions.map { it.id })
        assertTrue(clarification.question!!.acceptsText)
        assertEquals("a", clarification.question!!.clarification?.recommendedOptionId)

        val plain = WaslaJson.decodeFromString<ChatConversation>("""{"id": "$id", "status": "waiting_user", "question": {"id": "$id", "prompt": "اكتب", "options": []}}""")
        assertTrue(plain.question!!.acceptsText)
        assertTrue(WaslaJson.decodeFromString<ChatConversation>("""{"id": "$id", "status": "running"}""").working)
    }

    @Test
    fun requestsLeaveAbsentFieldsOut() {
        assertEquals("""{"questionId":"q","optionId":"a"}""", WaslaJson.encodeToString(ChatRespond("q", optionId = "a")))
        assertEquals("{}", WaslaJson.encodeToString(EmptyBody))
        assertEquals("""{"goal":"مرحبا"}""", WaslaJson.encodeToString(ChatCreate(goal = "مرحبا")))
        assertEquals("""{"text":""}""", WaslaJson.encodeToString(ChatSend(text = "")))
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
        val bound = WaslaJson.decodeFromString<ChatConversation>("""{"id":"c","status":"waiting_approval","approval":{"id":"a","prompt":"أريد نقل الملف «old.txt» إلى سلة المحذوفات. هل أتابع؟","detail":"لا حذف نهائي.","target":"old.txt","consequence":"يُنقل العنصر إلى سلة المحذوفات.","reversible":true},"run":{"id":"r","phase":"awaiting_approval","permissions":[]}}""")
        assertEquals(listOf("الهدف: old.txt", "ما سيحدث: يُنقل العنصر إلى سلة المحذوفات.", "يمكن التراجع عنه."), bound.approval?.bindingLines)
        val older = WaslaJson.decodeFromString<ChatApproval>("""{"id":"a","prompt":"هل أتابع؟","detail":"d"}""")
        assertEquals(emptyList<String>(), older.bindingLines)
        val unknown = WaslaJson.decodeFromString<ChatApproval>("""{"id":"a","prompt":"p","target":"POST https://shop.test/pay","consequence":"","reversible":null}""")
        assertEquals(listOf("الهدف: POST https://shop.test/pay"), unknown.bindingLines)
    }

    // Owner snapshot projection checks, retrieved 2026-11-27.
    // https://github.com/ahmadalwakai/Mohassan-AI/blob/2a4498e1de09edf9c4a7b2847754d197e5146b85/apps/android/app/src/test/java/com/ahmadalwakai/wasla/ModelsTest.kt
    @Test
    fun campaignEvidenceUsesOnlyMatchingTaskEventsBeforeItsTerminalResult() {
        val source = """{"taskId":"campaign-1","lastSeq":8,"events":[
          {"taskId":"campaign-1","seq":2,"type":"account_observed","at":"2026-11-24T04:00:00Z","data":{"customerId":"1234567890","currency":"GBP","timeZone":"Europe/London","range":{"start":"2026-10-25","end":"2026-11-23"},"checkedAt":"2026-11-24T04:00:00Z"}},
          {"taskId":"campaign-1","seq":3,"type":"verification_completed","at":"2026-11-24T04:01:00Z","data":{"authority":"local","scope":"local_text","passed":true,"checks":[{"id":"length","passed":true,"detail":"Text fits"}]}},
          {"taskId":"campaign-1","seq":4,"type":"verification_completed","at":"2026-11-24T04:02:00Z","data":{"authority":"google_ads_api","scope":"readback","passed":false,"checks":[{"id":"status","passed":false,"detail":"Expected PAUSED; observed ENABLED"}]}},
          {"taskId":"another-task","seq":5,"type":"verification_completed","data":{"authority":"google_ads_api","scope":"readback","passed":true,"checks":[]}},
          {"taskId":"campaign-1","seq":6,"type":"external_operation_reconciled","data":{"operation":"create_paused","outcome":"mismatch","campaignResourceName":"customers/1234567890/campaigns/55","readAttempts":1}},
          {"taskId":"campaign-1","seq":7,"type":"task_failed","data":{"message":"Mismatch"}},
          {"taskId":"campaign-1","seq":8,"type":"verification_completed","data":{"authority":"google_ads_api","scope":"readback","passed":true,"checks":[]}}
        ]}"""
        val campaign = WaslaJson.decodeFromString<MohassanCampaignStream>(source)
        assertEquals("1234567890", campaign.account?.customerId)
        assertEquals("GBP", campaign.account?.currency)
        assertEquals("Europe/London", campaign.account?.timeZone)
        assertEquals("2026-10-25", campaign.account?.range?.start)
        assertEquals(2, campaign.verifications.size)
        val remote = campaign.verifications.first { it.value.scope == "readback" }
        assertEquals("google_ads_api", remote.value.authority)
        assertFalse(remote.value.passed)
        assertEquals("Expected PAUSED; observed ENABLED", remote.value.checks.single().detail)
        assertEquals("mismatch", campaign.operations.single().outcome)
        assertNull(campaign.completion)
    }

    @Test
    fun campaignEvidenceToleratesUnknownEventsAndDoesNotTreatInvalidDataAsAReadback() {
        val campaign = WaslaJson.decodeFromString<MohassanCampaignStream>("""{"taskId":"campaign-1","events":[
          {"taskId":"campaign-1","seq":1,"type":"future_event","data":{"execute":"create another campaign"}},
          {"taskId":"campaign-1","seq":2,"type":"verification_completed","data":{"scope":"readback","passed":true}},
          {"taskId":"campaign-1","seq":3,"type":"task_completed","data":{"outcome":"draft_checked","campaignResourceName":null,"conversionTrackingProven":false}}
        ]}""")
        assertNull(campaign.account)
        assertEquals(emptyList<MohassanCampaignObservedCheck>(), campaign.verifications)
        assertEquals("draft_checked", campaign.completion?.outcome)
    }

    @Test
    fun idsAndTextLimitsAreChecked() {
        assertTrue(isUuid("1B4E28BA-2FA1-11D2-883F-0016D3CCA427"))
        assertFalse(isUuid("1b4e28ba2fa111d2883f0016d3cca427"))
        assertFalse(isUuid(null))
        assertTrue(mohassanTextFits("م".repeat(4_000)))
        assertFalse(mohassanTextFits("م".repeat(4_001)))
        assertEquals(1, "😀".codePointLength())
    }
}
