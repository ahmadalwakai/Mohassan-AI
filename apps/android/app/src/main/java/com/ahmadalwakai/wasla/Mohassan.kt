package com.ahmadalwakai.wasla

import android.content.ContentResolver
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.ImageDecoder
import android.net.Uri
import android.os.Build
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.util.Base64
import kotlin.math.roundToInt

const val MAX_CHAT_ATTACHMENTS = 4
private const val PENDING_KEY = "cloud.chat.pending"
private const val CHAT_IMAGES = "/api/chat/images"

val WaslaStore.mohassanBusy: Boolean get() = mohassanSending || pendingMohassan != null

fun WaslaStore.loadMohassanList() {
    viewModelScope.launch { refreshMohassanList() }
}

internal suspend fun WaslaStore.refreshMohassanList() {
    val client = client ?: return
    val epoch = sessionEpoch
    try {
        val list: MohassanList = client.get(CHAT_CONVERSATIONS)
        if (epoch != sessionEpoch) return
        mohassanList.clear()
        mohassanList.addAll(list.conversations)
        requestKeys = list.requestKeys == true
        list.capabilities?.let { mohassanCapabilities = it }
    } catch (error: WaslaException) {
        if (epoch == sessionEpoch) show(error)
    }
}

fun WaslaStore.newMohassanChat() {
    mohassanEpoch += 1
    stopMohassanPolling()
    mohassanConversation = null
    mohassanScreen = null
    mohassanDraft = ""
    mohassanAttachments.clear()
    mohassanUploading = false
    mohassanSecureBusy = false
}

fun WaslaStore.openMohassan(id: String) {
    if (!isUuid(id) || mohassanSending) return
    newMohassanChat()
    viewModelScope.launch { refreshMohassan(id) }
}

private suspend fun WaslaStore.refreshMohassan(id: String) {
    val client = client ?: return
    if (!isUuid(id)) return
    val epoch = sessionEpoch
    val screen = mohassanEpoch
    try {
        val detail: MohassanConversation = client.get("$CHAT_CONVERSATIONS/$id")
        if (epoch == sessionEpoch && screen == mohassanEpoch && detail.id == id) present(detail)
    } catch (error: WaslaException) {
        if (epoch == sessionEpoch && screen == mohassanEpoch) show(error)
    }
}

private fun WaslaStore.present(detail: MohassanConversation) {
    val previous = mohassanConversation
    if (previous?.browser != detail.browser) mohassanScreen = null
    mohassanConversation = detail
    detail.capabilities?.let { mohassanCapabilities = it }
    pollMohassan()
}

fun WaslaStore.sendMohassan(text: String): Boolean {
    if (!signedIn || mohassanBusy || mohassanSecureBusy || mohassanUploading ||
        (mohassanConversation?.status == MohassanStatus.WAITING_USER && mohassanConversation?.question?.hasFields == true)
    ) return false
    val clean = text.trim()
    val photos = mohassanAttachments.toList()
    if (clean.isEmpty() && photos.isEmpty()) return false
    if (!mohassanTextFits(clean)) {
        errorMessage = "الرسالة تتجاوز ٤٬٠٠٠ حرف. اختصرها قبل الإرسال."
        return false
    }
    val ids = photos.map { it.id }.takeIf { it.isNotEmpty() }
    val conversation = mohassanConversation
    val id = conversation?.id
    val request = if (id == null) {
        pending(PendingRequest.Kind.CREATE, null, clean, MohassanCreate(clean.takeIf(String::isNotEmpty), ids), photos)
    } else {
        val questionId = conversation.question?.id?.takeIf { conversation.status == MohassanStatus.WAITING_USER }
        pending(PendingRequest.Kind.MESSAGE, id, clean, MohassanSend(clean, questionId = questionId, images = ids), photos)
    }
    mohassanDraft = ""
    mohassanAttachments.clear()
    submit(request)
    return true
}

private inline fun <reified Body> pending(
    kind: PendingRequest.Kind,
    id: String?,
    text: String,
    body: Body,
    attachments: List<ChatAttachment> = emptyList(),
): PendingRequest = PendingRequest(newRequestId(), kind, id, text, encode(body).decodeToString(), attachments, createdAt = System.currentTimeMillis())

