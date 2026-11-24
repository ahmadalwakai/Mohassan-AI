package com.ahmadalwakai.wasla.ui

import android.graphics.BitmapFactory
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.HelpOutline
import androidx.compose.material.icons.filled.Stop
import androidx.compose.material.icons.outlined.Check
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material.icons.outlined.Delete
import androidx.compose.material.icons.outlined.Lock
import androidx.compose.material.icons.outlined.PhotoLibrary
import androidx.compose.material.icons.outlined.Public
import androidx.compose.material.icons.outlined.Refresh
import androidx.compose.material.icons.outlined.VerifiedUser
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
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
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.ahmadalwakai.wasla.ChatAttachment
import com.ahmadalwakai.wasla.ChatFieldAnswer
import com.ahmadalwakai.wasla.ChatImageRef
import com.ahmadalwakai.wasla.MAX_CHAT_ATTACHMENTS
import com.ahmadalwakai.wasla.MohassanApproval
import com.ahmadalwakai.wasla.MohassanConversation
import com.ahmadalwakai.wasla.MohassanQuestion
import com.ahmadalwakai.wasla.MohassanSecure
import com.ahmadalwakai.wasla.MohassanStatus
import com.ahmadalwakai.wasla.MohassanSuggestion
import com.ahmadalwakai.wasla.MohassanSummary
import com.ahmadalwakai.wasla.PendingRequest
import com.ahmadalwakai.wasla.WaslaStore
import com.ahmadalwakai.wasla.answerMohassan
import com.ahmadalwakai.wasla.answerMohassanFields
import com.ahmadalwakai.wasla.approveMohassan
import com.ahmadalwakai.wasla.cancelMohassan
import com.ahmadalwakai.wasla.checkPendingMohassan
import com.ahmadalwakai.wasla.deleteMohassan
import com.ahmadalwakai.wasla.dropPendingMohassan
import com.ahmadalwakai.wasla.feedbackMohassan
import com.ahmadalwakai.wasla.loadMohassanImage
import com.ahmadalwakai.wasla.loadMohassanList
import com.ahmadalwakai.wasla.loadMohassanScreen
import com.ahmadalwakai.wasla.mohassanTextFits
import com.ahmadalwakai.wasla.openMohassan
import com.ahmadalwakai.wasla.removeMohassanAttachment
import com.ahmadalwakai.wasla.resendPendingMohassan
import com.ahmadalwakai.wasla.secureMohassan
import com.ahmadalwakai.wasla.sendMohassan
import com.ahmadalwakai.wasla.uploadMohassanImages
import kotlinx.coroutines.delay

/** Mohassan's chat: the thread, the working pill, and the cards that answer its questions and approvals. */
@Composable
fun MohassanChatView(store: WaslaStore) {
    val draft = store.mohassanDraft
    val clean = draft.trim()
    val conversation = store.mohassanConversation
    val pending = store.pendingMohassan
    val working = conversation?.working == true
    val askingFields = conversation?.status == MohassanStatus.WAITING_USER && conversation.question?.hasFields == true
    val locked = store.mohassanSending || pending != null || store.mohassanSecureBusy
    val scrollKey = (conversation?.messages?.size ?: 0) * 1_000 + (conversation?.steps?.size ?: 0) * 2 +
        (if (conversation?.status in MohassanStatus.WAITING) 1 else 0) + when (pending?.phase) {
            PendingRequest.Phase.SENDING -> 100_000
            PendingRequest.Phase.UNCONFIRMED -> 200_000
            null -> 0
        }
    var screenShown by remember(conversation?.id) { mutableStateOf(false) }
    val notice = when {
        pending?.phase == PendingRequest.Phase.UNCONFIRMED -> "تحقّق من الطلب السابق قبل رسالة جديدة."
        working && clean.isNotEmpty() -> "تصل هذه الرسالة إلى موحسن لتصحيح المهمة الجارية."
        else -> null
    }
    ChatScaffold(
        draft = draft,
        onDraftChange = { store.mohassanDraft = it },
        placeholder = if (conversation == null) "ماذا تريد أن ينجز موحسن؟" else "اكتب رسالتك…",
        tooLong = !mohassanTextFits(draft),
        canSend = !locked && !store.mohassanUploading &&
            (clean.isNotEmpty() || store.mohassanAttachments.isNotEmpty()) && mohassanTextFits(draft),
        working = working,
        scrollKey = scrollKey,
        showComposer = !askingFields,
        onSend = { store.sendMohassan(draft) },
        onStop = { store.cancelMohassan() },
        notice = notice,
        tools = if (store.mohassanImagesAvailable) {
            { PhotoPickerButton(store, enabled = !locked && !store.mohassanUploading) }
        } else null,
        tray = if (store.mohassanAttachments.isNotEmpty() || store.mohassanUploading) {
            { AttachmentTray(store.mohassanAttachments, store.mohassanUploading, store::removeMohassanAttachment) }
        } else null,
    ) {
        when {
            conversation != null -> conversationItems(store, conversation, locked) { screenShown = true }
            pending == null -> item(key = "welcome") {
                ChatWelcome("بمَ أساعدك اليوم؟", listOf("خطّط لحملة إعلانية", "لخّص لي موضوعًا", "نظّم مهامي")) { store.mohassanDraft = it }
            }
        }
        if (pending != null) item(key = pending.key) { PendingCard(store, pending, conversation?.id) }
    }
    if (screenShown && conversation?.browser != null) BrowserScreenSheet(store) { screenShown = false }
}

