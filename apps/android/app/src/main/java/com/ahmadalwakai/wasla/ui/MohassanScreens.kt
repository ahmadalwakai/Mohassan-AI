package com.ahmadalwakai.wasla.ui

import android.graphics.Bitmap
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.HelpOutline
import androidx.compose.material.icons.filled.Stop
import androidx.compose.material.icons.outlined.AddPhotoAlternate
import androidx.compose.material.icons.outlined.Check
import androidx.compose.material.icons.outlined.Delete
import androidx.compose.material.icons.outlined.Image as ImageIcon
import androidx.compose.material.icons.outlined.Lock
import androidx.compose.material.icons.outlined.Refresh
import androidx.compose.material.icons.outlined.VerifiedUser
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.ahmadalwakai.wasla.ChatApproval
import com.ahmadalwakai.wasla.ChatConversation
import com.ahmadalwakai.wasla.ChatFieldAnswer
import com.ahmadalwakai.wasla.ChatQuestion
import com.ahmadalwakai.wasla.ChatSecure
import com.ahmadalwakai.wasla.ChatStatus
import com.ahmadalwakai.wasla.ChatSuggestion
import com.ahmadalwakai.wasla.ChatSummary
import com.ahmadalwakai.wasla.MAX_CHAT_PHOTOS
import com.ahmadalwakai.wasla.PendingRequest
import com.ahmadalwakai.wasla.WaslaStore
import com.ahmadalwakai.wasla.answerApproval
import com.ahmadalwakai.wasla.answerFields
import com.ahmadalwakai.wasla.answerOption
import com.ahmadalwakai.wasla.attachPhoto
import com.ahmadalwakai.wasla.cancelConversation
import com.ahmadalwakai.wasla.checkPending
import com.ahmadalwakai.wasla.deleteConversation
import com.ahmadalwakai.wasla.dropPending
import com.ahmadalwakai.wasla.loadConversations
import com.ahmadalwakai.wasla.loadImage
import com.ahmadalwakai.wasla.mohassanTextFits
import com.ahmadalwakai.wasla.openConversation
import com.ahmadalwakai.wasla.rateMessage
import com.ahmadalwakai.wasla.readBrowserScreen
import com.ahmadalwakai.wasla.removeAttachment
import com.ahmadalwakai.wasla.retryPending
import com.ahmadalwakai.wasla.secureAction
import com.ahmadalwakai.wasla.sendMessage
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

@Composable
fun MohassanChatView(store: WaslaStore, onList: () -> Unit) {
    val conversation = store.conversation
    val pending = store.pending
    var browser by remember(conversation?.id) { mutableStateOf(false) }
    val picker = rememberLauncherForActivityResult(ActivityResultContracts.GetContent()) { uri ->
        if (uri != null) store.attachPhoto(uri)
    }
    val scrollKey = listOf(conversation?.messages?.lastOrNull()?.id, conversation?.steps?.size, conversation?.status,
        pending?.key, store.sending).hashCode()
    ChatScaffold(
        draft = store.draft,
        onDraftChange = { store.draft = it },
        placeholder = if (conversation == null) "ماذا تريد أن ينجز موحسن؟" else "اكتب رسالتك…",
        tooLong = !mohassanTextFits(store.draft.trim()),
        canSend = !store.busy && !store.secureBusy && !store.uploading && !store.opening &&
            (store.draft.isNotBlank() || store.attachments.isNotEmpty()) && mohassanTextFits(store.draft.trim()),
        working = conversation?.working == true,
        scrollKey = scrollKey,
        showComposer = conversation?.fieldsQuestion == null,
        onSend = store::sendMessage,
        onStop = store::cancelConversation,
        tools = if (store.imagesAvailable) {
            {
                IconButton(
                    onClick = { picker.launch("image/*") },
                    enabled = !store.busy && !store.uploading && store.attachments.size < MAX_CHAT_PHOTOS,
                ) { Icon(Icons.Outlined.AddPhotoAlternate, contentDescription = "إرفاق صورة") }
            }
        } else null,
        tray = if (store.attachments.isNotEmpty() || store.uploading) {
            {
                PhotoRow(store, store.attachments, removable = true)
                if (store.uploading) Footnote("جارٍ إرفاق الصورة…")
            }
        } else null,
        notice = when {
            pending != null && !store.sending -> "راجع الطلب السابق قبل إرسال رسالة جديدة."
            conversation?.working == true && store.draft.isNotBlank() -> "تصل رسالتك باعتبارها تصحيحًا للمهمة الجارية."
            else -> null
        },
    ) {
        when {
            store.opening -> item(key = "opening") { WorkingSteps("جارٍ فتح المحادثة…", emptyList()) }
            conversation != null -> conversationItems(store, conversation) { browser = true }
            pending == null -> item(key = "welcome") {
                ChatWelcome("بمَ أساعدك اليوم؟", listOf("خطّط لحملة إعلانية", "لخّص لي موضوعًا", "نظّم مهامي")) { store.draft = it }
                store.capabilities?.localModeText?.let { Footnote(it) }
            }
        }
        if (pending != null) item(key = "pending-${pending.key}") { PendingCard(store, pending, onList) }
    }
    if (browser && conversation != null) BrowserScreen(store, conversation) { browser = false }
}