fun WaslaStore.answerMohassan(option: MohassanOption?, text: String?) {
    val conversation = mohassanConversation ?: return
    val question = conversation.question ?: return
    if (conversation.status != MohassanStatus.WAITING_USER || mohassanBusy) return
    if (option != null) {
        submit(pending(PendingRequest.Kind.OPTION, conversation.id, option.label, MohassanRespond(question.id, option.id)))
    } else if (!text.isNullOrBlank() && question.acceptsText) {
        sendMohassan(text)
    }
}

fun WaslaStore.answerMohassanFields(answers: List<ChatFieldAnswer>) {
    val conversation = mohassanConversation ?: return
    val question = conversation.question ?: return
    if (conversation.status != MohassanStatus.WAITING_USER || mohassanBusy) return
    val clean = answers.map { it.copy(value = it.value.trim()) }
    if (clean.isEmpty() || clean.map { it.fieldId } != question.fields.orEmpty().map { it.id } ||
        clean.any { it.value.isEmpty() }
    ) return
    val summary = if (clean.size == 1) clean[0].value else clean.mapIndexed { index, answer ->
        "${index + 1}. ${answer.value}"
    }.joinToString("\n")
    if (!mohassanTextFits(summary)) {
        errorMessage = "الإجابات تتجاوز ٤٬٠٠٠ حرف. اختصرها قبل الإرسال."
        return
    }
    submit(pending(PendingRequest.Kind.FIELDS, conversation.id, summary, MohassanSend("", question.id, clean)))
}

fun WaslaStore.approveMohassan(approved: Boolean) {
    val conversation = mohassanConversation ?: return
    val approval = conversation.approval ?: return
    if (conversation.status != MohassanStatus.WAITING_APPROVAL || mohassanBusy) return
    val label = if (approved) "موافق" else "لا تفعل"
    submit(pending(PendingRequest.Kind.APPROVE, conversation.id, label, MohassanApprove(approval.id, approved)))
}

private fun WaslaStore.submit(request: PendingRequest) {
    val client = client ?: return
    if (!request.valid() || mohassanSending) return
    val epoch = sessionEpoch
    val screen = mohassanEpoch
    mohassanSending = true
    setPending(request.copy(phase = PendingRequest.Phase.SENDING, note = null))
    mohassanSendJob = viewModelScope.launch {
        try {
            val reply = try {
                sendPending(client, request,
                    mayRetry = { epoch == sessionEpoch && foreground && requestKeys && pendingMohassan?.key == request.key })
            } catch (error: WaslaException) {
                if (epoch != sessionEpoch) return@launch
                val reason = error.message.orEmpty()
                if (error.refusesSend()) {
                    setPending(null)
                    if (request.fromComposer) handBack(request)
                    errorMessage = reason
                    request.conversationId?.takeIf { it == mohassanConversation?.id }?.let { refreshMohassan(it) }
                } else {
                    setPending(request.copy(phase = PendingRequest.Phase.UNCONFIRMED, note = reason))
                }
                return@launch
            }
            if (epoch != sessionEpoch || pendingMohassan?.key != request.key) return@launch
            setPending(null)
            val detail = runCatching { decode<MohassanConversation>(reply.data) }.getOrNull()
            if (screen == mohassanEpoch &&
                (request.belongsTo(mohassanConversation?.id) || mohassanConversation == null && restoredFor(request))
            ) {
                val id = request.conversationId
                if (detail != null && isUuid(detail.id) && (id == null || detail.id == id)) present(detail)
                else if (id != null) refreshMohassan(id)
            }
            if (request.kind == PendingRequest.Kind.CREATE) refreshMohassanList()
        } finally {
            if (epoch == sessionEpoch) {
                mohassanSending = false
                mohassanSendJob = null
            }
        }
    }
}

private fun WaslaStore.restoredFor(request: PendingRequest): Boolean = mohassanEpoch == 0 && request.conversationId != null

internal fun WaslaStore.persistPending(request: PendingRequest?) {
    prefs.edit().putString(PENDING_KEY, request?.let { encode(it).decodeToString() }).apply()
}

private fun WaslaStore.setPending(request: PendingRequest?) {
    pendingMohassan = request
    persistPending(request)
}