private fun LazyListScope.conversationItems(
    store: WaslaStore,
    conversation: MohassanConversation,
    locked: Boolean,
    openScreen: () -> Unit,
) {
    conversation.olderMessages?.let { count -> item(key = "older") { Footnote("رسائل أقدم غير معروضة هنا ($count).") } }
    items(conversation.messages, key = { "message-${it.id}" }) { message ->
        val mine = message.role == "user"
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            if (!message.images.isNullOrEmpty()) MessageImages(store, message.images)
            if (message.text.isNotBlank()) ChatTurn(mine, message.text)
            if (!mine && message.text.isNotBlank()) FeedbackButton(store, message.id)
        }
    }
    conversation.browser?.let { browser ->
        item(key = "browser") {
            ForestCard(onClick = openScreen) {
                LabelRow(Icons.Outlined.Public, browser.title.ifBlank { "شاشة المتصفح" })
                Ltr { Footnote(browser.url) }
            }
        }
    }
    if (conversation.working) item(key = "working") { WorkingSteps(conversation.progress ?: "موحسن يعمل…", conversation.steps.map { it.text }) }
    val question = conversation.question
    if (conversation.status == MohassanStatus.WAITING_USER && question != null) {
        item(key = "question-${question.id}") {
            if (question.hasFields) FieldsQuestionCard(store, question, locked) else QuestionCard(store, question, locked)
        }
    }
    val approval = conversation.approval
    if (conversation.status == MohassanStatus.WAITING_APPROVAL && approval != null) item(key = "approval-${approval.id}") {
        ApprovalCard(store, approval, locked)
    }
    val secure = conversation.secure
    if (conversation.status == MohassanStatus.WAITING_INPUT && secure != null) item(key = "secure-${secure.id}") {
        SecureCard(store, secure, locked)
    }
    val error = conversation.error
    if (!conversation.working && !error.isNullOrEmpty()) item(key = "error") { ErrorNote(error) }
    if (conversation.status in MohassanStatus.WAITING) {
        item(key = "stop") {
            ForestButton(onClick = { store.cancelMohassan() }, prominent = false) {
                Icon(Icons.Filled.Stop, contentDescription = null, modifier = Modifier.size(16.dp)); Spacer(Modifier.width(8.dp)); Text("إيقاف")
            }
        }
    }
}

@Composable
private fun ErrorNote(text: String) {
    val forest = Forest
    Text(
        text, style = MaterialTheme.typography.bodyMedium, color = forest.alert,
        modifier = Modifier.fillMaxWidth().background(forest.alert.copy(alpha = 0.1f), RoundedCornerShape(10.dp)).padding(horizontal = 12.dp, vertical = 9.dp),
    )
}