private fun LazyListScope.conversationItems(store: WaslaStore, conversation: ChatConversation, onBrowser: () -> Unit) {
    conversation.olderMessages?.takeIf { it > 0 }?.let {
        item(key = "older") { Footnote("المعروض آخر ${conversation.messages.size} رسالة. سبقها $it رسائل.") }
    }
    items(conversation.messages, key = { "message-${it.id}" }) { message ->
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            val photos = message.images.orEmpty()
            if (photos.isNotEmpty()) PhotoRow(store, photos.map { it.id })
            if (message.text.isNotEmpty()) ChatTurn(message.role == "user", message.text)
            if (message.role == "assistant" && message.text.isNotEmpty()) MessageFeedback(store, conversation.id, message.id)
        }
    }
    conversation.browser?.let { browser ->
        item(key = "browser") {
            ForestCard {
                Text(browser.title.ifBlank { browser.host.ifBlank { "متصفح موحسن" } }, style = MaterialTheme.typography.titleMedium)
                if (browser.host.isNotBlank()) Ltr { Footnote(browser.host) }
                if (browser.screenQuery(conversation.id) != null) {
                    ForestButton(onClick = onBrowser, prominent = false) { Text("عرض شاشة المتصفح") }
                }
            }
        }
    }
    if (conversation.working) item(key = "working") { WorkingSteps(conversation.progress ?: "موحسن يعمل…", conversation.steps.map { it.text }) }
    val question = conversation.question
    if (conversation.status == ChatStatus.WAITING_USER && question != null) {
        item(key = "question-${question.id}") {
            if (question.hasFields) FieldsQuestionCard(store, question) else QuestionCard(store, question)
        }
    }
    val approval = conversation.approval
    if (conversation.status == ChatStatus.WAITING_APPROVAL && approval != null) item(key = "approval-${approval.id}") { ApprovalCard(store, approval) }
    val secure = conversation.secure
    if (conversation.status == ChatStatus.WAITING_INPUT && secure != null) item(key = "secure-${secure.id}") { SecureCard(store, secure) }
    val error = conversation.error
    if (!conversation.working && !error.isNullOrEmpty()) item(key = "error") { ErrorNote(error) }
    if (conversation.waiting) {
        item(key = "stop") {
            ForestButton(onClick = store::cancelConversation, prominent = false) {
                Icon(Icons.Filled.Stop, contentDescription = null, modifier = Modifier.size(16.dp))
                Spacer(Modifier.width(8.dp))
                Text("إيقاف")
            }
        }
    }
}