internal fun WaslaStore.restorePendingMohassan() {
    val data = prefs.getString(PENDING_KEY, null) ?: return
    val request = runCatching { decode<PendingRequest>(data.encodeToByteArray()) }.getOrNull()?.takeIf { it.valid() }
    setPending(request?.copy(phase = PendingRequest.Phase.UNCONFIRMED))
}

internal fun WaslaStore.resumePendingMohassan() {
    if (foreground) resendPendingMohassan()
}

fun WaslaStore.resendPendingMohassan() {
    val request = pendingMohassan ?: return
    if (request.phase == PendingRequest.Phase.UNCONFIRMED && requestKeys && request.resendable()) submit(request)
}

fun WaslaStore.dropPendingMohassan() {
    val request = pendingMohassan?.takeIf { it.phase == PendingRequest.Phase.UNCONFIRMED } ?: return
    setPending(null)
    handBack(request)
}

fun WaslaStore.checkPendingMohassan() {
    val request = pendingMohassan ?: return
    val id = request.conversationId ?: return loadMohassanList()
    if (id == mohassanConversation?.id) viewModelScope.launch { refreshMohassan(id) } else openMohassan(id)
}

private fun WaslaStore.handBack(request: PendingRequest) {
    if (!request.fromComposer) return
    mohassanDraft = listOf(request.text, mohassanDraft).filter(String::isNotEmpty).joinToString("\n")
    val photos = (request.attachments + mohassanAttachments).distinctBy { it.id }.take(MAX_CHAT_ATTACHMENTS)
    mohassanAttachments.clear()
    mohassanAttachments.addAll(photos)
}

fun WaslaStore.secureMohassan(action: String, values: Map<String, String>? = null) {
    val conversation = mohassanConversation ?: return
    val secure = conversation.secure ?: return
    if (conversation.status != MohassanStatus.WAITING_INPUT || mohassanSecureBusy) return
    callMohassan(conversation.id, "secure", ChatSecureSubmit(secure.id, action, values), timeoutSeconds = 120)
}

fun WaslaStore.cancelMohassan() {
    val id = mohassanConversation?.id ?: return
    callMohassan(id, "cancel", EmptyBody(), timeoutSeconds = 45)
}

private inline fun <reified Body> WaslaStore.callMohassan(id: String, route: String, body: Body, timeoutSeconds: Int) {
    val client = client ?: return
    if (!isUuid(id)) return
    val epoch = sessionEpoch
    val screen = mohassanEpoch
    val secure = route == "secure"
    if (secure) mohassanSecureBusy = true
    viewModelScope.launch {
        try {
            client.request(CloudRequest("$CHAT_CONVERSATIONS/$id/$route", "POST", encode(body), timeoutSeconds = timeoutSeconds))
            if (epoch == sessionEpoch && screen == mohassanEpoch) refreshMohassan(id)
        } catch (error: WaslaException) {
            if (epoch == sessionEpoch && screen == mohassanEpoch) {
                show(error)
                if (secure) refreshMohassan(id)
            }
        } finally {
            if (secure && epoch == sessionEpoch && screen == mohassanEpoch) mohassanSecureBusy = false
        }
    }
}

fun WaslaStore.feedbackMohassan(verdict: String, messageId: String, onResult: (Boolean) -> Unit) {
    val client = client ?: return
    val id = mohassanConversation?.id ?: return
    if (!isUuid(id) || !isUuid(messageId)) return
    val epoch = sessionEpoch
    viewModelScope.launch {
        var accepted = false
        try {
            client.request(CloudRequest("$CHAT_CONVERSATIONS/$id/feedback", "POST", encode(ChatFeedback(messageId, verdict))))
            accepted = true
        } catch (error: WaslaException) {
            if (epoch == sessionEpoch) show(error)
        } finally {
            if (epoch == sessionEpoch) onResult(accepted)
        }
    }
}

fun WaslaStore.deleteMohassan(id: String) {
    val client = client ?: return
    if (!isUuid(id)) return
    val epoch = sessionEpoch
    viewModelScope.launch {
        try {
            client.request(CloudRequest("$CHAT_CONVERSATIONS/$id", "DELETE"))
            if (epoch != sessionEpoch) return@launch
            mohassanList.removeAll { it.id == id }
            val pending = pendingMohassan
            if (pending?.conversationId == id && pending.phase == PendingRequest.Phase.UNCONFIRMED) setPending(null)
            if (mohassanConversation?.id == id) newMohassanChat()
        } catch (error: WaslaException) {
            if (epoch == sessionEpoch) show(error)
        }
    }
}

