package com.ahmadalwakai.wasla.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Add
import androidx.compose.material.icons.outlined.Menu
import androidx.compose.material.icons.outlined.Settings
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LocalTextStyle
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextDirection
import androidx.compose.ui.unit.dp
import com.ahmadalwakai.wasla.WaslaStore
import com.ahmadalwakai.wasla.loadConversations
import com.ahmadalwakai.wasla.newConversation

@Composable
fun RootView(store: WaslaStore) {
    when (store.account) {
        WaslaStore.Account.LOADING -> SessionLoadingView(store)
        WaslaStore.Account.SIGNED_OUT -> SignInView(store)
        WaslaStore.Account.SIGNED_IN -> if (store.canChat) ChatShell(store) else AccountRestrictedView(store)
    }
    val chatError = store.errorMessage?.takeIf { store.account == WaslaStore.Account.SIGNED_IN && store.canChat }
    chatError?.let { error ->
        AlertDialog(
            onDismissRequest = store::clearError,
            title = { Text("موحسن") },
            text = { Text(error) },
            confirmButton = { TextButton(onClick = store::clearError) { Text("حسنًا") } },
        )
    }
}

@Composable
private fun SessionLoadingView(store: WaslaStore) {
    val error = store.errorMessage
    Column(
        Modifier.fillMaxSize().background(Forest.background).safeDrawingPadding().padding(24.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp, Alignment.CenterVertically),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        if (error == null) {
            CircularProgressIndicator()
            Text("جارٍ التحقق من الجلسة…")
        } else {
            ScreenTitle("تعذّر التحقق من الجلسة", error)
            ForestButton(onClick = store::retrySession) { Text("أعد المحاولة") }
            TextButton(onClick = store::signOut) { Text("تسجيل الخروج") }
        }
    }
}

@Composable
private fun AccountRestrictedView(store: WaslaStore) {
    Column(
        Modifier.fillMaxSize().background(Forest.background).safeDrawingPadding().padding(24.dp),
        verticalArrangement = Arrangement.Center,
    ) {
        ScreenTitle("المحادثات غير متاحة", "هذا الحساب لا يملك صلاحية استخدام المحادثات.")
        TextButton(onClick = store::signOut) { Text("تسجيل الخروج") }
    }
}

@Composable
private fun SignInView(store: WaslaStore) {
    var email by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    val focus = LocalFocusManager.current
    val enabled = !store.signingIn && email.isNotBlank() && password.isNotEmpty()
    val submit: () -> Unit = {
        if (enabled) {
            focus.clearFocus()
            store.signIn(email, password)
            password = ""
        }
    }
    Column(
        Modifier.fillMaxSize().background(Forest.background).safeDrawingPadding().imePadding().verticalScroll(rememberScrollState()).padding(24.dp),
        verticalArrangement = Arrangement.Center,
    ) {
        ScreenTitle("موحسن", "سجّل الدخول بحسابك في موحسن.")
        ForestCard(Modifier.padding(top = 20.dp)) {
            val credentialsStyle = LocalTextStyle.current.copy(textDirection = TextDirection.Ltr)
            OutlinedTextField(
                value = email, onValueChange = { email = it }, modifier = Modifier.fillMaxWidth(),
                label = { Text("البريد الإلكتروني") }, singleLine = true, enabled = !store.signingIn,
                textStyle = credentialsStyle,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email, imeAction = ImeAction.Next),
                colors = fieldColors(),
            )
            OutlinedTextField(
                value = password, onValueChange = { password = it }, modifier = Modifier.fillMaxWidth(),
                label = { Text("كلمة المرور") }, singleLine = true, enabled = !store.signingIn,
                textStyle = credentialsStyle,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password, imeAction = ImeAction.Done),
                keyboardActions = KeyboardActions(onDone = { submit() }),
                visualTransformation = PasswordVisualTransformation(), colors = fieldColors(),
            )
            store.errorMessage?.let { error ->
                Text(
                    error,
                    modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite },
                    color = Forest.alert,
                    style = MaterialTheme.typography.bodyMedium,
                )
            }
            ForestButton(onClick = submit, enabled = enabled) { Text(if (store.signingIn) "جارٍ تسجيل الدخول…" else "تسجيل الدخول") }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ChatShell(store: WaslaStore) {
    var list by rememberSaveable { mutableStateOf(false) }
    var settings by rememberSaveable { mutableStateOf(false) }
    Scaffold(
        modifier = Modifier.imePadding(),
        containerColor = Forest.background,
        topBar = {
            TopAppBar(
                title = { Text("موحسن") },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = Forest.background),
                navigationIcon = {
                    IconButton(onClick = { list = true; store.loadConversations() }) {
                        Icon(Icons.Outlined.Menu, contentDescription = "المحادثات")
                    }
                },
                actions = {
                    IconButton(onClick = store::newConversation, enabled = !store.sending && !store.uploading && !store.secureBusy) {
                        Icon(Icons.Outlined.Add, contentDescription = "محادثة جديدة")
                    }
                    IconButton(onClick = { settings = true }) {
                        Icon(Icons.Outlined.Settings, contentDescription = "الإعدادات")
                    }
                },
            )
        },
    ) { inset ->
        Box(Modifier.fillMaxSize().padding(inset)) { MohassanChatView(store) { list = true; store.loadConversations() } }
    }
    if (list) MohassanListSheet(store, onDismiss = { list = false })
    if (settings) {
        AlertDialog(
            onDismissRequest = { settings = false },
            title = { Text("الحساب") },
            text = { store.email?.let { email -> Ltr { Text(email, style = MaterialTheme.typography.bodyLarge) } } },
            confirmButton = {
                TextButton(onClick = { settings = false; store.signOut() }) { Text("تسجيل الخروج", color = Forest.alert) }
            },
            dismissButton = { TextButton(onClick = { settings = false }) { Text("تم") } },
        )
    }
}