@Composable
private fun PendingCard(store: WaslaStore, request: PendingRequest, onList: () -> Unit) {
    var confirm by remember { mutableStateOf(false) }
    if (store.sending) {
        if (request.fromComposer && request.text.isNotEmpty()) ChatTurn(true, request.text)
        if (request.imageIds.isNotEmpty()) PhotoRow(store, request.imageIds)
        WorkingSteps("يُرسل الطلب إلى موحسن…", emptyList())
        return
    }
    val canRetry = request.canResend(store.requestKeys)
    ForestCard {
        Text("لم يتأكد وصول الطلب", style = MaterialTheme.typography.titleMedium, color = Forest.alert)
        if (request.text.isNotEmpty()) Text(request.text, maxLines = 4)
        if (canRetry) Footnote("تستخدم إعادة الإرسال المفتاح نفسه.")
        else Footnote("راجع المحادثة للتحقق مما إذا كان الطلب قد وصل.")
        if (canRetry) ForestButton(onClick = store::retryPending) { Text("أرسل مرة أخرى") }
        ForestButton(onClick = {
            if (request.conversationId == null) onList() else store.checkPending()
        }, prominent = false) {
            Text(if (request.conversationId == null) "راجع قائمة المحادثات" else "راجع المحادثة")
        }
        TextButton(onClick = { confirm = true }) { Text("اترك الطلب", color = Forest.alert) }
    }
    if (confirm) AlertDialog(
        onDismissRequest = { confirm = false },
        title = { Text("ترك هذا الطلب؟") },
        text = { Text("قد يكون الطلب وصل إلى الخادم. راجع المحادثة قبل إرساله من جديد.") },
        confirmButton = { TextButton(onClick = { confirm = false; store.dropPending() }) { Text("اتركه") } },
        dismissButton = { TextButton(onClick = { confirm = false }) { Text("تراجع") } },
    )
}

@Composable
private fun MessageFeedback(store: WaslaStore, conversationId: String, messageId: String) {
    var verdict by rememberSaveable(messageId) { mutableStateOf<String?>(null) }
    var sending by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
        listOf("useful" to "مفيد", "wrong" to "خطأ", "incomplete" to "ناقص").forEach { (value, label) ->
            TextButton(
                onClick = {
                    sending = true
                    scope.launch {
                        try { if (store.rateMessage(conversationId, messageId, value)) verdict = value }
                        finally { sending = false }
                    }
                },
                enabled = !sending,
            ) {
                Text(label, color = if (verdict == value) Forest.accent else Forest.softText,
                    fontWeight = if (verdict == value) FontWeight.Bold else FontWeight.Normal)
            }
        }
    }
}

@Composable
private fun PhotoRow(store: WaslaStore, ids: List<String>, removable: Boolean = false) {
    var selected by remember { mutableStateOf<String?>(null) }
    LazyRow(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        items(ids, key = { it }) { id ->
            LaunchedEffect(id) { store.loadImage(id) }
            val photo = store.loadedImages[id]
            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                Box(Modifier.size(68.dp).background(Forest.soft, RoundedCornerShape(8.dp)), contentAlignment = Alignment.Center) {
                    if (photo == null) Icon(Icons.Outlined.ImageIcon, contentDescription = "صورة")
                    else Image(photo.asImageBitmap(), contentDescription = "عرض الصورة", contentScale = ContentScale.Crop,
                        modifier = Modifier.matchParentSize().clip(RoundedCornerShape(8.dp)).clickable { selected = id })
                }
                if (removable) TextButton(onClick = { store.removeAttachment(id) }) { Text("إزالة") }
            }
        }
    }
    selected?.let { store.loadedImages[it] }?.let { photo ->
        AlertDialog(
            onDismissRequest = { selected = null },
            text = { Image(photo.asImageBitmap(), contentDescription = "الصورة المرفقة", modifier = Modifier.fillMaxWidth()) },
            confirmButton = { TextButton(onClick = { selected = null }) { Text("تم") } },
        )
    }
}

