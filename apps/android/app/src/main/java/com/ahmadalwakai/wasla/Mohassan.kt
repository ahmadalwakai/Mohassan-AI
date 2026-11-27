package com.ahmadalwakai.wasla

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.ImageDecoder
import android.net.Uri
import android.os.Build
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.ByteArrayOutputStream

// MAX_CHAT_IMAGES in https://github.com/ahmadalwakai/Mohassan-AI/blob/29448aea3fa10d226ef82ec5bf0a65e723d6ec39/packages/contracts/src/command-chat.ts (retrieved 2026-11-27).
internal const val MAX_CHAT_PHOTOS = 4
private const val MAX_PHOTO_SIDE = 2048

internal suspend fun WaslaStore.refreshList(force: Boolean = false) {
    if (!canChat || loadingConversations && !force) return
    val session = sessionEpoch
    val request = ++listRequestEpoch
    loadingConversations = true
    try {
        val reply = cloud.chatList()
        if (session != sessionEpoch || request != listRequestEpoch || !cloud.signedIn.value) return
        chatList = reply.conversations
        reply.capabilities?.let { capabilities = it }
        requestKeys = reply.requestKeys == true
        conversationsLoaded = true
    } catch (error: Exception) {
        if (error is CancellationException) throw error
        if (session == sessionEpoch && request == listRequestEpoch) show(error)
    } finally {
        if (session == sessionEpoch && request == listRequestEpoch) loadingConversations = false
    }
}

internal suspend fun WaslaStore.refreshImageAvailability() {
    if (!isOwner || !canChat) return
    val session = sessionEpoch
    try {
        val available = cloud.imagesAvailable()
        if (session == sessionEpoch) imagesAvailable = available
    } catch (error: Exception) {
        if (error is CancellationException) throw error
    }
}

internal fun WaslaStore.loadConversations() {
    if (loadingConversations) return
    clearError()
    viewModelScope.launch { refreshList() }
}

internal fun WaslaStore.newConversation() {
    if (sending || uploading || secureBusy) return
    clearError()
    clearConversation()
}

private fun WaslaStore.clearConversation() {
    chatEpoch++
    watchJob?.cancel()
    watchJob = null
    conversation = null
    draft = ""
    attachments.clear()
    opening = false
    secureBusy = false
}

internal fun WaslaStore.openConversation(id: String) {
    if (!canChat || !isUuid(id) || sending || uploading || secureBusy) return
    clearError()
    clearConversation()
    opening = true
    val screen = chatEpoch
    viewModelScope.launch {
        try {
            refreshConversation(id)
        } finally {
            if (screen == chatEpoch) opening = false
        }
    }
}

internal suspend fun WaslaStore.refreshConversation(id: String) {
    if (!canChat) return
    val session = sessionEpoch
    val screen = chatEpoch
    try {
        val detail = cloud.conversation(id)
        if (session == sessionEpoch && screen == chatEpoch && detail.id == id) present(detail)
    } catch (error: Exception) {
        if (session == sessionEpoch && screen == chatEpoch) show(error)
    }
}

private fun WaslaStore.present(detail: ChatConversation) {
    watchJob?.cancel()
    conversation = detail
    detail.capabilities?.let { capabilities = it }
    if (!foreground) {
        watchJob = null
        return
    }
    val session = sessionEpoch
    val screen = chatEpoch
    watchJob = viewModelScope.launch {
        var failures = 0
        while (isActive && foreground && session == sessionEpoch && screen == chatEpoch) {
            val current = conversation?.takeIf { it.id == detail.id } ?: break
            val since = current.version
            if (since == null && !current.working) break
            try {
                if (since == null) delay(2_000)
                val updated = cloud.conversation(current.id, since)
                if (!isActive || session != sessionEpoch || screen != chatEpoch || updated.id != current.id) break
                conversation = updated
                updated.capabilities?.let { capabilities = it }
                failures = 0
            } catch (error: Exception) {
                if (error is CancellationException) throw error
                if (!cloud.signedIn.value || session != sessionEpoch || screen != chatEpoch) break
                failures++
                if (failures == 1) show(error)
                if (failures >= 6) break
                delay((2_000L * failures).coerceAtMost(10_000))
            }
        }
    }
}

