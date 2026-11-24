package com.ahmadalwakai.wasla

import android.app.Application
import android.graphics.Bitmap
import android.net.Uri
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import java.io.IOException

class WaslaStore(application: Application) : AndroidViewModel(application) {
    enum class Account { LOADING, SIGNED_OUT, SIGNED_IN }

    internal val cloud = CloudApi(AndroidSessionVault(application))
    internal val pendingVault = PendingRequestVault(application)
    internal val remote = RemoteControlStore(cloud, viewModelScope)

    var account by mutableStateOf(Account.LOADING)
        private set
    var email by mutableStateOf<String?>(null)
        private set
    var signingIn by mutableStateOf(false)
        private set
    var errorMessage by mutableStateOf<String?>(null)
    internal var foreground by mutableStateOf(false)
        private set
    internal var sessionEpoch = 0
    internal var chatEpoch = 0
    internal var watchJob: Job? = null
    internal var requestJob: Job? = null

    var chatList by mutableStateOf<List<ChatSummary>>(emptyList())
        internal set
    var conversation by mutableStateOf<ChatConversation?>(null)
        internal set
    var capabilities by mutableStateOf<ChatCapabilities?>(null)
        internal set
    var requestKeys by mutableStateOf(false)
        internal set
    var opening by mutableStateOf(false)
        internal set
    var draft by mutableStateOf("")
    var pending by mutableStateOf<PendingRequest?>(null)
        internal set
    var sending by mutableStateOf(false)
        internal set
    var secureBusy by mutableStateOf(false)
        internal set
    var imagesAvailable by mutableStateOf(false)
        internal set
    var uploading by mutableStateOf(false)
        internal set
    internal val loadedImages = mutableStateMapOf<String, Bitmap>()
    internal val loadingImages = mutableSetOf<String>()
    internal val attachments = mutableStateListOf<String>()

    val busy: Boolean get() = sending || pending != null
    val signedIn: Boolean get() = account == Account.SIGNED_IN

    init {
        viewModelScope.launch {
            cloud.signedIn.collect { authenticated ->
                if (!authenticated && signedIn) {
                    signingIn = true
                    endSession()
                    errorMessage = "انتهت جلستك. سجّل الدخول مرة أخرى."
                    try {
                        pendingVault.clear()
                    } catch (error: Exception) {
                        if (error is CancellationException) throw error
                    } finally {
                        signingIn = false
                    }
                }
            }
        }
        viewModelScope.launch {
            try {
                cloud.restore()
                if (cloud.signedIn.value) startSession()
                else account = Account.SIGNED_OUT
            } catch (error: Exception) {
                account = Account.SIGNED_OUT
                show(error)
            }
        }
    }

    fun signIn(typedEmail: String, password: String) {
        val address = typedEmail.trim()
        if (account != Account.SIGNED_OUT || signingIn || address.isEmpty() || password.isEmpty()) return
        signingIn = true
        errorMessage = null
        viewModelScope.launch {
            try {
                val reply = cloud.signIn(address, password)
                email = reply.user?.email ?: address
                startSession()
            } catch (error: Exception) {
                show(error)
            } finally {
                signingIn = false
            }
        }
    }

    fun signOut() {
        if (!signedIn) return
        endSession()
        signingIn = true
        viewModelScope.launch {
            try {
                cloud.signOut()
            } catch (error: Exception) {
                show(error)
            } finally {
                try {
                    pendingVault.clear()
                } catch (error: Exception) {
                    show(error)
                } finally {
                    signingIn = false
                }
            }
        }
    }

    private suspend fun startSession() {
        sessionEpoch++
        restorePending()
        account = Account.SIGNED_IN
        viewModelScope.launch {
            refreshList()
            if (signedIn) resumePending()
        }
        viewModelScope.launch { refreshImageAvailability() }
    }

    private fun endSession() {
        sessionEpoch++
        chatEpoch++
        account = Account.SIGNED_OUT
        watchJob?.cancel()
        watchJob = null
        requestJob?.cancel()
        requestJob = null
        remote.reset()
        email = null
        errorMessage = null
        chatList = emptyList()
        conversation = null
        capabilities = null
        requestKeys = false
        opening = false
        draft = ""
        pending = null
        sending = false
        secureBusy = false
        imagesAvailable = false
        uploading = false
        loadedImages.clear()
        loadingImages.clear()
        attachments.clear()
    }

    fun sceneChanged(active: Boolean) {
        foreground = active
        remote.setForeground(active)
        if (!signedIn) return
        if (active) {
            viewModelScope.launch {
                val id = conversation?.id
                if (id != null) refreshConversation(id) else refreshList()
                resumePending()
            }
        } else {
            watchJob?.cancel()
            watchJob = null
        }
    }

    internal fun show(error: Exception) {
        if (error is CancellationException) throw error
        if (signedIn && !cloud.signedIn.value) return
        errorMessage = when (error) {
            is CloudHttpError, is CloudInvalidResponse, is CloudInvalidCredentials, is CloudSignedOut -> error.message
            is IOException -> "تعذّر الوصول إلى الخادم. تحقق من اتصال الهاتف بالإنترنت."
            else -> error.localizedMessage ?: "تعذّر إكمال الطلب."
        }
    }

    internal fun readPhoto(uri: Uri) = getApplication<Application>().contentResolver.openInputStream(uri)
}