@Composable
private fun BrowserScreen(store: WaslaStore, conversation: ChatConversation, onDismiss: () -> Unit) {
    var image by remember { mutableStateOf<Bitmap?>(null) }
    var refresh by remember { mutableIntStateOf(0) }
    var loading by remember { mutableStateOf(true) }
    LaunchedEffect(conversation.browser?.screenUrl, conversation.working, store.foreground, refresh) {
        if (!store.foreground) return@LaunchedEffect
        loading = true
        do {
            store.readBrowserScreen(conversation)?.let { image = it }
            loading = false
            if (conversation.working) delay(2_000)
        } while (conversation.working)
    }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("شاشة المتصفح") },
        text = {
            val frame = image
            when {
                frame != null -> Ltr { Image(frame.asImageBitmap(), contentDescription = "شاشة متصفح موحسن", modifier = Modifier.fillMaxWidth()) }
                loading -> CircularProgressIndicator()
                else -> Footnote("تعذّر عرض لقطة الشاشة.")
            }
        },
        confirmButton = { TextButton(onClick = onDismiss) { Text("تم") } },
        dismissButton = { TextButton(onClick = { refresh++ }, enabled = !loading) { Text("تحديث") } },
    )
}

@Composable
private fun ErrorNote(text: String) {
    val forest = Forest
    Text(
        text, style = MaterialTheme.typography.bodyMedium, color = forest.alert,
        modifier = Modifier.fillMaxWidth().background(forest.alert.copy(alpha = 0.1f), RoundedCornerShape(10.dp)).padding(horizontal = 12.dp, vertical = 9.dp),
    )
}

@Composable
private fun QuestionCard(store: WaslaStore, question: ChatQuestion) {
    ForestCard {
        LabelRow(Icons.AutoMirrored.Outlined.HelpOutline, "سؤال من موحسن")
        Text(question.prompt, style = MaterialTheme.typography.bodyLarge, color = Forest.ink)
        question.clarification?.reason?.takeIf { it.isNotBlank() }?.let { Footnote(it) }
        question.phoneOptions.forEach { option ->
            val recommended = option.id == question.clarification?.recommendedOptionId
            ForestButton(onClick = { store.answerOption(question.id, option) }, prominent = recommended, enabled = !store.busy) {
                Text(option.label, Modifier.fillMaxWidth(), textAlign = TextAlign.Start)
            }
        }
        if (question.action == "google_ads_connect") Footnote("ربط حساب Google Ads يتم من واجهة موحسن على الويب.")
        else if (question.phoneOptions.isNotEmpty()) Footnote("يمكنك كتابة إجابتك في صندوق الرسائل.")
    }
}

/**
 * Several questions in one card, as the web's question panel: each lists the brain's
 * suggestions with the confident one chosen in advance and a box for another answer; the
 * answers go back with the field IDs in the order they were asked.
 */
