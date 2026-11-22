package com.ahmadalwakai.wasla.ui

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowUpward
import androidx.compose.material.icons.filled.Stop
import androidx.compose.material.icons.outlined.ExpandMore
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextField
import androidx.compose.material3.TextFieldColors
import androidx.compose.material3.TextFieldDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.delay

/** The web's .primary / .secondary buttons. */
@Composable
fun ForestButton(
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    prominent: Boolean = true,
    enabled: Boolean = true,
    content: @Composable RowScope.() -> Unit,
) {
    val forest = Forest
    val shape = RoundedCornerShape(10.dp)
    val padding = PaddingValues(horizontal = 14.dp, vertical = 10.dp)
    if (prominent) {
        Button(
            onClick = onClick, modifier = modifier.fillMaxWidth().heightIn(min = 44.dp), enabled = enabled, shape = shape,
            colors = ButtonDefaults.buttonColors(containerColor = forest.accent, contentColor = forest.onAccent, disabledContainerColor = forest.soft, disabledContentColor = forest.faint),
            contentPadding = padding, content = content,
        )
    } else {
        OutlinedButton(
            onClick = onClick, modifier = modifier.fillMaxWidth().heightIn(min = 44.dp), enabled = enabled, shape = shape,
            border = BorderStroke(1.dp, forest.line),
            colors = ButtonDefaults.outlinedButtonColors(contentColor = forest.ink, disabledContentColor = forest.faint),
            contentPadding = padding, content = content,
        )
    }
}