internal fun WaslaStore.sendMessage(): Boolean {
    val text = draft.trim()
    if (!canChat || busy || opening || uploading || secureBusy || conversation?.fieldsQuestion != null ||
        (text.isEmpty() && attachments.isEmpty()) || !mohassanTextFits(text)
    ) return false
    val images = attachments.toList()
    val imageIds = images.ifEmpty { null }
    val id = conversation?.id
    val request = if (id == null) {
        PendingRequest.make(PendingRequest.Kind.CREATE, null, text,
            CloudJson.encode(ChatCreate(goal = text.ifEmpty { null }, images = imageIds)), images)
    } else {
        PendingRequest.make(PendingRequest.Kind.MESSAGE, id, text,
            CloudJson.encode(ChatSend(text = text, images = imageIds)), images)
    }
    val originalDraft = draft
    val originalPhotos = images
    draft = ""
    attachments.clear()
    if (submit(request)) return true
    draft = originalDraft
    attachments.addAll(originalPhotos)
    return false
}

internal fun WaslaStore.answerOption(questionId: String, option: ChatOption) {
    val detail = conversation ?: return
    val question = detail.question?.takeIf { detail.status == ChatStatus.WAITING_USER } ?: return
    if (question.id != questionId || option !in question.phoneOptions) return
    submit(PendingRequest.make(PendingRequest.Kind.OPTION, detail.id, option.label,
        CloudJson.encode(ChatRespond(question.id, option.id))))
}

internal fun WaslaStore.answerFields(questionId: String, answers: List<ChatFieldAnswer>) {
    val detail = conversation ?: return
    val question = detail.fieldsQuestion ?: return
    if (question.id != questionId || answers.map { it.fieldId } != question.phoneFields.map { it.id } ||
        answers.isEmpty() || answers.any { it.value.isBlank() }
    ) return
    val summary = answers.mapIndexed { index, answer ->
        if (answers.size == 1) answer.value else "${index + 1}. ${answer.value}"
    }.joinToString("\n")
    if (!mohassanTextFits(summary)) return
    submit(PendingRequest.make(PendingRequest.Kind.FIELDS, detail.id, summary,
        CloudJson.encode(ChatSend(text = "", questionId = question.id, answers = answers))))
}

internal fun WaslaStore.answerApproval(approvalId: String, approved: Boolean) {
    val detail = conversation ?: return
    val approval = detail.approval?.takeIf { detail.status == ChatStatus.WAITING_APPROVAL && it.id == approvalId } ?: return
    submit(PendingRequest.make(PendingRequest.Kind.APPROVE, detail.id, if (approved) "موافق" else "لا تفعل",
        CloudJson.encode(ChatApprove(approval.id, approved))))
}

internal fun WaslaStore.secureAction(requestId: String, action: String, values: Map<String, String>? = null) {
    val detail = conversation ?: return
    val request = detail.secure?.takeIf { detail.status == ChatStatus.WAITING_INPUT && it.id == requestId } ?: return
    if (!canChat || busy || secureBusy) return
    clearError()
    val session = sessionEpoch
    val screen = chatEpoch
    secureBusy = true
    viewModelScope.launch {
        try {
            val reply = cloud.secure(detail.id, ChatSecureSubmit(request.id, action, values))
            if (session == sessionEpoch && screen == chatEpoch) present(reply)
        } catch (error: Exception) {
            if (session == sessionEpoch && screen == chatEpoch) {
                show(error)
                if (cloud.signedIn.value) refreshConversation(detail.id)
            }
        } finally {
            if (session == sessionEpoch && screen == chatEpoch) secureBusy = false
        }
    }
}

internal fun WaslaStore.cancelConversation() {
    val id = conversation?.id ?: return
    if (!canChat) return
    clearError()
    val session = sessionEpoch
    val screen = chatEpoch
    viewModelScope.launch {
        try {
            val reply = cloud.cancel(id)
            if (session == sessionEpoch && screen == chatEpoch) present(reply)
        } catch (error: Exception) {
            if (session == sessionEpoch && screen == chatEpoch) show(error)
        }
    }
}

internal fun WaslaStore.deleteConversation(id: String) {
    if (!canChat || sending || !isUuid(id)) return
    clearError()
    val session = sessionEpoch
    val request = pending?.takeIf { it.conversationId == id }
    if (request != null) sending = true
    val deletion = viewModelScope.launch {
        try {
            cloud.deleteConversation(id)
            if (session != sessionEpoch) return@launch
            request?.let { settle(it) }
            if (session != sessionEpoch) return@launch
            chatList = chatList.filterNot { it.id == id }
            if (conversation?.id == id) clearConversation()
            refreshList(force = true)
        } catch (error: Exception) {
            if (session == sessionEpoch) show(error)
        } finally {
            if (request != null && session == sessionEpoch) sending = false
        }
    }
    if (request != null) requestJob = deletion
}