@Composable
private fun FieldsQuestionCard(store: WaslaStore, question: ChatQuestion) {
    val forest = Forest
    val keyboard = LocalSoftwareKeyboardController.current
    val fields = question.phoneFields
    val several = fields.size > 1
    val busy = store.busy
    var step by rememberSaveable(question.id) { mutableIntStateOf(0) }
    val chosen = remember(question.id) {
        mutableStateListOf<Set<Int>>().also { list -> fields.forEach { field -> list.add(field.preselected) } }
    }
    val other = remember(question.id) { mutableStateListOf<String>().also { list -> fields.forEach { field -> list.add(field.initialValue ?: "") } } }

    fun answerOf(index: Int): String {
        val field = fields[index]
        val picked = chosen[index].sorted().mapNotNull { field.suggestions.getOrNull(it)?.label }
        val supplied = other[index]
        val typed = if (field.keepsLines) supplied else supplied.trim()
        // In a single-answer question a typed answer replaces the chosen suggestion.
        val parts = when {
            field.allowsSeveral -> picked + (if (typed.isNotBlank()) listOf(typed) else emptyList())
            typed.isNotBlank() -> listOf(typed)
            else -> picked
        }
        return parts.joinToString(", ")
    }
    fun currentAnswers(): List<String> = fields.indices.map { answerOf(it) }
    fun replyOf(answers: List<String>): String = answers.mapIndexed { index, answer -> if (several) "${index + 1}. $answer" else answer }.joinToString("\n")

    val answers = currentAnswers()
    val reply = replyOf(answers)
    val ready = answers.all { it.isNotBlank() } && reply.length <= 4_000
    val reviewing = several && step == fields.size

    fun submit() {
        val now = currentAnswers()
        val text = replyOf(now)
        if (busy || now.any { it.isBlank() } || text.length > 4_000) return
        store.answerFields(question.id, fields.mapIndexed { index, field -> ChatFieldAnswer(field.id, now[index]) })
        keyboard?.hide()
    }
    fun next() {
        if (busy) return
        val now = currentAnswers()
        if (!several) { if (now[0].isNotBlank()) submit(); return }
        if (now[step].isBlank()) return
        // Go to the first question still unanswered, or to the review once all are.
        step = fields.indices.firstOrNull { it > step && now[it].isBlank() } ?: fields.size
    }
    fun pick(fieldIndex: Int, suggestion: Int) {
        val field = fields[fieldIndex]
        if (field.allowsSeveral) {
            chosen[fieldIndex] = chosen[fieldIndex].toMutableSet().apply { if (!add(suggestion)) remove(suggestion) }
            return
        }
        // A single choice replaces a typed answer and goes on by itself, as on the web.
        chosen[fieldIndex] = setOf(suggestion)
        other[fieldIndex] = ""
        next()
    }

    ForestCard {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            LabelRow(Icons.AutoMirrored.Outlined.HelpOutline, if (several) "أسئلة موحسن" else "سؤال من موحسن", Modifier.weight(1f))
            Text(if (reviewing) "راجع إجاباتك" else if (several) "${step + 1} من ${fields.size}" else "سؤال واحد", style = MaterialTheme.typography.labelMedium, color = forest.softText)
        }
        if (several) {
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                fields.forEachIndexed { index, _ -> StepDot(index + 1, done = answers[index].isNotBlank(), active = step == index, enabled = !busy) { step = index } }
            }
        }
        if (!reviewing) {
            val field = fields[step]
            val typedHere = other[step].trim()
            Text(field.prompt, style = MaterialTheme.typography.bodyLarge, color = forest.ink)
            if (field.allowsSeveral) Footnote("يمكنك اختيار أكثر من واحد، ثم اضغط «التالي».")
            field.suggestions.forEachIndexed { index, suggestion ->
                val on = chosen[step].contains(index) && !(typedHere.isNotEmpty() && !field.allowsSeveral)
                SuggestionRow(index + 1, suggestion, on, enabled = !busy) { pick(step, index) }
            }
            OutlinedTextField(
                value = other[step], onValueChange = { other[step] = it }, modifier = Modifier.fillMaxWidth(), enabled = !busy,
                placeholder = { Text(field.placeholder ?: if (field.suggestions.isNotEmpty()) "إجابة أخرى…" else "اكتب إجابتك…") },
                minLines = if (field.keepsLines) 3 else 1, maxLines = if (field.keepsLines) 6 else 3, colors = fieldColors(),
            )
        } else {
            fields.forEachIndexed { index, field ->
                Column(Modifier.fillMaxWidth().clickable(enabled = !busy) { step = index }.padding(vertical = 6.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    Text(field.prompt, style = MaterialTheme.typography.bodySmall, color = forest.softText)
                    Text(answers[index].ifBlank { "—" }, style = MaterialTheme.typography.bodyLarge, color = forest.ink)
                }
            }
        }
        if (reply.length > 4_000) Footnote("الإجابات ${reply.length} من 4000 حرف. اختصر بعض النص قبل الإرسال.", forest.alert)
        Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            if (several && step > 0) ForestButton(onClick = { step -= 1 }, Modifier.weight(1f), prominent = false, enabled = !busy) { Text("رجوع") }
            if (reviewing) ForestButton(onClick = { submit() }, Modifier.weight(1f), enabled = !busy && ready) { Text("أرسل الإجابات") }
            else ForestButton(onClick = { next() }, Modifier.weight(1f), enabled = !busy && answers[step].isNotBlank()) { Text(if (several) "التالي" else "أرسل") }
        }
        question.phoneOptions.filter { it.id != "stop" }.forEach { option ->
            ForestButton(onClick = { store.answerOption(question.id, option) }, prominent = false, enabled = !busy) { Text(option.label) }
        }
        question.stopOption?.let { stop ->
            TextButton(onClick = { store.answerOption(question.id, stop) }, enabled = !busy) { Text(stop.label, color = forest.softText) }
        }
    }
}

