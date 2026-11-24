package com.ahmadalwakai.wasla

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import java.security.KeyStore
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

class AndroidSessionVault(context: Context) : SessionVault {
    private val app = context.applicationContext
    private val cookie = KeystoreEntry(app, "session-cookie")

    override fun read(): String? {
        forgetGatewayPairing()
        return cookie.read()?.decodeToString()
    }

    override fun save(cookie: String) = this.cookie.save(cookie.encodeToByteArray())

    override fun clear() = cookie.clear()

    private fun forgetGatewayPairing() {
        app.deleteSharedPreferences("wasla")
        app.deleteSharedPreferences("wasla.vault")
        runCatching { androidKeystore().deleteEntry("wasla.device.token") }
    }
}

class PendingRequestVault(context: Context) {
    private val entry = KeystoreEntry(context.applicationContext, "pending-chat")
    private val lock = Mutex()

    @Serializable
    private data class Saved(val binding: String, val request: PendingRequest)

    suspend fun read(binding: String): PendingRequest? = lock.withLock {
        withContext(Dispatchers.IO) {
            val encoded = entry.read() ?: return@withContext null
            val saved = runCatching { Json.decodeFromString<Saved>(encoded.decodeToString()) }.getOrNull()
            saved?.takeIf { it.binding == binding }?.request
        }
    }

    suspend fun save(binding: String, request: PendingRequest) = lock.withLock {
        withContext(Dispatchers.IO) {
            entry.save(Json.encodeToString(Saved.serializer(), Saved(binding, request)).encodeToByteArray())
        }
    }

    suspend fun clear() = lock.withLock {
        withContext(Dispatchers.IO) { entry.clear() }
    }
}

private const val PROVIDER = "AndroidKeyStore"
private fun androidKeystore(): KeyStore = KeyStore.getInstance(PROVIDER).apply { load(null) }

private class KeystoreEntry(context: Context, private val name: String) {
    private val prefs = context.getSharedPreferences("mohassan.cloud", Context.MODE_PRIVATE)
    private val alias = "mohassan.cloud.$name"

    private fun key(create: Boolean): SecretKey? {
        (androidKeystore().getKey(alias, null) as? SecretKey)?.let { return it }
        if (!create) return null
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, PROVIDER)
        generator.init(
            KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build(),
        )
        return generator.generateKey()
    }

    fun read(): ByteArray? {
        val stored = prefs.getString(name, null) ?: return null
        return try {
            val raw = Base64.getDecoder().decode(stored)
            val key = key(create = false)
            if (raw.size <= IV_BYTES || key == null) {
                clear()
                return null
            }
            val cipher = Cipher.getInstance(TRANSFORMATION)
            cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(128, raw, 0, IV_BYTES))
            cipher.doFinal(raw, IV_BYTES, raw.size - IV_BYTES)
        } catch (_: Exception) {
            clear()
            null
        }
    }

    fun save(value: ByteArray) {
        try {
            val cipher = Cipher.getInstance(TRANSFORMATION)
            cipher.init(Cipher.ENCRYPT_MODE, requireNotNull(key(create = true)))
            check(cipher.iv.size == IV_BYTES)
            val sealed = cipher.iv + cipher.doFinal(value)
            check(prefs.edit().putString(name, Base64.getEncoder().encodeToString(sealed)).commit())
        } catch (_: Exception) {
            throw IllegalStateException("تعذّر الحفظ الآمن على الهاتف.")
        }
    }

    fun clear() {
        if (!prefs.edit().remove(name).commit()) {
            runCatching { androidKeystore().deleteEntry(alias) }
        }
    }

    private companion object {
        const val TRANSFORMATION = "AES/GCM/NoPadding"
        const val IV_BYTES = 12
    }
}