internal suspend fun WaslaStore.rateMessage(conversationId: String, messageId: String, verdict: String): Boolean {
    if (!isOwner || !canChat) return false
    val session = sessionEpoch
    return try {
        cloud.feedback(conversationId, ChatFeedback(messageId, verdict))
        session == sessionEpoch
    } catch (error: Exception) {
        if (session == sessionEpoch) show(error)
        false
    }
}

internal suspend fun WaslaStore.restorePending() {
    val session = sessionEpoch
    val binding = cloud.sessionBinding() ?: return
    try {
        val restored = pendingVault.read(binding)
        if (session == sessionEpoch && binding == cloud.sessionBinding()) pending = restored
    } catch (error: Exception) {
        if (error is CancellationException) throw error
        if (session == sessionEpoch) show(error)
    }
}

internal fun WaslaStore.retryPending() {
    val request = pending ?: return
    if (request.canResend(requestKeys)) submit(request)
}

internal fun WaslaStore.checkPending() {
    val request = pending ?: return
    request.conversationId?.let { openConversation(it) }
}

internal fun WaslaStore.dropPending() {
    val request = pending?.takeUnless { sending } ?: return
    val session = sessionEpoch
    sending = true
    requestJob = viewModelScope.launch {
        try {
            settle(request)
            if (session == sessionEpoch && conversation?.id == request.conversationId) handBack(request)
        } finally {
            if (session == sessionEpoch) sending = false
        }
    }
}

private fun WaslaStore.submit(request: PendingRequest): Boolean {
    if (!canChat || !cloud.signedIn.value || sending || opening || secureBusy ||
        (pending != null && pending?.key != request.key)
    ) return false
    val binding = cloud.sessionBinding() ?: return false
    val initial = pending == null
    val session = sessionEpoch
    val screen = chatEpoch
    pending = request
    sending = true
    clearError()
    requestJob = viewModelScope.launch {
        var failedAttempts = 0
        try {
            try {
                if (initial) pendingVault.save(binding, request)
            } catch (error: Exception) {
                if (error is CancellationException) throw error
                if (initial && session == sessionEpoch) {
                    pending = null
                    handBack(request)
                }
                show(error)
                return@launch
            }
            if (!initial && !request.canResend(requestKeys)) return@launch
            while (isActive && session == sessionEpoch && pending?.key == request.key) {
                try {
                    val detail = cloud.sendKeyed(request.path, request.body, request.key, expectedBinding = binding)
                    if (session != sessionEpoch || !cloud.signedIn.value) return@launch
                    settle(request)
                    if (session != sessionEpoch || !cloud.signedIn.value) return@launch
                    if (screen == chatEpoch && (conversation == null || request.conversationId == conversation?.id)) {
                        present(detail)
                    }
                    if (request.kind == PendingRequest.Kind.CREATE) refreshList(force = true)
                    return@launch
                } catch (error: Exception) {
                    if (error is CancellationException) throw error
                    if (session != sessionEpoch || !cloud.signedIn.value) return@launch
                    val firstAttempt = initial && failedAttempts == 0
                    when (pendingFailure(error, firstAttempt)) {
                        PendingFailure.RETURN_TO_DRAFT -> {
                            settle(request)
                            if (session != sessionEpoch || !cloud.signedIn.value) return@launch
                            handBack(request)
                            show(error)
                            if (!request.fromComposer && screen == chatEpoch) request.conversationId?.let { refreshConversation(it) }
                            return@launch
                        }
                        PendingFailure.KEEP -> {
                            show(error)
                            return@launch
                        }
                        PendingFailure.RETRY -> Unit
                    }
                    val wait = request.retryDelayMillis(requestKeys, foreground, ++failedAttempts)
                    if (wait == null) {
                        show(error)
                        return@launch
                    }
                    delay(wait)
                    if (!foreground || !request.canResend(requestKeys)) {
                        show(error)
                        return@launch
                    }
                }
            }
        } finally {
            if (session == sessionEpoch) sending = false
        }
    }
    return true
}

private suspend fun WaslaStore.settle(request: PendingRequest) {
    if (pending?.key != request.key) return
    try {
        pendingVault.clear()
    } catch (error: Exception) {
        show(error)
    }
    if (pending?.key == request.key) pending = null
}