@Composable
private fun StepDot(number: Int, done: Boolean, active: Boolean, enabled: Boolean, onClick: () -> Unit) {
    val forest = Forest
    Box(
        Modifier.size(28.dp).background(if (active) forest.accent else if (done) forest.accentSoft else forest.soft, CircleShape).clickable(enabled = enabled, onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        if (done && !active) Icon(Icons.Outlined.Check, contentDescription = "السؤال $number، أُجيب", tint = forest.accent, modifier = Modifier.size(14.dp))
        else Text("$number", style = MaterialTheme.typography.labelMedium, color = if (active) forest.onAccent else forest.softText)
    }
}

@Composable
private fun SuggestionRow(number: Int, suggestion: ChatSuggestion, on: Boolean, enabled: Boolean, onClick: () -> Unit) {
    val forest = Forest
    val shape = RoundedCornerShape(12.dp)
    Row(
        Modifier.fillMaxWidth().background(if (on) forest.accentSoft else forest.background, shape).border(1.dp, if (on) forest.accent else forest.line, shape)
            .clickable(enabled = enabled, onClick = onClick).padding(horizontal = 12.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Text("$number", style = MaterialTheme.typography.labelSmall, color = forest.softText, modifier = Modifier.border(1.dp, forest.line, RoundedCornerShape(6.dp)).padding(horizontal = 6.dp, vertical = 2.dp))
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(suggestion.label, style = MaterialTheme.typography.bodyMedium, color = forest.ink)
            suggestion.reason?.takeIf { it.isNotEmpty() }?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = forest.softText) }
        }
        if (on) Icon(Icons.Outlined.Check, contentDescription = null, tint = forest.accent, modifier = Modifier.size(16.dp))
    }
}

@Composable
private fun ApprovalCard(store: WaslaStore, approval: ChatApproval) {
    val forest = Forest
    var confirm by remember(approval.id) { mutableStateOf(false) }
    val busy = store.busy || store.secureBusy
    ForestCard {
        LabelRow(Icons.Outlined.VerifiedUser, "يحتاج موافقتك")
        Text(approval.prompt, style = MaterialTheme.typography.bodyLarge, color = forest.ink)
        // What the server's permission gate bound this approval to (2026-11-23); absent from older servers.
        approval.bindingLines.forEach { Footnote(it) }
        if (approval.detail.isNotEmpty()) Footnote(approval.detail)
        Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            ForestButton(onClick = { store.answerApproval(approval.id, false) }, Modifier.weight(1f), prominent = false, enabled = !busy) { Text("رفض") }
            ForestButton(onClick = { confirm = true }, Modifier.weight(1f), enabled = !busy) { Text("موافق") }
        }
    }
    if (confirm) {
        AlertDialog(
            onDismissRequest = { confirm = false },
            title = { Text("تنفيذ هذا الإجراء؟") },
            text = { Text(approval.prompt) },
            confirmButton = { TextButton(onClick = { confirm = false; store.answerApproval(approval.id, true) }) { Text("موافق، نفّذ") } },
            dismissButton = { TextButton(onClick = { confirm = false }) { Text("تراجع") } },
        )
    }
}

