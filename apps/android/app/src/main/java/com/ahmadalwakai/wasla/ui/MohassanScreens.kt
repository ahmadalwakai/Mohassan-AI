package com.ahmadalwakai.wasla.ui

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
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.HelpOutline
import androidx.compose.material.icons.filled.Stop
import androidx.compose.material.icons.outlined.Check
import androidx.compose.material.icons.outlined.Delete
import androidx.compose.material.icons.outlined.Lock
import androidx.compose.material.icons.outlined.Refresh
import androidx.compose.material.icons.outlined.VerifiedUser
import androidx.compose.material3.AlertDialog
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
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.ahmadalwakai.wasla.MohassanApproval
import com.ahmadalwakai.wasla.MohassanConversation
import com.ahmadalwakai.wasla.MohassanCampaignStream
import com.ahmadalwakai.wasla.MohassanQuestion
import com.ahmadalwakai.wasla.MohassanSecure
import com.ahmadalwakai.wasla.MohassanStatus
import com.ahmadalwakai.wasla.MohassanSuggestion
import com.ahmadalwakai.wasla.MohassanSummary
import com.ahmadalwakai.wasla.WaslaStore
import com.ahmadalwakai.wasla.answerMohassan
import com.ahmadalwakai.wasla.answerMohassanFields
import com.ahmadalwakai.wasla.approveMohassan
import com.ahmadalwakai.wasla.cancelMohassan
import com.ahmadalwakai.wasla.deleteMohassan
import com.ahmadalwakai.wasla.loadMohassanList
import com.ahmadalwakai.wasla.mohassanBusy
import com.ahmadalwakai.wasla.mohassanTextFits
import com.ahmadalwakai.wasla.mohassanWaiting
import com.ahmadalwakai.wasla.openMohassan
import com.ahmadalwakai.wasla.sendMohassan
import com.ahmadalwakai.wasla.resumeMohassanCampaign

/** Mohassan's chat: the thread, the working pill, and the cards that answer its questions and approvals. */
@Composable
fun MohassanChatView(store: WaslaStore) {
    val draft = store.mohassanDraft
    val clean = draft.trim()
    val conversation = store.mohassanConversation
    val pending = store.mohassanPendingText
    val waiting = store.mohassanWaiting
    val scrollKey = (conversation?.messages?.size ?: 0) * 1_000 + (conversation?.steps?.size ?: 0) * 2 + (conversation?.campaign?.lastSeq ?: 0) + (if (waiting) 1 else 0) + (if (pending == null) 0 else 500_000)
    ChatScaffold(
        draft = draft,
        onDraftChange = { store.mohassanDraft = it },
        placeholder = if (conversation == null) "ماذا تريد أن ينجز موحسن؟" else "اكتب رسالتك…",
        tooLong = !mohassanTextFits(draft),
        canSend = !store.mohassanBusy && clean.isNotEmpty() && mohassanTextFits(draft),
        working = store.mohassanBusy,
        scrollKey = scrollKey,
        showComposer = !waiting,
        onSend = { if (store.sendMohassan(draft)) { store.mohassanDraft = ""; true } else false },
        onStop = { store.cancelMohassan() },
    ) {
        when {
            conversation != null -> conversationItems(store, conversation)
            pending != null -> {
                item(key = "pending") { ChatTurn(true, pending) }
                item(key = "sending") { WorkingSteps("يُرسل الطلب إلى موحسن…", emptyList()) }
            }
            else -> item(key = "welcome") {
                ChatWelcome("بمَ أساعدك اليوم؟", listOf("خطّط لحملة إعلانية", "لخّص لي موضوعًا", "نظّم مهامي")) { store.mohassanDraft = it }
            }
        }
    }
}

