package com.ahmadalwakai.wasla

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * The cloud session cookie, sealed with a key that never leaves the Android Keystore (AES-GCM) and
 * kept only on this device: the counterpart of the iOS Keychain item, and excluded from backups.
 */
internal object SessionVault {
    private const val PREFS = "wasla.vault"
    private const val ENTRY = "cloud-session-cookie"
    private const val ALIAS = "wasla.cloud.session"
    private const val PROVIDER = "AndroidKeyStore"
    private const val IV_BYTES = 12

    private fun key(create: Boolean): SecretKey? {
        val store = KeyStore.getInstance(PROVIDER).apply { load(null) }
        (store.getKey(ALIAS, null) as? SecretKey)?.let { return it }
        if (!create) return null
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, PROVIDER)
        generator.init(
            KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build()
        )
        return generator.generateKey()
    }

    suspend fun read(context: Context): SessionCookie? = withContext(Dispatchers.IO) {
        val stored = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(ENTRY, null) ?: return@withContext null
        try {
            val raw = Base64.decode(stored, Base64.NO_WRAP)
            if (raw.size <= IV_BYTES) return@withContext null
            val key = key(create = false) ?: return@withContext null
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(128, raw, 0, IV_BYTES))
            SessionCookie.fromHeader(String(cipher.doFinal(raw, IV_BYTES, raw.size - IV_BYTES), Charsets.UTF_8))
        } catch (ignored: Exception) {
            null
        }
    }

    suspend fun save(context: Context, cookie: SessionCookie) = withContext(Dispatchers.IO) {
        try {
            val key = key(create = true) ?: throw IllegalStateException("keystore")
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.ENCRYPT_MODE, key)
            val sealed = cipher.iv + cipher.doFinal(cookie.header.encodeToByteArray())
            val written = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
                .putString(ENTRY, Base64.encodeToString(sealed, Base64.NO_WRAP)).commit()
            if (!written) throw IllegalStateException("commit")
        } catch (error: Exception) {
            throw WaslaException.storage()
        }
    }

    suspend fun forgetLegacyPairing(context: Context) = withContext(Dispatchers.IO) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().remove("paired-device-token").apply()
        try { KeyStore.getInstance(PROVIDER).apply { load(null) }.deleteEntry("wasla.device.token") } catch (ignored: Exception) {}
    }

    suspend fun delete(context: Context) = withContext(Dispatchers.IO) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().remove(ENTRY).commit()
        try { KeyStore.getInstance(PROVIDER).apply { load(null) }.deleteEntry(ALIAS) } catch (ignored: Exception) {}
        Unit
    }
}