/** A question with options, a clarification, or a typed answer. */
@Composable
private fun QuestionCard(store: WaslaStore, question: MohassanQuestion, busy: Boolean) {
    val forest = Forest
    ForestCard {
        LabelRow(Icons.AutoMirrored.Outlined.HelpOutline, "سؤال من موحسن")
        Text(question.prompt, style = MaterialTheme.typography.bodyLarge, color = forest.ink)
        question.clarification?.reason?.takeIf { it.isNotEmpty() }?.let { Footnote(it) }
        question.phoneOptions.forEach { option ->
            val recommended = option.id == question.clarification?.recommendedOptionId
            ForestButton(onClick = { store.answerMohassan(option, null) }, prominent = recommended, enabled = !busy) {
                Text(if (recommended) option.label + " · مقترح" else option.label, Modifier.fillMaxWidth(), textAlign = TextAlign.Start)
            }
        }
        if (question.action == "google_ads_connect") Footnote("ربط حساب Google Ads يتم من واجهة موحسن على الويب.")
    }
}

/**
 * Several questions in one card, as the web's question panel: each lists the brain's
 * suggestions with the confident one chosen in advance and a box for another answer; the
 * answers go together as one numbered reply, read by the brain in the order it asked.
 */
@Composable
private fun FieldsQuestionCard(store: WaslaStore, question: MohassanQuestion, busy: Boolean) {
    val forest = Forest
    val keyboard = LocalSoftwareKeyboardController.current
    val fields = question.fields.orEmpty()
    val several = fields.size > 1
    var step by rememberSaveable(question.id) { mutableIntStateOf(0) }
    val chosen = remember(question.id) {
        mutableStateListOf<Set<Int>>().also { list -> fields.forEach { field -> list.add(field.selected.orEmpty().filter { it in field.suggestions.indices }.toSet()) } }
    }
    val other = remember(question.id) { mutableStateListOf<String>().also { list -> fields.forEach { field -> list.add(field.initialValue ?: "") } } }

    fun answerOf(index: Int): String {
        val field = fields[index]
        val picked = chosen[index].sorted().mapNotNull { field.suggestions.getOrNull(it)?.label }
        val supplied = other[index]
        val typed = if (field.multiline == true) supplied else supplied.trim()
        // In a single-answer question a typed answer replaces the chosen suggestion.
        val parts = when {
            field.multiple == true -> picked + (if (typed.isNotBlank()) listOf(typed) else emptyList())
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
        store.answerMohassanFields(fields.zip(now) { field, value -> ChatFieldAnswer(field.id, value) })
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
        if (field.multiple == true) {
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
            if (field.multiple == true) Footnote("يمكنك اختيار أكثر من واحد، ثم اضغط «التالي».")
            field.suggestions.forEachIndexed { index, suggestion ->
                val on = chosen[step].contains(index) && !(typedHere.isNotEmpty() && field.multiple != true)
                SuggestionRow(index + 1, suggestion, on, enabled = !busy) { pick(step, index) }
            }
            OutlinedTextField(
                value = other[step], onValueChange = { other[step] = it }, modifier = Modifier.fillMaxWidth(), enabled = !busy,
                placeholder = { Text(field.placeholder ?: if (field.suggestions.isNotEmpty()) "إجابة أخرى…" else "اكتب إجابتك…") },
                minLines = if (field.multiline == true) 3 else 1, maxLines = if (field.multiline == true) 6 else 3, colors = fieldColors(),
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
            ForestButton(onClick = { store.answerMohassan(option, null) }, prominent = false, enabled = !busy) { Text(option.label) }
        }
        question.stopOption?.let { stop ->
            TextButton(onClick = { store.answerMohassan(stop, null) }, enabled = !busy) { Text(stop.label, color = forest.softText) }
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
private fun SuggestionRow(number: Int, suggestion: MohassanSuggestion, on: Boolean, enabled: Boolean, onClick: () -> Unit) {
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
private fun ApprovalCard(store: WaslaStore, approval: MohassanApproval, busy: Boolean) {
    val forest = Forest
    var confirm by remember(approval.id) { mutableStateOf(false) }
    ForestCard {
        LabelRow(Icons.Outlined.VerifiedUser, "يحتاج موافقتك")
        Text(approval.prompt, style = MaterialTheme.typography.bodyLarge, color = forest.ink)
        // What the server's permission gate bound this approval to (2026-11-23); absent from older servers.
        approval.bindingLines.forEach { Footnote(it) }
        if (approval.detail.isNotEmpty()) Footnote(approval.detail)
        Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            ForestButton(onClick = { store.approveMohassan(false) }, Modifier.weight(1f), prominent = false, enabled = !busy) { Text("رفض") }
            ForestButton(onClick = { confirm = true }, Modifier.weight(1f), enabled = !busy) { Text("موافق") }
        }
    }
    if (confirm) {
        AlertDialog(
            onDismissRequest = { confirm = false },
            title = { Text("تنفيذ هذا الإجراء؟") },
            text = { Text(approval.prompt) },
            confirmButton = { TextButton(onClick = { confirm = false; store.approveMohassan(true) }) { Text("موافق، نفّذ") } },
            dismissButton = { TextButton(onClick = { confirm = false }) { Text("تراجع") } },
        )
    }
}

@Composable
private fun SecureCard(store: WaslaStore, secure: MohassanSecure, busy: Boolean) {
    val forest = Forest
    val keyboard = LocalSoftwareKeyboardController.current
    var values by remember(secure.id) { mutableStateOf(emptyMap<String, String>()) }
    val handsOn = secure.kind == "hands_on"
    val ready = secure.fields.isNotEmpty() && secure.fields.all { field ->
        (field.id == "username" && secure.fields.size > 1) || !values[field.id].isNullOrBlank()
    }
    fun submit(action: String) {
        store.secureMohassan(action, values.takeIf { action == "submit" })
        values = emptyMap()
        keyboard?.hide()
    }
    ForestCard {
        LabelRow(Icons.Outlined.Lock, when (secure.kind) { "code" -> "يحتاج رمز تحقق"; "login" -> "يحتاج تسجيل دخول"; else -> "يحتاج خطوة منك" })
        Text(secure.prompt, style = MaterialTheme.typography.bodyLarge, color = forest.ink)
        if (secure.site.isNotEmpty()) Ltr { Text(secure.site, style = MaterialTheme.typography.labelSmall, color = forest.softText) }
        secure.note?.takeIf(String::isNotBlank)?.let { Footnote(it, color = forest.alert) }
        if (!handsOn) {
            secure.fields.forEach { field ->
                val keyboardType = when (field.type) {
                    "password" -> KeyboardType.Password
                    "code" -> KeyboardType.Number
                    else -> KeyboardType.Email
                }
                val maxLength = when (field.id) {
                    "password" -> 512
                    "code" -> 32
                    else -> 320
                }
                FieldBlock(field.label) {
                    Ltr {
                        OutlinedTextField(
                            value = values[field.id].orEmpty(),
                            onValueChange = { if (it.length <= maxLength) values = values + (field.id to it) },
                            modifier = Modifier.fillMaxWidth(),
                            enabled = !busy,
                            singleLine = true,
                            keyboardOptions = KeyboardOptions(keyboardType = keyboardType, autoCorrectEnabled = false),
                            visualTransformation = if (field.type == "password") PasswordVisualTransformation() else VisualTransformation.None,
                            colors = fieldColors(),
                        )
                    }
                }
            }
            Footnote("تُرسل هذه البيانات مباشرةً إلى الموقع لإكمال هذه الخطوة.")
        }
        Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            ForestButton(
                onClick = { submit(if (handsOn) "done" else "submit") },
                modifier = Modifier.weight(1f),
                enabled = !busy && (handsOn || ready),
            ) { Text(if (handsOn) "أكملت" else "متابعة") }
            ForestButton(
                onClick = { submit("skip") }, modifier = Modifier.weight(1f), prominent = false, enabled = !busy,
            ) { Text("تخطي") }
        }
    }
}

@Composable
private fun PendingCard(store: WaslaStore, request: PendingRequest, conversationId: String?) {
    val here = request.conversationId == conversationId
    var confirmDrop by remember(request.key) { mutableStateOf(false) }
    if (request.phase == PendingRequest.Phase.SENDING) {
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            if (here && request.fromComposer) {
                if (request.attachments.isNotEmpty()) AttachmentTray(request.attachments)
                if (request.text.isNotBlank()) ChatTurn(true, request.text)
            }
            WorkingSteps("يُرسل الطلب إلى موحسن…", emptyList())
        }
    } else {
        ForestCard {
            Text("لم يتأكد وصول الطلب", style = MaterialTheme.typography.titleMedium, color = Forest.alert)
            if (request.attachments.isNotEmpty()) AttachmentTray(request.attachments)
            if (request.text.isNotBlank()) Text(request.text, maxLines = 3)
            request.note?.takeIf(String::isNotBlank)?.let { Footnote(it) }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                if (store.requestKeys && request.resendable()) {
                    ForestButton(
                        onClick = { store.resendPendingMohassan() }, modifier = Modifier.weight(1f),
                    ) { Text("أرسل مرة أخرى") }
                }
                ForestButton(
                    onClick = { store.checkPendingMohassan() }, modifier = Modifier.weight(1f), prominent = false,
                ) { Text("راجع المحادثة") }
            }
            TextButton(onClick = { confirmDrop = true }) { Text("اتركه", color = Forest.alert) }
        }
    }
    if (confirmDrop) {
        AlertDialog(
            onDismissRequest = { confirmDrop = false },
            title = { Text("ترك هذا الطلب؟") },
            text = { Text("قد يكون الخادم استلمه. راجع المحادثة قبل الإرسال من جديد.") },
            confirmButton = {
                TextButton(onClick = {
                    confirmDrop = false
                    store.dropPendingMohassan()
                }) { Text("اتركه", color = Forest.alert) }
            },
            dismissButton = { TextButton(onClick = { confirmDrop = false }) { Text("تراجع") } },
        )
    }
}

@Composable
private fun PhotoPickerButton(store: WaslaStore, enabled: Boolean) {
    val remaining = MAX_CHAT_ATTACHMENTS - store.mohassanAttachments.size
    val single = rememberLauncherForActivityResult(ActivityResultContracts.PickVisualMedia()) { uri ->
        if (uri != null) store.uploadMohassanImages(listOf(uri))
    }
    val contract = remember(remaining) { ActivityResultContracts.PickMultipleVisualMedia(remaining.coerceAtLeast(2)) }
    val multi = rememberLauncherForActivityResult(contract) { uris ->
        if (uris.isNotEmpty()) store.uploadMohassanImages(uris)
    }
    IconButton(
        onClick = {
            val request = PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)
            if (remaining == 1) single.launch(request) else multi.launch(request)
        },
        enabled = enabled && remaining > 0,
    ) {
        Icon(Icons.Outlined.PhotoLibrary, contentDescription = "إرفاق صورة")
    }
}

@Composable
private fun AttachmentTray(
    attachments: List<ChatAttachment>,
    uploading: Boolean = false,
    onRemove: ((String) -> Unit)? = null,
) {
    Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        attachments.forEach { attachment ->
            val preview = remember(attachment) {
                BitmapFactory.decodeByteArray(attachment.preview, 0, attachment.preview.size)?.asImageBitmap()
            }
            Box(contentAlignment = Alignment.TopStart) {
                ChatPhoto(preview, Modifier.size(72.dp))
                if (onRemove != null) {
                    IconButton(
                        onClick = { onRemove(attachment.id) },
                        modifier = Modifier.size(36.dp).background(Forest.surface.copy(alpha = 0.9f), CircleShape),
                    ) {
                        Icon(Icons.Outlined.Close, contentDescription = "إزالة الصورة", modifier = Modifier.size(18.dp))
                    }
                }
            }
        }
        if (uploading) {
            Box(Modifier.size(72.dp), contentAlignment = Alignment.Center) {
                CircularProgressIndicator(Modifier.size(24.dp), strokeWidth = 2.dp)
            }
        }
    }
}

