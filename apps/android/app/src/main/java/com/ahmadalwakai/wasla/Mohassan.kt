package com.ahmadalwakai.wasla

import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.serialization.encodeToString

// Mohassan's chat on the phone. The computer service forwards these calls to the
// Mohassan server on the same computer; Mohassan runs the work with its own brain,
// questions and approvals, exactly as in the web workspace.
//
// Two shapes of question exist. Older servers send `clarification` and accept a typed
// answer through `respond`; newer servers send `fields` and read a typed answer as the
// next message. The phone speaks both: an option always goes through `respond`, a typed
// answer goes through `respond` only when the question says it allows one, and field
// answers travel as one numbered message, as the web composes them.

val WaslaStore.mohassanLinked: Boolean get() = mohassanLink?.linked == true
val WaslaStore.mohassanBusy: Boolean get() = mohassanSending || mohassanConversation?.working == true
/** While the assistant waits for an answer, an approval or a step, the card answers it, not the composer. */
val WaslaStore.mohassanWaiting: Boolean get() = mohassanConversation?.status?.let { it in MohassanStatus.WAITING } == true

internal suspend fun WaslaStore.refreshMohassanLink() {
    val client = client ?: run { mohassanLink = null; return }
    val epoch = sessionEpoch
    try {
        val link: MohassanLink = client.get("/v1/mohassan/status", timeoutSeconds = 30)
        if (epoch == sessionEpoch) mohassanLink = link
    } catch (error: Exception) {
        if (error is CancellationException) throw error
        if (epoch != sessionEpoch) return
        // An older computer service has no Mohassan routes: keep the local chat.
        // Other failures keep the last known state instead of switching screens.
        if (error is WaslaException && error.isServer404) mohassanLink = null
    }
}

fun WaslaStore.loadMohassanList() {
    val client = client ?: return
    val epoch = sessionEpoch
    viewModelScope.launch {
        try {
            val list: MohassanList = client.get("/v1/mohassan/conversations", timeoutSeconds = 30)
            if (epoch != sessionEpoch) return@launch
            mohassanList.clear()
            mohassanList.addAll(list.conversations)
        } catch (error: Exception) {
            if (error is CancellationException) throw error
            if (epoch == sessionEpoch) show(error)
        }
    }
}

fun WaslaStore.newMohassanChat() {
    mohassanEpoch += 1
    stopMohassanPolling()
    mohassanConversation = null
    mohassanSending = false
    mohassanPendingText = null
    mohassanDraft = ""
}

fun WaslaStore.openMohassan(id: String) {
    if (!isUuid(id)) return
    newMohassanChat()
    viewModelScope.launch { refreshMohassan(id) }
}

internal suspend fun WaslaStore.refreshMohassan(id: String) {
    val client = client ?: return
    if (!isUuid(id)) return
    val epoch = sessionEpoch
    val conversationEpoch = mohassanEpoch
    try {
        val detail: MohassanConversation = client.get("/v1/mohassan/conversations/$id", timeoutSeconds = 30)
        if (epoch != sessionEpoch || conversationEpoch != mohassanEpoch) return
        mohassanConversation = detail
        if (detail.working) pollMohassan() else stopMohassanPolling()
    } catch (error: Exception) {
        if (error is CancellationException) throw error
        if (epoch == sessionEpoch && conversationEpoch == mohassanEpoch) show(error)
    }
}

fun WaslaStore.sendMohassan(text: String): Boolean {
    val client = client ?: run { show(WaslaException.notPaired()); return false }
    val clean = text.trim()
    if (clean.isEmpty() || mohassanBusy || mohassanWaiting) return false
    if (!mohassanTextFits(clean)) { errorMessage = "الرسالة تتجاوز ٤٬٠٠٠ حرف. اختصرها قبل الإرسال."; return false }
    val existing = mohassanConversation?.id
    val epoch = sessionEpoch
    val conversationEpoch = mohassanEpoch
    mohassanSending = true
    mohassanPendingText = clean
    viewModelScope.launch {
        try {
            val id = if (existing != null && isUuid(existing)) {
                client.send("/v1/mohassan/conversations/$existing/messages", MohassanSend(clean), timeoutSeconds = 45)
                existing
            } else {
                val created: MohassanCreated = client.post("/v1/mohassan/conversations", MohassanCreate(clean), timeoutSeconds = 45)
                if (!isUuid(created.id)) throw WaslaException.invalidResponse()
                created.id
            }
            if (epoch != sessionEpoch || conversationEpoch != mohassanEpoch) return@launch
            refreshMohassan(id)
        } catch (error: Exception) {
            if (error is CancellationException) throw error
            // A lost response is not proof that nothing started; nothing is sent again automatically.
            if (epoch == sessionEpoch && conversationEpoch == mohassanEpoch) show(error)
        } finally {
            if (epoch == sessionEpoch && conversationEpoch == mohassanEpoch) { mohassanSending = false; mohassanPendingText = null }
        }
    }
    return true
}

/** An option, or a typed answer, to the pending question. */
fun WaslaStore.answerMohassan(option: MohassanOption?, text: String?) {
    val conversation = mohassanConversation ?: return
    val question = conversation.question ?: return
    if (conversation.status != MohassanStatus.WAITING_USER) return
    val typed = text?.trim().orEmpty()
    when {
        option != null -> actOnMohassan(conversation.id, "respond", MohassanRespond(question.id, optionId = option.id))
        typed.isEmpty() -> return
        question.clarification != null -> actOnMohassan(conversation.id, "respond", MohassanRespond(question.id, text = typed))
        else -> actOnMohassan(conversation.id, "messages", MohassanSend(typed))
    }
}