@Composable
private fun SecureCard(store: WaslaStore, secure: ChatSecure) {
    val busy = store.busy || store.secureBusy
    val values = remember(secure.id) { mutableStateMapOf<String, String>() }
    val handsOn = secure.handsOn
    val filled = secure.fields.all { field ->
        (field.id == "username" && secure.fields.size > 1) || !values[field.id].isNullOrBlank()
    }
    ForestCard {
        LabelRow(Icons.Outlined.Lock, when (secure.kind) {
            "code" -> "رمز التحقق"
            "login" -> "تسجيل الدخول"
            else -> "هذه الخطوة تحتاجك"
        })
        if (secure.prompt.isNotBlank()) Text(secure.prompt, style = MaterialTheme.typography.bodyLarge)
        if (secure.site.isNotBlank()) Ltr { Footnote(secure.site) }
        secure.note?.takeIf { it.isNotBlank() }?.let { Footnote(it, Forest.alert) }
        secure.fields.forEach { field ->
            val password = field.type == "password"
            Ltr {
                OutlinedTextField(
                    value = values[field.id].orEmpty(), onValueChange = { values[field.id] = it },
                    modifier = Modifier.fillMaxWidth(), label = { Text(field.label) }, singleLine = true, enabled = !busy,
                    keyboardOptions = KeyboardOptions(keyboardType = when (field.type) {
                        "password" -> KeyboardType.Password
                        "code" -> KeyboardType.Number
                        else -> KeyboardType.Email
                    }),
                    visualTransformation = if (password) PasswordVisualTransformation() else VisualTransformation.None,
                    colors = fieldColors(),
                )
            }
        }
        if (!handsOn) Footnote("تذهب هذه البيانات إلى الموقع مباشرة.")
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            ForestButton(onClick = {
                if (handsOn) store.secureAction(secure.id, "done")
                else {
                    val input = values.toMap()
                    values.clear()
                    store.secureAction(secure.id, "submit", input)
                }
            }, modifier = Modifier.weight(1f), enabled = !busy && (handsOn || filled)) {
                Text(if (handsOn) "أكملت" else "متابعة")
            }
            ForestButton(onClick = { values.clear(); store.secureAction(secure.id, "skip") }, modifier = Modifier.weight(1f), prominent = false,
                enabled = !busy) { Text("تخطي") }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun MohassanListSheet(store: WaslaStore, onDismiss: () -> Unit) {
    val forest = Forest
    var deleting by remember { mutableStateOf<ChatSummary?>(null) }
    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true), containerColor = forest.background) {
        Column(Modifier.fillMaxWidth().padding(horizontal = 20.dp).padding(bottom = 24.dp)) {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Text("محادثات موحسن", Modifier.weight(1f), style = MaterialTheme.typography.titleLarge, color = forest.ink)
                IconButton(onClick = { store.loadConversations() }) { Icon(Icons.Outlined.Refresh, contentDescription = "تحديث", tint = forest.ink) }
                TextButton(onClick = onDismiss) { Text("تم") }
            }
            if (store.chatList.isEmpty()) Text("لا توجد محادثات بعد.", Modifier.padding(vertical = 24.dp), color = forest.softText)
            LazyColumn(Modifier.fillMaxWidth().heightIn(max = 480.dp)) {
                items(store.chatList, key = { it.id }) { item ->
                    Row(Modifier.fillMaxWidth().clickable(enabled = !store.sending) { onDismiss(); store.openConversation(item.id) }.padding(vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
                        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                            Text(item.title.ifEmpty { "محادثة" }, style = MaterialTheme.typography.bodyLarge, color = forest.ink, maxLines = 2)
                            Text(ChatStatus.title(item.status), style = MaterialTheme.typography.bodySmall, color = forest.softText)
                        }
                        IconButton(onClick = { deleting = item }, enabled = !store.sending) { Icon(Icons.Outlined.Delete, contentDescription = "حذف", tint = forest.softText) }
                    }
                    HorizontalDivider(color = forest.line)
                }
            }
        }
    }
    deleting?.let { item ->
        AlertDialog(
            onDismissRequest = { deleting = null },
            title = { Text("حذف هذه المحادثة؟") },
            text = { Text(item.title.ifEmpty { "محادثة" }, fontWeight = FontWeight.Medium) },
            confirmButton = { TextButton(onClick = { store.deleteConversation(item.id); deleting = null }) { Text("حذف", color = forest.alert) } },
            dismissButton = { TextButton(onClick = { deleting = null }) { Text("تراجع") } },
        )
    }
}
