package com.ahmadalwakai.wasla.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.consumeWindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Computer
import androidx.compose.material.icons.outlined.Edit
import androidx.compose.material.icons.outlined.History
import androidx.compose.material.icons.outlined.Link
import androidx.compose.material.icons.outlined.Refresh
import androidx.compose.material.icons.outlined.Settings
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CenterAlignedTopAppBar
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.focus.FocusDirection
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import com.ahmadalwakai.wasla.Account
import com.ahmadalwakai.wasla.CLOUD_ORIGIN
import com.ahmadalwakai.wasla.RemoteReadiness
import com.ahmadalwakai.wasla.WaslaStore
import com.ahmadalwakai.wasla.WindowsAction
import com.ahmadalwakai.wasla.loadMohassanList
import com.ahmadalwakai.wasla.newMohassanChat

@Composable
fun RootView(store: WaslaStore) {
    val forest = Forest
    Box(Modifier.fillMaxSize().background(forest.background)) {
        when (store.account) {
            Account.LOADING -> Column(
                Modifier.fillMaxSize(),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.Center,
            ) {
                CircularProgressIndicator(color = forest.accent)
                Spacer(Modifier.height(12.dp))
                Text("موحسن", color = forest.softText)
            }
            Account.SIGNED_OUT -> SignInView(store)
            Account.SIGNED_IN -> AppShell(store)
        }
    }
    store.errorMessage?.let { message ->
        AlertDialog(
            onDismissRequest = { store.errorMessage = null },
            confirmButton = { TextButton(onClick = { store.errorMessage = null }) { Text("حسنًا") } },
            title = { Text("تعذّر إكمال الإجراء") },
            text = { Text(message) },
        )
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun AppShell(store: WaslaStore) {
    var settings by remember { mutableStateOf(false) }
    var conversations by remember { mutableStateOf(false) }
    var remote by remember { mutableStateOf(false) }
    BackHandler(enabled = remote) { remote = false }
    if (remote) {
        RemoteControlView(store) { remote = false }
        return
    }
    val forest = Forest
    Scaffold(
        containerColor = forest.background,
        topBar = {
            CenterAlignedTopAppBar(
                title = { Text("موحسن", fontWeight = FontWeight.Medium) },
                navigationIcon = {
                    Row {
                        IconButton(onClick = {
                            conversations = true
                            store.loadMohassanList()
                        }) {
                            Icon(Icons.Outlined.History, contentDescription = "المحادثات")
                        }
                        IconButton(onClick = { store.newMohassanChat() }, enabled = !store.mohassanSending) {
                            Icon(Icons.Outlined.Edit, contentDescription = "محادثة جديدة")
                        }
                    }
                },
                actions = {
                    IconButton(onClick = { remote = true }) {
                        Icon(
                            Icons.Outlined.Computer,
                            contentDescription = if (store.remoteWanted) "التحكم بالكمبيوتر مفعّل" else "التحكم بالكمبيوتر",
                            tint = if (store.remoteWanted) forest.accent else forest.ink,
                        )
                    }
                    IconButton(onClick = { settings = true }) {
                        Icon(Icons.Outlined.Settings, contentDescription = "الإعدادات")
                    }
                },
                colors = TopAppBarDefaults.centerAlignedTopAppBarColors(containerColor = forest.background),
            )
        },
    ) { inner ->
        Box(Modifier.padding(inner).consumeWindowInsets(inner).imePadding().fillMaxSize()) {
            MohassanChatView(store)
        }
    }
    if (settings) SettingsSheet(store) { settings = false }
    if (conversations) MohassanListSheet(store) { conversations = false }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun SignInView(store: WaslaStore) {
    val forest = Forest
    val focus = LocalFocusManager.current
    var email by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    val ready = email.isNotBlank() && password.isNotEmpty() && !store.signingIn
    fun submit() {
        if (!ready) return
        focus.clearFocus()
        store.signIn(email.trim(), password)
        password = ""
    }
    Scaffold(
        containerColor = forest.background,
        topBar = { CenterAlignedTopAppBar(title = { Text("موحسن") }) },
    ) { inner ->
        CenteredScroll(Modifier.padding(inner).consumeWindowInsets(inner).imePadding()) {
            ScreenTitle("سجّل الدخول إلى موحسن", "استخدم حسابك نفسه على الويب للوصول إلى محادثاتك.")
            ForestCard {
                FieldBlock("البريد الإلكتروني") {
                    Ltr {
                        OutlinedTextField(
                            value = email,
                            onValueChange = { email = it },
                            modifier = Modifier.fillMaxWidth(),
                            placeholder = { Text("name@example.com") },
                            singleLine = true,
                            enabled = !store.signingIn,
                            keyboardOptions = KeyboardOptions(
                                keyboardType = KeyboardType.Email,
                                imeAction = ImeAction.Next,
                                autoCorrectEnabled = false,
                            ),
                            keyboardActions = KeyboardActions(onNext = { focus.moveFocus(FocusDirection.Next) }),
                            colors = fieldColors(),
                        )
                    }
                }
                FieldBlock("كلمة المرور") {
                    Ltr {
                        OutlinedTextField(
                            value = password,
                            onValueChange = { password = it },
                            modifier = Modifier.fillMaxWidth(),
                            singleLine = true,
                            enabled = !store.signingIn,
                            visualTransformation = PasswordVisualTransformation(),
                            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password, imeAction = ImeAction.Go),
                            keyboardActions = KeyboardActions(onGo = { submit() }),
                            colors = fieldColors(),
                        )
                    }
                }
            }
            ForestButton(onClick = ::submit, enabled = ready) {
                if (store.signingIn) {
                    CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp)
                } else {
                    Text("دخول")
                }
            }
            Ltr { SelectionContainer { Footnote(CLOUD_ORIGIN.removePrefix("https://")) } }
        }
    }
}

@Composable
private fun CenteredScroll(modifier: Modifier = Modifier, content: @Composable ColumnScope.() -> Unit) {
    Box(modifier.fillMaxSize(), contentAlignment = Alignment.TopCenter) {
        Column(
            Modifier.widthIn(max = 700.dp).fillMaxWidth().verticalScroll(rememberScrollState()).padding(20.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
            content = content,
        )
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun RemoteControlView(store: WaslaStore, onClose: () -> Unit) {
    val forest = Forest
    val readiness = store.remote
    var stopConfirm by remember { mutableStateOf(false) }
    val showStop = store.remoteWanted || readiness?.on == true
    val switchEnabled = !store.remoteBusy && (showStop || readiness?.canTurnOn == true)
    DisposableEffect(store) {
        store.remoteScreenOpened()
        store.loadWindows()
        onDispose { store.remoteScreenClosed() }
    }
    Scaffold(
        containerColor = forest.background,
        topBar = {
            CenterAlignedTopAppBar(
                title = { Text("الكمبيوتر") },
                navigationIcon = { TextButton(onClick = onClose) { Text("تم") } },
                actions = {
                    IconButton(onClick = { store.loadWindows() }, enabled = !store.remoteBusy) {
                        Icon(Icons.Outlined.Refresh, contentDescription = "تحديث حالة الكمبيوتر")
                    }
                },
            )
        },
    ) { inner ->
        CenteredScroll(Modifier.padding(inner).consumeWindowInsets(inner).imePadding()) {
            ForestCard {
                Row(
                    modifier = Modifier.fillMaxWidth().toggleable(
                        value = store.remoteWanted,
                        enabled = switchEnabled,
                        role = Role.Switch,
                        onValueChange = store::setRemote,
                    ).heightIn(min = 48.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        Text("التحكم عن بُعد بتطبيق Windows", style = MaterialTheme.typography.titleMedium)
                        Footnote(
                            readiness?.title ?: if (store.windowsProblem == null) "جارٍ قراءة حالة الكمبيوتر…" else "تعذّرت قراءة حالة الكمبيوتر",
                            color = if (store.remoteWanted) forest.accent else forest.softText,
                        )
                    }
                    Switch(checked = store.remoteWanted, enabled = switchEnabled, onCheckedChange = null)
                }
                if (store.remoteBusy) CircularProgressIndicator(Modifier.size(22.dp), strokeWidth = 2.dp)
                readiness?.advice?.takeIf(String::isNotBlank)?.let { Footnote(it) }
                store.windowsProblem?.let { Footnote(it, color = forest.alert) }
                store.remoteNote?.let { Footnote(it, color = forest.alert) }
            }
            if (readiness == RemoteReadiness.NoDevice) WindowsPairingCard(store)
            if (store.remoteWanted) WindowsControls(store)
            if (showStop) {
                ForestButton(onClick = { stopConfirm = true }, prominent = false) {
                    Text("إيقاف كامل (STOP)", color = forest.alert)
                }
            }
            Footnote("عند تشغيل المفتاح يستطيع موحسن التحكم في النافذة المسموح بها إذا طلبت ذلك في المحادثة. يمكنك إيقاف التحكم من Mohassan Companion على الكمبيوتر.")
        }
    }
    if (stopConfirm) {
        AlertDialog(
            onDismissRequest = { stopConfirm = false },
            title = { Text("إيقاف كل شيء على الكمبيوتر؟") },
            text = { Text("تتوقف المشاهدة والتحكم فورًا. يلزم سماح جديد من Mohassan Companion على الكمبيوتر.") },
            confirmButton = {
                TextButton(onClick = {
                    stopConfirm = false
                    store.stopRemoteCompletely()
                }) { Text("أوقف كل شيء", color = forest.alert) }
            },
            dismissButton = { TextButton(onClick = { stopConfirm = false }) { Text("تراجع") } },
        )
    }
}

@Composable
private fun WindowsPairingCard(store: WaslaStore) {
    val pairing = store.pairing
    ForestCard {
        LabelRow(Icons.Outlined.Link, "ربط كمبيوتر")
        if (pairing == null) {
            Footnote("أنشئ رمزًا والصقه في Mohassan Companion على الكمبيوتر.")
            ForestButton(onClick = { store.pairWindows() }, enabled = !store.remoteBusy) { Text("أنشئ رمز ربط") }
        } else {
            Ltr {
                SelectionContainer {
                    Text(pairing.code, style = MaterialTheme.typography.titleLarge, fontFamily = FontFamily.Monospace)
                }
            }
            Footnote("ألصق الرمز في حقل «رمز الربط من مساحة العمل»، ثم اختر «ربط الجهاز محليًا». ينتهي الرمز خلال دقيقتين.")
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun WindowsControls(store: WaslaStore) {
    var rightClick by remember { mutableStateOf(false) }
    var typed by remember { mutableStateOf("") }
    val frame = store.remoteFrame
    val hasFrame = frame != null
    ForestCard {
        if (frame != null) {
            Ltr {
                Image(
                    bitmap = frame,
                    contentDescription = "صورة النافذة المسموح بها. المس مكانًا للنقر عليه.",
                    modifier = Modifier.fillMaxWidth().aspectRatio(frame.width.toFloat() / frame.height)
                        .clip(RoundedCornerShape(12.dp)).background(Color.Black)
                        .pointerInput(rightClick, store) {
                            detectTapGestures { location ->
                                store.remoteAct(WindowsAction.click(
                                    x = (location.x / size.width).toDouble(),
                                    y = (location.y / size.height).toDouble(),
                                    right = rightClick,
                                ))
                            }
                        },
                    contentScale = ContentScale.Fit,
                )
            }
        } else {
            Box(Modifier.fillMaxWidth().heightIn(min = 160.dp), contentAlignment = Alignment.Center) {
                CircularProgressIndicator()
            }
        }
    }
    ForestCard {
        SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth()) {
            SegmentedButton(
                selected = !rightClick,
                onClick = { rightClick = false },
                shape = SegmentedButtonDefaults.itemShape(index = 0, count = 2),
            ) { Text("نقرة يسرى") }
            SegmentedButton(
                selected = rightClick,
                onClick = { rightClick = true },
                shape = SegmentedButtonDefaults.itemShape(index = 1, count = 2),
            ) { Text("نقرة يمنى") }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            ForestButton(
                onClick = { store.remoteAct(WindowsAction.scroll(3)) },
                modifier = Modifier.weight(1f), prominent = false, enabled = hasFrame,
            ) { Text("تمرير لأعلى") }
            ForestButton(
                onClick = { store.remoteAct(WindowsAction.scroll(-3)) },
                modifier = Modifier.weight(1f), prominent = false, enabled = hasFrame,
            ) { Text("تمرير لأسفل") }
        }
        OutlinedTextField(
            value = typed, onValueChange = { typed = it }, modifier = Modifier.fillMaxWidth(),
            label = { Text("نص يُكتب على الكمبيوتر") }, supportingText = { Text("حتى ١٢٠ حرفًا") },
            singleLine = true, colors = fieldColors(),
        )
        ForestButton(
            onClick = {
                store.remoteAct(WindowsAction.text(typed))
                typed = ""
            },
            enabled = hasFrame && WindowsAction.textFits(typed),
        ) { Text("اكتب على الكمبيوتر") }
        WindowsKeyRow(store, hasFrame, listOf("Enter" to "Enter", "⌫" to "Backspace", "Tab" to "Tab", "Esc" to "Escape"))
        WindowsKeyRow(store, hasFrame, listOf("←" to "ArrowLeft", "↑" to "ArrowUp", "↓" to "ArrowDown", "→" to "ArrowRight"))
    }
}

@Composable
private fun WindowsKeyRow(store: WaslaStore, enabled: Boolean, keys: List<Pair<String, String>>) {
    Ltr {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(2.dp)) {
            keys.forEach { (label, key) ->
                TextButton(
                    onClick = { store.remoteAct(WindowsAction.key(key)) },
                    modifier = Modifier.weight(1f),
                    enabled = enabled,
                ) { Text(label) }
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun SettingsSheet(store: WaslaStore, onDismiss: () -> Unit) {
    val forest = Forest
    var confirmSignOut by remember { mutableStateOf(false) }
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        containerColor = forest.background,
    ) {
        Column(
            Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(horizontal = 20.dp).padding(bottom = 24.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Text("الإعدادات", Modifier.weight(1f), style = MaterialTheme.typography.titleLarge)
                TextButton(onClick = onDismiss) { Text("تم") }
            }
            ForestCard {
                Text("الحساب", style = MaterialTheme.typography.titleMedium)
                store.email?.let { email -> Ltr { SelectionContainer { Text(email) } } }
                Ltr { SelectionContainer { Footnote(CLOUD_ORIGIN.removePrefix("https://")) } }
                TextButton(onClick = { confirmSignOut = true }) { Text("تسجيل الخروج", color = forest.alert) }
            }
        }
    }
    if (confirmSignOut) {
        AlertDialog(
            onDismissRequest = { confirmSignOut = false },
            title = { Text("تسجيل الخروج من هذا الهاتف؟") },
            text = { Text("تبقى محادثاتك على الخادم، ويتوقف التحكم بالكمبيوتر من هذا الهاتف.") },
            confirmButton = {
                TextButton(onClick = {
                    confirmSignOut = false
                    store.signOut()
                    onDismiss()
                }) { Text("تسجيل الخروج", color = forest.alert) }
            },
            dismissButton = { TextButton(onClick = { confirmSignOut = false }) { Text("تراجع") } },
        )
    }
}
