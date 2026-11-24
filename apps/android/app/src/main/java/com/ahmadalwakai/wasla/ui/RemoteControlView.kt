package com.ahmadalwakai.wasla.ui

import android.graphics.BitmapFactory
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.Image
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.ahmadalwakai.wasla.RemoteControlStore
import com.ahmadalwakai.wasla.RemoteScreenFrame
import com.ahmadalwakai.wasla.WindowsAction
import com.ahmadalwakai.wasla.WindowsPairing
import com.ahmadalwakai.wasla.WindowsReadiness
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle

@Composable
internal fun RemoteControlView(store: RemoteControlStore, onClose: () -> Unit) {
    val state by store.state.collectAsStateWithLifecycle()
    val readiness = state.readiness
    var confirmingStop by rememberSaveable { mutableStateOf(false) }

    BackHandler(onBack = onClose)
    DisposableEffect(store) {
        store.setScreenOpen(true)
        onDispose { store.setScreenOpen(false) }
    }

    Scaffold(modifier = Modifier.imePadding()) { insets ->
        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            modifier = Modifier.fillMaxSize().padding(insets).verticalScroll(rememberScrollState()),
        ) {
            Column(
                modifier = Modifier.widthIn(max = 700.dp).fillMaxWidth().padding(16.dp),
                verticalArrangement = Arrangement.spacedBy(14.dp),
            ) {
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                    Text("الكمبيوتر", Modifier.weight(1f), style = MaterialTheme.typography.titleLarge)
                    TextButton(onClick = store::refresh, enabled = !state.busy) { Text("تحديث") }
                    TextButton(onClick = onClose) { Text("تم") }
                }

                RemoteCard {
                    val switchEnabled = !state.busy && (state.wanted || readiness?.canTurnOn == true)
                    Row(
                        Modifier.fillMaxWidth().toggleable(
                            value = state.wanted,
                            enabled = switchEnabled,
                            role = Role.Switch,
                            onValueChange = store::setControl,
                        ).padding(vertical = 4.dp),
                        horizontalArrangement = Arrangement.spacedBy(12.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                            Text("التحكم عن بُعد بتطبيق Windows", style = MaterialTheme.typography.titleMedium)
                            Text(
                                readiness?.title(state.device?.name) ?: if (state.problem == null) {
                                    "جارٍ قراءة حالة الكمبيوتر…"
                                } else "تعذّرت قراءة حالة الكمبيوتر",
                                style = MaterialTheme.typography.bodyMedium,
                            )
                        }
                        Switch(checked = state.wanted, onCheckedChange = null, enabled = switchEnabled)
                    }
                    if (state.busy) CircularProgressIndicator(Modifier.align(Alignment.CenterHorizontally))
                    readiness?.advice()?.let {
                        Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    state.problem?.let { Text(it, color = MaterialTheme.colorScheme.error) }
                    state.note?.let { Text(it, color = MaterialTheme.colorScheme.onSurfaceVariant) }
                }

                if (readiness == WindowsReadiness.NoDevice) {
                    PairingCard(state.pairing, state.busy, store::pair)
                }
                if (state.wanted) {
                    RemoteInteraction(state.frame, store::act)
                }
                if (state.wanted || state.device?.grant != null) {
                    OutlinedButton(onClick = { confirmingStop = true }, enabled = !state.busy) {
                        Text("إيقاف كامل (STOP)", color = MaterialTheme.colorScheme.error)
                    }
                }
            }
        }
    }

    if (confirmingStop) {
        AlertDialog(
            onDismissRequest = { confirmingStop = false },
            title = { Text("إيقاف كل شيء على الكمبيوتر؟") },
            text = { Text("يتوقف التحكم والمشاهدة، ويلزم سماح جديد في Mohassan Companion على الكمبيوتر.") },
            confirmButton = {
                TextButton(onClick = {
                    confirmingStop = false
                    store.stop()
                }) { Text("أوقف كل شيء", color = MaterialTheme.colorScheme.error) }
            },
            dismissButton = { TextButton(onClick = { confirmingStop = false }) { Text("رجوع") } },
        )
    }
}

@Composable
private fun RemoteCard(content: @Composable ColumnScope.() -> Unit) {
    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp), content = content)
    }
}

@Composable
private fun PairingCard(pairing: WindowsPairing?, busy: Boolean, onPair: () -> Unit) {
    val clipboard = LocalClipboardManager.current
    RemoteCard {
        Text("ربط كمبيوتر", style = MaterialTheme.typography.titleMedium)
        if (pairing == null) {
            Text("أنشئ رمزًا وألصقه في برنامج Mohassan Companion على الكمبيوتر.")
            Button(onClick = onPair, enabled = !busy) { Text("أنشئ رمز ربط") }
        } else {
            Ltr {
                Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
                    Text(pairing.code, style = MaterialTheme.typography.headlineSmall, fontFamily = FontFamily.Monospace)
                }
            }
            OutlinedButton(onClick = { clipboard.setText(AnnotatedString(pairing.code)) }) { Text("نسخ الرمز") }
            Text("الصق الرمز في «رمز الربط من مساحة العمل» ثم اضغط «ربط الجهاز محليًا». ينتهي الرمز خلال دقيقتين.")
        }
    }
}

private data class DisplayedFrame(val source: RemoteScreenFrame, val bitmap: ImageBitmap)