/** The answers to a several-questions card, already composed as one numbered reply. */
fun WaslaStore.answerMohassanFields(reply: String) {
    val conversation = mohassanConversation ?: return
    if (conversation.status != MohassanStatus.WAITING_USER || conversation.question?.hasFields != true) return
    val clean = reply.trim()
    if (clean.isEmpty() || !mohassanTextFits(clean)) return
    actOnMohassan(conversation.id, "messages", MohassanSend(clean))
}

fun WaslaStore.approveMohassan(approved: Boolean) {
    val conversation = mohassanConversation ?: return
    val approval = conversation.approval ?: return
    if (conversation.status != MohassanStatus.WAITING_APPROVAL) return
    actOnMohassan(conversation.id, "approve", MohassanApprove(approval.id, approved))
}

/** Available only when the server supplied a read-only recovery offer; never retries a write. */
fun WaslaStore.resumeMohassanCampaign() {
    val conversation = mohassanConversation ?: return
    if (!conversation.canReviewSavedCampaign || mohassanBusy) return
    val recovery = conversation.campaignRecovery ?: return
    val key = recovery.requestKey ?: return
    actOnMohassan(conversation.id, "campaign/resume", MohassanCampaignResume(recovery.runId), idempotencyKey = key)
}

/** Stopping is always allowed, even while another call is in flight. */
fun WaslaStore.cancelMohassan() {
    val conversation = mohassanConversation ?: return
    actOnMohassan(conversation.id, "cancel", EmptyBody(), allowWhileSending = true)
}

fun WaslaStore.deleteMohassan(id: String) {
    val client = client ?: return
    if (!isUuid(id)) return
    val epoch = sessionEpoch
    viewModelScope.launch {
        try {
            client.delete("/v1/mohassan/conversations/$id")
            if (epoch != sessionEpoch) return@launch
            mohassanList.removeAll { it.id == id }
            if (mohassanConversation?.id == id) newMohassanChat()
        } catch (error: Exception) {
            if (error is CancellationException) throw error
            if (epoch == sessionEpoch) show(error)
        }
    }
}

private inline fun <reified Body> WaslaStore.actOnMohassan(id: String, action: String, body: Body, allowWhileSending: Boolean = false, idempotencyKey: String? = null) {
    val client = client ?: return
    if (!isUuid(id) || (!allowWhileSending && mohassanSending)) return
    val epoch = sessionEpoch
    val conversationEpoch = mohassanEpoch
    val encoded = WaslaJson.encodeToString(body).toByteArray(Charsets.UTF_8)
    mohassanSending = true
    viewModelScope.launch {
        try {
            client.data("/v1/mohassan/conversations/$id/$action", "POST", encoded, timeoutSeconds = 45, idempotencyKey = idempotencyKey)
            if (epoch != sessionEpoch || conversationEpoch != mohassanEpoch) return@launch
            refreshMohassan(id)
        } catch (error: Exception) {
            if (error is CancellationException) throw error
            if (epoch == sessionEpoch && conversationEpoch == mohassanEpoch) show(error)
        } finally {
            if (epoch == sessionEpoch && conversationEpoch == mohassanEpoch) mohassanSending = false
        }
    }
}

/** Reads the conversation every two seconds while Mohassan works, in the foreground only. */
internal fun WaslaStore.pollMohassan() {
    val client = client ?: return
    val id = mohassanConversation?.id ?: return
    if (mohassanPollJob != null || !foreground || !isUuid(id)) return
    mohassanPollId += 1
    val pollId = mohassanPollId
    val epoch = sessionEpoch
    val conversationEpoch = mohassanEpoch
    mohassanPollJob = viewModelScope.launch {
        var failures = 0
        try {
            while (isActive) {
                delay(2_000)
                if (!isActive || !foreground || epoch != sessionEpoch || conversationEpoch != mohassanEpoch) return@launch
                try {
                    val detail: MohassanConversation = client.get("/v1/mohassan/conversations/$id", timeoutSeconds = 30)
                    if (!isActive || epoch != sessionEpoch || conversationEpoch != mohassanEpoch) return@launch
                    failures = 0
                    mohassanConversation = detail
                    if (!detail.working) return@launch
                } catch (error: Exception) {
                    if (error is CancellationException) throw error
                    failures += 1
                    if (failures >= 5) {
                        if (epoch == sessionEpoch && conversationEpoch == mohassanEpoch) show(error)
                        return@launch
                    }
                }
            }
        } finally {
            if (pollId == mohassanPollId) mohassanPollJob = null
        }
    }
}

internal fun WaslaStore.stopMohassanPolling() {
    mohassanPollId += 1
    mohassanPollJob?.cancel()
    mohassanPollJob = null
}

internal fun WaslaStore.resetMohassan() {
    newMohassanChat()
    mohassanList.clear()
    mohassanLink = null
}

internal fun WaslaStore.mohassanSceneChanged(active: Boolean) {
    if (active) {
        mohassanConversation?.id?.let { id -> viewModelScope.launch { refreshMohassan(id) } }
    } else {
        stopMohassanPolling()
    }
}