@Composable
private fun MessageImages(store: WaslaStore, images: List<ChatImageRef>) {
    Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        images.forEach { ref ->
            val photo = store.mohassanImages[ref.id]
            LaunchedEffect(ref.id) { store.loadMohassanImage(ref.id) }
            ChatPhoto(photo, Modifier.size(96.dp))
        }
    }
}

@Composable
private fun ChatPhoto(image: ImageBitmap?, modifier: Modifier) {
    val shape = RoundedCornerShape(12.dp)
    if (image != null) {
        Image(image, contentDescription = "صورة مرفقة", modifier = modifier.clip(shape), contentScale = ContentScale.Crop)
    } else {
        Box(modifier.background(Forest.soft, shape), contentAlignment = Alignment.Center) {
            Icon(Icons.Outlined.PhotoLibrary, contentDescription = "صورة مرفقة", tint = Forest.softText)
        }
    }
}

@Composable
private fun FeedbackButton(store: WaslaStore, messageId: String) {
    var expanded by remember { mutableStateOf(false) }
    var sending by remember { mutableStateOf(false) }
    var sent by rememberSaveable { mutableStateOf(false) }
    Box {
        TextButton(onClick = { expanded = true }, enabled = !sending && !sent) {
            Text(if (sent) "شكرًا" else "قيّم الرد")
        }
        DropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }) {
            listOf("مفيد" to "useful", "خطأ" to "wrong", "ناقص" to "incomplete").forEach { (label, verdict) ->
                DropdownMenuItem(text = { Text(label) }, onClick = {
                    expanded = false
                    sending = true
                    store.feedbackMohassan(verdict, messageId) { accepted ->
                        sent = accepted
                        sending = false
                    }
                })
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun BrowserScreenSheet(store: WaslaStore, onDismiss: () -> Unit) {
    val conversation = store.mohassanConversation
    var image by remember(conversation?.id) { mutableStateOf<ImageBitmap?>(null) }
    var loading by remember(conversation?.id) { mutableStateOf(true) }
    LaunchedEffect(conversation?.id, conversation?.working, store.foreground) {
        if (!store.foreground) return@LaunchedEffect
        do {
            store.loadMohassanScreen()?.let { image = it }
            loading = false
            if (conversation?.working != true) break
            delay(2_000)
        } while (true)
    }
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        containerColor = Forest.background,
    ) {
        Column(
            Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(20.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Text("شاشة المتصفح", Modifier.weight(1f), style = MaterialTheme.typography.titleLarge)
                TextButton(onClick = onDismiss) { Text("تم") }
            }
            val frame = image
            when {
                frame != null -> Image(
                    frame, contentDescription = "صورة من متصفح موحسن",
                    modifier = Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)),
                    contentScale = ContentScale.FillWidth,
                )
                loading -> Box(Modifier.fillMaxWidth().height(160.dp), contentAlignment = Alignment.Center) {
                    CircularProgressIndicator()
                }
                else -> Footnote("لا توجد صورة للمتصفح الآن.")
            }
            conversation?.browser?.url?.let { url -> Ltr { SelectionContainer { Footnote(url) } } }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun MohassanListSheet(store: WaslaStore, onDismiss: () -> Unit) {
    val forest = Forest
    var deleting by remember { mutableStateOf<MohassanSummary?>(null) }
    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true), containerColor = forest.background) {
        Column(Modifier.fillMaxWidth().padding(horizontal = 20.dp).padding(bottom = 24.dp)) {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Text("محادثات موحسن", Modifier.weight(1f), style = MaterialTheme.typography.titleLarge, color = forest.ink)
                IconButton(onClick = { store.loadMohassanList() }) { Icon(Icons.Outlined.Refresh, contentDescription = "تحديث", tint = forest.ink) }
                TextButton(onClick = onDismiss) { Text("تم") }
            }
            if (store.mohassanList.isEmpty()) Text("لا توجد محادثات بعد.", Modifier.padding(vertical = 24.dp), color = forest.softText)
            LazyColumn(Modifier.fillMaxWidth().heightIn(max = 480.dp)) {
                items(store.mohassanList, key = { it.id }) { item ->
                    Row(Modifier.fillMaxWidth().clickable { onDismiss(); store.openMohassan(item.id) }.padding(vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
                        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                            Text(item.title.ifEmpty { "محادثة" }, style = MaterialTheme.typography.bodyLarge, color = forest.ink, maxLines = 2)
                            Text(MohassanStatus.title(item.status), style = MaterialTheme.typography.bodySmall, color = forest.softText)
                        }
                        IconButton(onClick = { deleting = item }) { Icon(Icons.Outlined.Delete, contentDescription = "حذف", tint = forest.softText) }
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
            confirmButton = { TextButton(onClick = { store.deleteMohassan(item.id); deleting = null }) { Text("حذف", color = forest.alert) } },
            dismissButton = { TextButton(onClick = { deleting = null }) { Text("تراجع") } },
        )
    }
}