private fun WaslaStore.pollMohassan() {
    val client = client ?: return
    val id = mohassanConversation?.id ?: return
    if (!foreground || mohassanPollJob?.isActive == true) return
    val epoch = sessionEpoch
    val screen = mohassanEpoch
    mohassanPollJob = viewModelScope.launch {
        var failures = 0
        while (isActive && foreground && epoch == sessionEpoch && screen == mohassanEpoch) {
            val current = mohassanConversation ?: return@launch
            val version = current.version
            if (version == null) {
                if (!current.working) return@launch
                delay(2_000)
            }
            val query = if (version == null) emptyMap() else mapOf("since" to version, "wait" to "8000")
            try {
                val detail: MohassanConversation = client.get("$CHAT_CONVERSATIONS/$id", timeoutSeconds = 20, query = query)
                if (epoch != sessionEpoch || screen != mohassanEpoch || detail.id != id) return@launch
                // A faster mutation/read may have updated the screen while this poll was held.
                if (mohassanConversation?.version == version) present(detail)
                failures = 0
            } catch (error: WaslaException) {
                if (epoch != sessionEpoch || screen != mohassanEpoch) return@launch
                failures += 1
                if (failures >= 6) {
                    show(error)
                    return@launch
                }
                delay(minOf(2_000L * failures, 10_000L))
            }
        }
    }
}

private fun WaslaStore.stopMohassanPolling() {
    mohassanPollJob?.cancel()
    mohassanPollJob = null
}

internal fun WaslaStore.mohassanSceneChanged(active: Boolean) {
    if (!active) {
        stopMohassanPolling()
        return
    }
    val id = mohassanConversation?.id
    viewModelScope.launch {
        if (id != null) refreshMohassan(id) else refreshMohassanList()
        resumePendingMohassan()
    }
}

internal fun WaslaStore.resetMohassan() {
    newMohassanChat()
    mohassanSendJob?.cancel()
    mohassanSendJob = null
    mohassanSending = false
    setPending(null)
    mohassanList.clear()
    requestKeys = false
    mohassanCapabilities = null
    mohassanImagesAvailable = false
    mohassanImages.clear()
    loadingImages.clear()
}

internal suspend fun WaslaStore.checkMohassanImages() {
    val client = client ?: return
    val epoch = sessionEpoch
    try {
        val reply: ChatImageAvailability = client.get(CHAT_IMAGES, timeoutSeconds = 15)
        if (epoch == sessionEpoch) mohassanImagesAvailable = reply.available
    } catch (error: WaslaException) {
        if (epoch == sessionEpoch) mohassanImagesAvailable = false
    }
}

fun WaslaStore.uploadMohassanImages(uris: List<Uri>) {
    val client = client ?: return
    val remaining = MAX_CHAT_ATTACHMENTS - mohassanAttachments.size
    if (mohassanUploading || remaining <= 0 || uris.isEmpty()) return
    val epoch = sessionEpoch
    val screen = mohassanEpoch
    mohassanUploading = true
    viewModelScope.launch {
        try {
            for (uri in uris.take(remaining)) {
                if (epoch != sessionEpoch || screen != mohassanEpoch) break
                val prepared = withContext(Dispatchers.IO) { preparePhoto(app.contentResolver, uri) }
                if (epoch != sessionEpoch || screen != mohassanEpoch) break
                if (prepared == null) {
                    errorMessage = "تعذّر قراءة هذه الصورة."
                    continue
                }
                try {
                    val upload = ChatImageUpload("image/jpeg", Base64.getEncoder().encodeToString(prepared.jpeg))
                    val image: ChatImageRef = client.post(CHAT_IMAGES, upload, timeoutSeconds = 90)
                    if (epoch == sessionEpoch && screen == mohassanEpoch && isUuid(image.id)) {
                        mohassanAttachments.add(ChatAttachment(image.id, prepared.preview))
                    }
                } catch (error: WaslaException) {
                    if (epoch == sessionEpoch && screen == mohassanEpoch) show(error)
                }
            }
        } finally {
            if (epoch == sessionEpoch && screen == mohassanEpoch) mohassanUploading = false
        }
    }
}