private fun LazyListScope.conversationItems(store: WaslaStore, conversation: MohassanConversation) {
    items(conversation.messages, key = { "message-${it.id}" }) { message -> ChatTurn(message.role == "user", message.text) }
    if (conversation.working) item(key = "working") { WorkingSteps(conversation.progress ?: "موحسن يعمل…", conversation.steps.map { it.text }) }
    conversation.campaign?.let { campaign -> item(key = "campaign-${campaign.taskId}") { CampaignEvidenceCard(campaign) } }
    if (conversation.canReviewSavedCampaign) item(key = "campaign-recovery-${conversation.campaignRecovery?.runId}") {
        ForestCard {
            LabelRow(Icons.Outlined.VerifiedUser, "تحقق من نتيجة العملية السابقة")
            Footnote("نقرأ العملية المحفوظة من حساب Google Ads ونقارنها بالمطلوب. هذه المراجعة للقراءة فقط؛ لا تعيد إنشاء الحملة أو إرسال طلب كتابة.")
            ForestButton(onClick = { store.resumeMohassanCampaign() }, prominent = false, enabled = !store.mohassanBusy) { Text("مراجعة نتيجة العملية المحفوظة") }
        }
    }
    val question = conversation.question
    if (conversation.status == MohassanStatus.WAITING_USER && question != null) {
        item(key = "question-${question.id}") { if (question.hasFields) FieldsQuestionCard(store, question) else QuestionCard(store, question) }
    }
    val approval = conversation.approval
    if (conversation.status == MohassanStatus.WAITING_APPROVAL && approval != null) item(key = "approval-${approval.id}") { ApprovalCard(store, approval) }
    val secure = conversation.secure
    if (conversation.status == MohassanStatus.WAITING_INPUT && secure != null) item(key = "secure-${secure.id}") { SecureCard(secure) }
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

/** Every label refers to a server event; local validation is never presented as a remote account effect. */
@Composable
private fun CampaignEvidenceCard(campaign: MohassanCampaignStream) {
    val forest = Forest
    val account = campaign.account
    val verifications = campaign.verifications
    val operations = campaign.operations
    var expanded by rememberSaveable(campaign.taskId) { mutableStateOf(false) }
    val scopes = mapOf("local_text" to "نص الإعلان", "landing_page" to "صفحة الهبوط", "draft_integrity" to "سلامة العمليات", "account" to "الحساب", "conversion_tracking" to "تتبع التحويلات", "google_validate_only" to "فحص Google دون إنشاء", "readback" to "قراءة الحساب بعد التنفيذ")
    ForestCard {
        LabelRow(Icons.Outlined.VerifiedUser, "أدلة مهمة Google Ads")
        if (account != null) {
            Text("الحساب: ${account.customerId}", style = MaterialTheme.typography.bodyMedium, color = forest.ink)
            Footnote("العملة: ${account.currency} · المنطقة الزمنية: ${account.timeZone}")
            Footnote("فترة البيانات: ${account.range.start} — ${account.range.end}")
            Footnote("وقت قراءة الحساب: ${account.checkedAt}")
        } else Footnote("لم تصل قراءة موثقة لعملة الحساب والمنطقة الزمنية بعد.")
        campaign.completion?.let { completion ->
            val text = when (completion.outcome) {
                "draft_checked" -> "فُحصت المسودة فقط؛ لا يثبت ذلك إنشاء حملة في الحساب."
                "paused_campaign_created", "paused_campaign_recovered" -> "سجّل الخادم تطابق حملة متوقفة من الحساب. لم يثبت أداء الحملة أو أهليتها بهذا الفحص."
                else -> "نتيجة مسجلة من الخادم: ${completion.outcome}"
            }
            Text(text, style = MaterialTheme.typography.bodyMedium, color = forest.ink)
        }
        operations.forEach { operation ->
            val label = when (operation.outcome) {
                "confirmed_paused" -> "أكدت القراءة حملة متوقفة"
                "confirmed_absent" -> "أكدت القراءة عدم وجود الحملة"
                "mismatch" -> "القراءة لا تطابق المطلوب"
                "rejected" -> "رفضت Google الطلب"
                else -> "النتيجة غير محسومة؛ تحتاج قراءة الحساب"
            }
            Text(label, style = MaterialTheme.typography.bodyMedium, color = if (operation.outcome == "mismatch") forest.alert else forest.ink)
            operation.campaignResourceName?.let { Footnote(it) }
        }
        if (verifications.isEmpty()) Footnote("لا توجد نتائج فحص مسجلة بعد.") else {
            TextButton(onClick = { expanded = !expanded }, modifier = Modifier.fillMaxWidth().heightIn(min = 44.dp)) { Text(if (expanded) "إخفاء نتائج الفحص" else "عرض نتائج الفحص (${verifications.size})") }
            if (expanded) verifications.forEach { observation ->
                val verification = observation.value
                Text("${scopes[verification.scope] ?: verification.scope}: ${if (verification.passed) "نجح" else "لم ينجح"}", style = MaterialTheme.typography.bodyMedium, color = if (verification.passed) forest.ink else forest.alert)
                Footnote("${if (verification.authority == "google_ads_api") "من Google Ads" else "فحص محلي"} · ${observation.at}")
                verification.checks.forEach { check -> Footnote("${if (check.passed) "✓" else "✗"} ${check.detail}") }
            }
        }
        if (verifications.any { it.value.scope == "google_validate_only" && it.value.passed }) Footnote("نجاح فحص Google يؤكد صحة الطلب فقط؛ لا يثبت أهلية الإعلان أو أداء الحملة.")
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
private fun QuestionCard(store: WaslaStore, question: MohassanQuestion) {
    val forest = Forest
    val keyboard = LocalSoftwareKeyboardController.current
    var answer by rememberSaveable(question.id) { mutableStateOf("") }
    val busy = store.mohassanSending
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
        if (question.acceptsText) {
            OutlinedTextField(value = answer, onValueChange = { answer = it }, modifier = Modifier.fillMaxWidth(), placeholder = { Text("أو اكتب إجابتك…") }, maxLines = 4, enabled = !busy, colors = fieldColors())
            ForestButton(onClick = { store.answerMohassan(null, answer); answer = ""; keyboard?.hide() }, enabled = !busy && answer.isNotBlank() && answer.length <= 2_000) { Text("إرسال الإجابة") }
        }
    }
}

/**
 * Several questions in one card, as the web's question panel: each lists the brain's
 * suggestions with the confident one chosen in advance and a box for another answer; the
 * answers go together as one numbered reply, read by the brain in the order it asked.
 */
@Composable
private fun FieldsQuestionCard(store: WaslaStore, question: MohassanQuestion) {
    val forest = Forest
    val keyboard = LocalSoftwareKeyboardController.current
    val fields = question.fields.orEmpty()
    val several = fields.size > 1
    val busy = store.mohassanSending
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
        store.answerMohassanFields(text)
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
private fun ApprovalCard(store: WaslaStore, approval: MohassanApproval) {
    val forest = Forest
    var confirm by remember(approval.id) { mutableStateOf(false) }
    val busy = store.mohassanSending
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
private fun SecureCard(secure: MohassanSecure) {
    val forest = Forest
    ForestCard {
        LabelRow(Icons.Outlined.Lock, when (secure.kind) { "code" -> "يحتاج رمز تحقق"; "login" -> "يحتاج تسجيل دخول"; else -> "يحتاج خطوة منك" })
        Text(secure.prompt, style = MaterialTheme.typography.bodyLarge, color = forest.ink)
        if (secure.site.isNotEmpty()) Ltr { Text(secure.site, style = MaterialTheme.typography.labelSmall, color = forest.softText) }
        Footnote("أكمل هذه الخطوة من واجهة موحسن على الويب، ثم يتابع موحسن من حيث توقف. لا تُرسل كلمات المرور ورموز التحقق عبر الهاتف في هذه النسخة.")
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