private fun WaslaStore.handBack(request: PendingRequest) {
    if (!request.fromComposer) return
    if (request.text.isNotEmpty()) draft = listOf(request.text, draft).filter { it.isNotEmpty() }.joinToString("\n")
    val held = attachments.toSet()
    attachments.addAll(0, request.imageIds.filterNot(held::contains))
    if (attachments.size > MAX_CHAT_PHOTOS) attachments.subList(MAX_CHAT_PHOTOS, attachments.size).clear()
}

internal fun WaslaStore.attachPhoto(uri: Uri) {
    if (!isOwner || !canChat || uploading || busy || !imagesAvailable || attachments.size >= MAX_CHAT_PHOTOS) return
    val session = sessionEpoch
    uploading = true
    viewModelScope.launch {
        try {
            val photo = withContext(Dispatchers.IO) { preparePhoto(uri) }
            if (session != sessionEpoch || !cloud.signedIn.value) return@launch
            val uploaded = cloud.uploadImage("image/jpeg", photo)
            if (session == sessionEpoch && isUuid(uploaded.id)) attachments.add(uploaded.id)
        } catch (error: Exception) {
            if (session == sessionEpoch) show(error)
        } finally {
            if (session == sessionEpoch) uploading = false
        }
    }
}

internal fun WaslaStore.removeAttachment(id: String) {
    attachments.remove(id)
}

private fun WaslaStore.preparePhoto(uri: Uri): ByteArray {
    val bitmap = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
        val source = ImageDecoder.createSource(getApplication<android.app.Application>().contentResolver, uri)
        ImageDecoder.decodeBitmap(source) { decoder, info, _ ->
            decoder.allocator = ImageDecoder.ALLOCATOR_SOFTWARE
            val size = info.size
            val scale = MAX_PHOTO_SIDE.toFloat() / maxOf(size.width, size.height)
            if (scale < 1) decoder.setTargetSize((size.width * scale).toInt().coerceAtLeast(1), (size.height * scale).toInt().coerceAtLeast(1))
        }
    } else {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        readPhoto(uri)?.use { BitmapFactory.decodeStream(it, null, bounds) }
        val options = BitmapFactory.Options().apply {
            inSampleSize = 1
            while (maxOf(bounds.outWidth, bounds.outHeight) / inSampleSize > MAX_PHOTO_SIDE) inSampleSize *= 2
        }
        readPhoto(uri)?.use { BitmapFactory.decodeStream(it, null, options) }
    } ?: error("تعذّر قراءة هذه الصورة.")
    try {
        for (quality in listOf(85, 70, 55, 40)) {
            val output = ByteArrayOutputStream()
            if (bitmap.compress(Bitmap.CompressFormat.JPEG, quality, output) && output.size() <= CloudApi.MAX_IMAGE_BYTES) {
                return output.toByteArray()
            }
        }
        error("الصورة أكبر من الحجم المسموح.")
    } finally {
        bitmap.recycle()
    }
}

internal suspend fun WaslaStore.loadImage(id: String) {
    if (!isOwner || !canChat || !isUuid(id) || loadedImages.containsKey(id) || !loadingImages.add(id)) return
    val session = sessionEpoch
    try {
        val bytes = cloud.image(id)
        val bitmap = withContext(Dispatchers.Default) {
            val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
            val options = BitmapFactory.Options().apply {
                inSampleSize = 1
                while (maxOf(bounds.outWidth, bounds.outHeight) / inSampleSize > 1_024) inSampleSize *= 2
            }
            BitmapFactory.decodeByteArray(bytes, 0, bytes.size, options)
        }
        if (session == sessionEpoch && bitmap != null) loadedImages[id] = bitmap
    } catch (error: Exception) {
        if (error is CancellationException) throw error
    } finally {
        if (session == sessionEpoch) loadingImages.remove(id)
    }
}

internal suspend fun WaslaStore.readBrowserScreen(detail: ChatConversation): Bitmap? {
    if (!canChat || !(detail.visibility?.canView ?: isOwner)) return null
    val query = detail.browser?.screenQuery(detail.id) ?: return null
    val session = sessionEpoch
    val screen = chatEpoch
    return try {
        val bytes = cloud.screen(detail.id, query["v"])
        val bitmap = withContext(Dispatchers.Default) { BitmapFactory.decodeByteArray(bytes, 0, bytes.size) }
        bitmap.takeIf { session == sessionEpoch && screen == chatEpoch }
    } catch (error: Exception) {
        if (error is CancellationException) throw error
        null
    }
}