@Composable
private fun RemoteInteraction(frame: RemoteScreenFrame?, onAction: (WindowsAction, RemoteScreenFrame) -> Unit) {
    var rightClick by rememberSaveable { mutableStateOf(false) }
    var typed by remember { mutableStateOf("") }
    val decoded by produceState<DisplayedFrame?>(null, frame) {
        value = frame?.let { source ->
            withContext(Dispatchers.Default) {
                BitmapFactory.decodeByteArray(source.imageData, 0, source.imageData.size)
                    ?.let { DisplayedFrame(source, it.asImageBitmap()) }
            }
        }
    }
    val displayed = decoded.takeIf { frame != null && it?.source?.grantId == frame.grantId }
    val send: (WindowsAction) -> Unit = { action -> displayed?.let { onAction(action, it.source) } }

    RemoteCard {
        if (displayed == null) {
            Box(Modifier.fillMaxWidth().heightIn(min = 160.dp), contentAlignment = Alignment.Center) {
                Text("بانتظار صورة من الكمبيوتر…")
            }
        } else {
            val bitmap = displayed.bitmap
            Ltr {
                Image(
                    bitmap = bitmap,
                    contentDescription = "صورة النافذة المسموح بها على الكمبيوتر. المس موضعًا للنقر عليه.",
                    modifier = Modifier.fillMaxWidth().aspectRatio(bitmap.width.toFloat() / bitmap.height)
                        .pointerInput(displayed, rightClick) {
                            detectTapGestures { point ->
                                onAction(
                                    WindowsAction.Click(
                                        x = point.x.toDouble() / size.width.coerceAtLeast(1),
                                        y = point.y.toDouble() / size.height.coerceAtLeast(1),
                                        right = rightClick,
                                    ),
                                    displayed.source,
                                )
                            }
                        },
                )
            }
            val time = DateTimeFormatter.ofLocalizedTime(FormatStyle.MEDIUM)
                .withZone(ZoneId.systemDefault()).format(displayed.source.receivedAt)
            Text("آخر صورة $time", style = MaterialTheme.typography.bodySmall)
        }
    }

    RemoteCard {
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            FilterChip(selected = !rightClick, onClick = { rightClick = false }, label = { Text("نقرة يسرى") })
            FilterChip(selected = rightClick, onClick = { rightClick = true }, label = { Text("نقرة يمنى") })
        }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedButton(enabled = displayed != null, onClick = { send(WindowsAction.Scroll(3)) }) { Text("تمرير لأعلى") }
            OutlinedButton(enabled = displayed != null, onClick = { send(WindowsAction.Scroll(-3)) }) { Text("تمرير لأسفل") }
        }
        OutlinedTextField(
            value = typed,
            onValueChange = { typed = it },
            modifier = Modifier.fillMaxWidth(),
            singleLine = true,
            label = { Text("نص على الكمبيوتر (حتى ١٢٠ حرفًا)") },
        )
        Button(
            enabled = displayed != null && WindowsAction.textFits(typed),
            onClick = {
                send(WindowsAction.Text(typed))
                typed = ""
            },
        ) { Text("اكتب على الكمبيوتر") }
        RemoteKeys(WINDOWS_KEYS, displayed != null, send)
        RemoteKeys(ARROW_KEYS, displayed != null, send)
    }
}

@Composable
private fun RemoteKeys(keys: List<Triple<String, String, String>>, enabled: Boolean, send: (WindowsAction) -> Unit) {
    Ltr {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            keys.forEach { (label, key, description) ->
                TextButton(
                    onClick = { send(WindowsAction.Key(key)) },
                    modifier = Modifier.weight(1f).semantics { contentDescription = description },
                    enabled = enabled,
                    contentPadding = PaddingValues(horizontal = 4.dp),
                ) { Text(label) }
            }
        }
    }
}

private val WINDOWS_KEYS = listOf(
    Triple("Enter", "Enter", "إدخال"),
    Triple("⌫", "Backspace", "حذف الحرف السابق"),
    Triple("Tab", "Tab", "انتقال"),
    Triple("Esc", "Escape", "خروج"),
)
private val ARROW_KEYS = listOf(
    Triple("←", "ArrowLeft", "السهم الأيسر"),
    Triple("↑", "ArrowUp", "السهم الأعلى"),
    Triple("↓", "ArrowDown", "السهم الأسفل"),
    Triple("→", "ArrowRight", "السهم الأيمن"),
)

private fun WindowsReadiness.title(name: String?): String = when (this) {
    WindowsReadiness.Disabled -> "التحكم بـ Windows متوقف على الخادم"
    WindowsReadiness.NoDevice -> "لا يوجد كمبيوتر مرتبط"
    WindowsReadiness.Offline -> "$name غير متصل الآن"
    WindowsReadiness.Unsafe -> "$name مقفل أو على شاشة محمية"
    WindowsReadiness.NeedsView, WindowsReadiness.NeedsControl -> "يلزم السماح على $name"
    WindowsReadiness.Ready -> "$name جاهز للتحكم"
    WindowsReadiness.Active -> "التحكم مفعّل على $name"
}

private fun WindowsReadiness.advice(): String? = when (this) {
    WindowsReadiness.Disabled, WindowsReadiness.NoDevice -> null
    WindowsReadiness.Offline -> "شغّل Mohassan Companion على الكمبيوتر وتأكد من اتصاله بالإنترنت."
    WindowsReadiness.Unsafe -> "افتح قفل الكمبيوتر واسمح بالتحكم من جديد."
    WindowsReadiness.NeedsView -> "اختر نافذة في Mohassan Companion واسمح محليًا بالمشاهدة والإدخال."
    WindowsReadiness.NeedsControl -> "اسمح محليًا بالإدخال ضمن النافذة المحددة في Mohassan Companion."
    WindowsReadiness.Ready -> "بعد تشغيل المفتاح، يمكن لهذا الهاتف وموحسن التحكم بالنافذة المسموح بها."
    WindowsReadiness.Active -> "يتجدد الإذن ما دام المفتاح مشغّلًا والتطبيق مفتوحًا."
}