/** The web's .card: raised, a hairline border, a soft shadow. */
@Composable
fun ForestCard(modifier: Modifier = Modifier, onClick: (() -> Unit)? = null, content: @Composable ColumnScope.() -> Unit) {
    val forest = Forest
    val shape = RoundedCornerShape(16.dp)
    Column(
        modifier = modifier
            .fillMaxWidth()
            .shadow(2.dp, shape, ambientColor = Color.Black.copy(alpha = 0.04f), spotColor = Color.Black.copy(alpha = 0.08f))
            .background(forest.surface, shape)
            .border(1.dp, forest.line, shape)
            .then(if (onClick != null) Modifier.clickable(onClick = onClick) else Modifier)
            .padding(horizontal = 18.dp, vertical = 16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
        content = content,
    )
}

@Composable
fun ScreenTitle(title: String, subtitle: String) {
    val forest = Forest
    Column(Modifier.fillMaxWidth().padding(bottom = 4.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Text(title, style = MaterialTheme.typography.headlineMedium.copy(fontWeight = FontWeight.Medium), color = forest.ink)
        Text(subtitle, style = MaterialTheme.typography.bodyMedium, color = forest.softText)
    }
}

@Composable
fun LabelRow(icon: ImageVector, text: String, modifier: Modifier = Modifier, tint: Color = Forest.ink, style: androidx.compose.ui.text.TextStyle = MaterialTheme.typography.titleMedium) {
    Row(modifier, verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Icon(icon, contentDescription = null, tint = tint, modifier = Modifier.size(20.dp))
        Text(text, style = style, color = tint)
    }
}

@Composable
fun Footnote(text: String, color: Color = Forest.softText) {
    Text(text, style = MaterialTheme.typography.bodySmall, color = color)
}

/** Inputs inside cards sit on the page colour with a soft outline, as on iOS. */
@Composable
fun fieldColors(): TextFieldColors {
    val forest = Forest
    return OutlinedTextFieldDefaults.colors(
        focusedBorderColor = forest.faint, unfocusedBorderColor = forest.line, cursorColor = forest.accent,
        focusedTextColor = forest.ink, unfocusedTextColor = forest.ink,
        focusedContainerColor = forest.background, unfocusedContainerColor = forest.background,
        focusedPlaceholderColor = forest.faint, unfocusedPlaceholderColor = forest.faint,
    )
}

@Composable
fun FieldBlock(title: String, content: @Composable () -> Unit) {
    val forest = Forest
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(title, style = MaterialTheme.typography.bodyMedium.copy(fontWeight = FontWeight.SemiBold), color = forest.ink)
        content()
    }
}

/** Wraps chips onto new lines, centred, like the web's suggestions row. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun ChipFlow(items: List<String>, onPick: (String) -> Unit) {
    val forest = Forest
    FlowRow(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.CenterHorizontally), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        items.forEach { item ->
            Text(
                item, style = MaterialTheme.typography.bodyMedium, color = forest.softText,
                modifier = Modifier.border(1.dp, forest.line, CircleShape).clickable { onPick(item) }.padding(horizontal = 14.dp, vertical = 7.dp),
            )
        }
    }
}

/**
 * A thread that scrolls under a composer pinned above the keyboard, shared by Mohassan's
 * chat and the local fallback chat. Sending clears focus, so the keyboard closes.
 */
@Composable
fun ChatScaffold(
    draft: String,
    onDraftChange: (String) -> Unit,
    placeholder: String,
    tooLong: Boolean,
    canSend: Boolean,
    working: Boolean,
    scrollKey: Int,
    showComposer: Boolean = true,
    onSend: () -> Boolean,
    onStop: (() -> Unit)? = null,
    thread: LazyListScope.() -> Unit,
) {
    val forest = Forest
    val listState = rememberLazyListState()
    val keyboard = LocalSoftwareKeyboardController.current
    val focus = LocalFocusManager.current
    LaunchedEffect(scrollKey) {
        delay(60)
        val count = listState.layoutInfo.totalItemsCount
        if (count > 0) listState.animateScrollToItem(count - 1)
    }
    Column(Modifier.fillMaxSize().background(forest.background)) {
        LazyColumn(
            state = listState,
            modifier = Modifier.weight(1f).fillMaxWidth(),
            contentPadding = PaddingValues(start = 16.dp, end = 16.dp, top = 8.dp, bottom = 12.dp),
            verticalArrangement = Arrangement.spacedBy(22.dp),
        ) {
            thread()
            item(key = "thread-end") { Spacer(Modifier.height(1.dp)) }
        }
        if (showComposer) {
            var focused by remember { mutableStateOf(false) }
            val shape = RoundedCornerShape(20.dp)
            Column(
                Modifier.fillMaxWidth().background(forest.background).padding(horizontal = 12.dp, vertical = 8.dp).widthIn(max = 740.dp),
                verticalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                Row(
                    Modifier
                        .fillMaxWidth()
                        .shadow(2.dp, shape, ambientColor = Color.Black.copy(alpha = 0.05f), spotColor = Color.Black.copy(alpha = 0.1f))
                        .background(forest.surface, shape)
                        .border(1.dp, if (focused) forest.faint else forest.line, shape)
                        .padding(start = 6.dp, end = 8.dp, top = 4.dp, bottom = 4.dp),
                    verticalAlignment = Alignment.Bottom,
                ) {
                    TextField(
                        value = draft,
                        onValueChange = onDraftChange,
                        modifier = Modifier.weight(1f).onFocusChanged { focused = it.isFocused },
                        placeholder = { Text(placeholder, color = forest.faint) },
                        maxLines = 6,
                        textStyle = MaterialTheme.typography.bodyLarge.copy(color = forest.ink, lineHeight = 24.sp),
                        colors = TextFieldDefaults.colors(
                            focusedContainerColor = Color.Transparent, unfocusedContainerColor = Color.Transparent, disabledContainerColor = Color.Transparent,
                            focusedIndicatorColor = Color.Transparent, unfocusedIndicatorColor = Color.Transparent, disabledIndicatorColor = Color.Transparent,
                            cursorColor = forest.accent, focusedTextColor = forest.ink, unfocusedTextColor = forest.ink,
                        ),
                    )
                    if (working && onStop != null) {
                        IconButton(onClick = onStop, modifier = Modifier.padding(bottom = 6.dp).size(36.dp).background(forest.soft, RoundedCornerShape(12.dp))) {
                            Icon(Icons.Filled.Stop, contentDescription = "إيقاف", tint = forest.ink, modifier = Modifier.size(18.dp))
                        }
                    } else {
                        IconButton(
                            onClick = { if (onSend()) { focus.clearFocus(); keyboard?.hide() } },
                            enabled = canSend,
                            modifier = Modifier.padding(bottom = 6.dp).size(36.dp).background(if (canSend) forest.accent else forest.soft, RoundedCornerShape(12.dp)),
                        ) {
                            Icon(Icons.Filled.ArrowUpward, contentDescription = "إرسال الرسالة", tint = if (canSend) forest.onAccent else forest.faint, modifier = Modifier.size(20.dp))
                        }
                    }
                }
                if (tooLong) Text("الرسالة أطول من المسموح. اختصرها قبل الإرسال.", style = MaterialTheme.typography.bodySmall, color = forest.alert)
            }
        }
    }
}

/** The web's welcome: the mark, one question, suggestion chips. */
@Composable
fun ChatWelcome(title: String, suggestions: List<String>, pick: (String) -> Unit) {
    val forest = Forest
    Column(Modifier.fillMaxWidth().padding(top = 72.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(22.dp)) {
        Box(
            Modifier.size(46.dp).shadow(2.dp, RoundedCornerShape(14.dp), spotColor = Color.Black.copy(alpha = 0.06f)).background(forest.accent, RoundedCornerShape(14.dp)),
            contentAlignment = Alignment.Center,
        ) { Text("م", color = forest.onAccent, style = MaterialTheme.typography.titleLarge.copy(fontWeight = FontWeight.SemiBold)) }
        Text(title, style = MaterialTheme.typography.headlineSmall.copy(fontWeight = FontWeight.Medium), color = forest.ink, textAlign = TextAlign.Center)
        ChipFlow(suggestions, pick)
    }
}

/** A user turn: a soft bubble on the reading side. An assistant turn: plain text, no bubble. */
@Composable
fun ChatTurn(mine: Boolean, text: String) {
    val forest = Forest
    if (mine) {
        Row(Modifier.fillMaxWidth()) {
            SelectionContainer(Modifier.weight(1f, fill = false)) {
                Text(
                    text, style = MaterialTheme.typography.bodyLarge.copy(lineHeight = 26.sp), color = forest.ink,
                    modifier = Modifier
                        .background(forest.soft, RoundedCornerShape(topStart = 6.dp, topEnd = 18.dp, bottomEnd = 18.dp, bottomStart = 18.dp))
                        .padding(horizontal = 16.dp, vertical = 10.dp),
                )
            }
            Spacer(Modifier.width(48.dp))
        }
    } else {
        SelectionContainer(Modifier.fillMaxWidth()) {
            Text(text, style = MaterialTheme.typography.bodyLarge.copy(lineHeight = 28.sp), color = forest.ink, modifier = Modifier.fillMaxWidth())
        }
    }
}

/** The web's working pill and its step list. */
@Composable
fun WorkingSteps(progress: String, steps: List<String>) {
    val forest = Forest
    var open by remember { mutableStateOf(false) }
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Row(
            Modifier
                .background(forest.surface, CircleShape)
                .border(1.dp, forest.line, CircleShape)
                .then(if (steps.isNotEmpty()) Modifier.clickable { open = !open } else Modifier)
                .padding(horizontal = 11.dp, vertical = 5.dp),
            verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            CircularProgressIndicator(Modifier.size(14.dp), color = forest.accent, strokeWidth = 2.dp)
            Text(progress, style = MaterialTheme.typography.bodyMedium, color = forest.softText, maxLines = 2)
            if (steps.isNotEmpty()) Icon(Icons.Outlined.ExpandMore, contentDescription = null, tint = forest.softText, modifier = Modifier.size(16.dp).rotate(if (open) 180f else 0f))
        }
        AnimatedVisibility(open && steps.isNotEmpty()) {
            Row(Modifier.padding(start = 12.dp)) {
                Box(Modifier.width(2.dp).heightIn(min = 16.dp).background(forest.line))
                Column(Modifier.padding(start = 14.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    steps.forEach { Text(it, style = MaterialTheme.typography.bodyMedium, color = forest.softText) }
                }
            }
        }
    }
}
