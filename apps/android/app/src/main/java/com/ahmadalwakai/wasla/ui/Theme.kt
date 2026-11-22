package com.ahmadalwakai.wasla.ui

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.unit.LayoutDirection

/** The web workspace's palette (apps/web/components/assistant-app.module.css), light and dark, as on iOS. */
@Immutable
data class ForestColors(
    val background: Color,  // --page
    val panel: Color,       // --panel
    val surface: Color,     // --raised
    val ink: Color,         // --ink
    val softText: Color,    // --soft
    val faint: Color,       // --faint
    val line: Color,        // --line
    val soft: Color,        // --user / --hover
    val accent: Color,      // --accent
    val accentSoft: Color,  // --accent-soft
    val onAccent: Color,    // --accent-ink
    val alert: Color,       // --alert
)

val LightForest = ForestColors(
    background = Color(0xFFFAF9F6), panel = Color(0xFFF4F2ED), surface = Color(0xFFFFFFFF), ink = Color(0xFF22201C),
    softText = Color(0xFF6B675F), faint = Color(0xFF9A968C), line = Color(0xFFE7E4DC), soft = Color(0xFFEFECE4),
    accent = Color(0xFF1F6F5C), accentSoft = Color(0xFFE3EFE9), onAccent = Color(0xFFFFFFFF), alert = Color(0xFFA33A2C),
)

val DarkForest = ForestColors(
    background = Color(0xFF1E1D1B), panel = Color(0xFF181715), surface = Color(0xFF292825), ink = Color(0xFFEDEBE5),
    softText = Color(0xFFA6A298), faint = Color(0xFF77746C), line = Color(0xFF34322D), soft = Color(0xFF2E2C28),
    accent = Color(0xFF4FB596), accentSoft = Color(0xFF1F3A31), onAccent = Color(0xFF0F1F1A), alert = Color(0xFFEE9383),
)

val LocalForest = staticCompositionLocalOf { LightForest }

val Forest: ForestColors
    @Composable @ReadOnlyComposable get() = LocalForest.current

/** The whole app reads right to left; URLs, codes and the desktop frame switch to LTR locally. */
@Composable
fun MohassanTheme(content: @Composable () -> Unit) {
    val dark = isSystemInDarkTheme()
    val forest = if (dark) DarkForest else LightForest
    val base = if (dark) darkColorScheme() else lightColorScheme()
    val scheme = base.copy(
        primary = forest.accent, onPrimary = forest.onAccent,
        primaryContainer = forest.accentSoft, onPrimaryContainer = forest.accent,
        secondary = forest.accent, onSecondary = forest.onAccent,
        secondaryContainer = forest.accentSoft, onSecondaryContainer = forest.accent,
        background = forest.background, onBackground = forest.ink,
        surface = forest.background, onSurface = forest.ink,
        surfaceVariant = forest.soft, onSurfaceVariant = forest.softText,
        surfaceContainerLowest = forest.surface, surfaceContainerLow = forest.panel, surfaceContainer = forest.panel,
        surfaceContainerHigh = forest.surface, surfaceContainerHighest = forest.surface,
        outline = forest.line, outlineVariant = forest.line,
        error = forest.alert, onError = forest.onAccent,
        errorContainer = forest.alert.copy(alpha = 0.12f), onErrorContainer = forest.alert,
    )
    CompositionLocalProvider(LocalForest provides forest, LocalLayoutDirection provides LayoutDirection.Rtl) {
        MaterialTheme(colorScheme = scheme, content = content)
    }
}

@Composable
fun Ltr(content: @Composable () -> Unit) {
    CompositionLocalProvider(LocalLayoutDirection provides LayoutDirection.Ltr, content = content)
}