fun WaslaStore.removeMohassanAttachment(id: String) {
    mohassanAttachments.removeAll { it.id == id }
}

fun WaslaStore.loadMohassanImage(id: String) {
    val client = client ?: return
    if (!isUuid(id) || mohassanImages.contains(id) || !loadingImages.add(id)) return
    val epoch = sessionEpoch
    viewModelScope.launch {
        try {
            val bytes = client.request(CloudRequest("$CHAT_IMAGES/$id", accept = "image/*")).data
            val image = decodeBitmap(bytes) ?: return@launch
            if (epoch == sessionEpoch) {
                if (mohassanImages.size >= 24) mohassanImages.keys.firstOrNull()?.let { mohassanImages.remove(it) }
                mohassanImages[id] = image
            }
        } catch (error: WaslaException) {
            // Leave the conversation readable when an old photo has expired.
        } finally {
            if (epoch == sessionEpoch) loadingImages.remove(id)
        }
    }
}

suspend fun WaslaStore.loadMohassanScreen(): ImageBitmap? {
    val client = client ?: return null
    val id = mohassanConversation?.id?.takeIf(::isUuid) ?: return null
    val epoch = sessionEpoch
    val screen = mohassanEpoch
    return try {
        val bytes = client.request(CloudRequest("$CHAT_CONVERSATIONS/$id/screen", accept = "image/jpeg")).data
        if (!isJpeg(bytes)) throw WaslaException.invalidResponse()
        val image = decodeBitmap(bytes) ?: throw WaslaException.invalidResponse()
        if (epoch != sessionEpoch || screen != mohassanEpoch) return null
        mohassanScreen = image
        image
    } catch (error: WaslaException) {
        if (epoch == sessionEpoch && screen == mohassanEpoch) show(error)
        null
    }
}

private suspend fun decodeBitmap(bytes: ByteArray): ImageBitmap? = withContext(Dispatchers.Default) {
    BitmapFactory.decodeByteArray(bytes, 0, bytes.size)?.asImageBitmap()
}

private data class PreparedPhoto(val jpeg: ByteArray, val preview: ByteArray)

private fun preparePhoto(resolver: ContentResolver, uri: Uri): PreparedPhoto? = try {
    val bitmap = if (Build.VERSION.SDK_INT >= 28) {
        ImageDecoder.decodeBitmap(ImageDecoder.createSource(resolver, uri)) { decoder, info, _ ->
            val longest = maxOf(info.size.width, info.size.height)
            if (longest > 2_048) {
                val scale = 2_048.0 / longest
                decoder.setTargetSize((info.size.width * scale).roundToInt().coerceAtLeast(1), (info.size.height * scale).roundToInt().coerceAtLeast(1))
            }
            decoder.allocator = ImageDecoder.ALLOCATOR_SOFTWARE
        }
    } else {
        val options = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        resolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it, null, options) }
        val longest = maxOf(options.outWidth, options.outHeight)
        var sampling = 1
        while (longest / sampling > 4_096) sampling *= 2
        options.inJustDecodeBounds = false
        options.inSampleSize = sampling
        resolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it, null, options) }
    }
    if (bitmap == null) null else {
        val full = bitmap.scaled(2_048)
        val preview = full.scaled(240).jpeg(70)
        var quality = 82
        var jpeg = full.jpeg(quality)
        while (jpeg != null && jpeg.size > 5_000_000 && quality > 37) {
            quality -= 15
            jpeg = full.jpeg(quality)
        }
        if (jpeg != null && jpeg.size <= 5_000_000 && preview != null) PreparedPhoto(jpeg, preview) else null
    }
} catch (error: IOException) {
    null
} catch (error: SecurityException) {
    null
} catch (error: IllegalArgumentException) {
    null
}

private fun Bitmap.scaled(longSide: Int): Bitmap {
    val longest = maxOf(width, height)
    if (longest <= longSide) return this
    val scale = longSide.toDouble() / longest
    return Bitmap.createScaledBitmap(this, (width * scale).roundToInt().coerceAtLeast(1),
        (height * scale).roundToInt().coerceAtLeast(1), true)
}

private fun Bitmap.jpeg(quality: Int): ByteArray? = ByteArrayOutputStream().use {
    if (compress(Bitmap.CompressFormat.JPEG, quality, it)) it.toByteArray() else null
}
