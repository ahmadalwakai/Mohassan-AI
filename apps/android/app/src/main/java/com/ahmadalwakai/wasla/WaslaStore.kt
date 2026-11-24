package com.ahmadalwakai.wasla

import android.app.Application
import android.content.Context
import android.graphics.BitmapFactory
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import java.time.Instant

enum class Account { LOADING, SIGNED_OUT, SIGNED_IN }

class WaslaStore(application: Application) : AndroidViewModel(application) {

    internal val app: Context = application.applicationContext
    internal val prefs = app.getSharedPreferences("wasla", Context.MODE_PRIVATE)
    private val vault = Mutex()

    var account by mutableStateOf(Account.LOADING); private set
    val signedIn: Boolean get() = account == Account.SIGNED_IN
    var email by mutableStateOf<String?>(null); private set
    var signingIn by mutableStateOf(false); private set
    var errorMessage by mutableStateOf<String?>(null)
    internal var client: CloudClient? = null; private set
    internal var sessionEpoch = 0; private set
    internal var foreground by mutableStateOf(true); private set

    val mohassanList = mutableStateListOf<MohassanSummary>()
    var mohassanConversation by mutableStateOf<MohassanConversation?>(null); internal set
    var mohassanCapabilities by mutableStateOf<ChatCapabilities?>(null); internal set
    var mohassanDraft by mutableStateOf("")
    var mohassanSending by mutableStateOf(false); internal set
    var pendingMohassan by mutableStateOf<PendingRequest?>(null); internal set
    var requestKeys by mutableStateOf(false); internal set
    var mohassanSecureBusy by mutableStateOf(false); internal set
    val mohassanAttachments = mutableStateListOf<ChatAttachment>()
    val mohassanImages = mutableStateMapOf<String, ImageBitmap>()
    internal val loadingImages = mutableSetOf<String>()
    var mohassanUploading by mutableStateOf(false); internal set
    var mohassanImagesAvailable by mutableStateOf(false); internal set
    var mohassanScreen by mutableStateOf<ImageBitmap?>(null); internal set
    internal var mohassanEpoch = 0
    internal var mohassanPollJob: Job? = null
    internal var mohassanSendJob: Job? = null

    private var windows by mutableStateOf<WindowsOverview?>(null)
    private var remoteDeviceId by mutableStateOf<String?>(null)
    val remote: RemoteReadiness? get() = windows?.let { RemoteReadiness.of(it, remoteDeviceId) }
    var windowsProblem by mutableStateOf<String?>(null); private set
    var remoteWanted by mutableStateOf(false); private set
    var remoteBusy by mutableStateOf(false); private set
    var remoteFrame by mutableStateOf<ImageBitmap?>(null); private set
    var remoteNote by mutableStateOf<String?>(null)
    var pairing by mutableStateOf<WindowsPairing?>(null); private set
    private var frame: WindowsFrameReply? = null
    private var remoteScreenShown = false
    private var renewJob: Job? = null
    private var frameJob: Job? = null
    private var pairingJob: Job? = null
    private val grantChange = Mutex()
    private var stopQueued = false

    init {
        viewModelScope.launch {
            try {
                SessionVault.forgetLegacyPairing(app)
                prefs.edit().remove("wasla.server.identity").remove("wasla.pending.image").remove("wasla.last.image").apply()
                val cookie = SessionVault.read(app)
                if (cookie == null) {
                    persistPending(null)
                    account = Account.SIGNED_OUT
                    return@launch
                }
                beginSession(cookie, null)
                restorePendingMohassan()
                refreshAccount()
            } catch (error: Exception) {
                account = Account.SIGNED_OUT
                show(error)
            }
        }
    }

    fun signIn(email: String, password: String) {
        val address = email.trim()
        if (account != Account.SIGNED_OUT || signingIn || address.isEmpty() || password.isEmpty()) return
        errorMessage = null
        signingIn = true
        viewModelScope.launch {
            try {
                val (cookie, reply) = CloudClient().signIn(address, password)
                vault.withLock { SessionVault.save(app, cookie) }
                beginSession(cookie, reply.user?.email ?: address)
                refreshAccount()
            } catch (error: Exception) {
                show(error)
            } finally {
                signingIn = false
            }
        }
    }

    private fun beginSession(cookie: SessionCookie, address: String?) {
        val epoch = ++sessionEpoch
        client = CloudClient(cookie, onSignedOut = {
            if (epoch == sessionEpoch) {
                endSession()
                errorMessage = WaslaException.signedOut().message
            }
        })
        email = address
        account = Account.SIGNED_IN
    }

    private suspend fun refreshAccount() {
        val epoch = sessionEpoch
        refreshMohassanList()
        if (epoch != sessionEpoch) return
        resumePendingMohassan()
        loadWindows()
        checkMohassanImages()
    }

    fun signOut() {
        val old = client ?: return
        endSession()
        viewModelScope.launch {
            try {
                old.request(CloudRequest("/api/auth/sign-out", "POST", encode(EmptyBody()), timeoutSeconds = 15))
            } catch (error: WaslaException) {
                if (!signedIn && error.kind != WaslaException.Kind.SIGNED_OUT) show(error)
            }
        }
    }

    private fun endSession() {
        sessionEpoch += 1
        client = null
        email = null
        // Queue the erase before a subsequent sign-in can save a new session.
        viewModelScope.launch(start = CoroutineStart.UNDISPATCHED) {
            vault.withLock { SessionVault.delete(app) }
        }
        resetMohassan()
        stopRemoteTasks()
        pairingJob?.cancel()
        pairingJob = null
        pairing = null
        windows = null
        remoteDeviceId = null
        remoteWanted = false
        remoteBusy = false
        stopQueued = false
        remoteScreenShown = false
        remoteNote = null
        windowsProblem = null
        account = Account.SIGNED_OUT
    }

    fun sceneChanged(active: Boolean) {
        foreground = active
        if (!signedIn) return
        mohassanSceneChanged(active)
        if (active) {
            if (remoteWanted) keepRemoteGrant(immediate = true) else loadWindows()
            startFrames()
            if (pairing != null) watchPairing()
        } else {
            stopRemoteTasks()
            pairingJob?.cancel()
            pairingJob = null
        }
    }

    internal fun show(error: Exception) {
        if (error is CancellationException) throw error
        if (error is WaslaException && error.kind == WaslaException.Kind.SIGNED_OUT) return
        errorMessage = (error as? WaslaException)?.message ?: "تعذّر إكمال الطلب."
    }

    fun loadWindows() {
        viewModelScope.launch { refreshWindows() }
    }

    private suspend fun refreshWindows(): Boolean {
        val client = client ?: return false
        val epoch = sessionEpoch
        return try {
            val overview: WindowsOverview = client.get("/api/windows", timeoutSeconds = 15)
            if (epoch != sessionEpoch) return false
            windows = overview
            windowsProblem = null
            remoteDeviceId = RemoteReadiness.device(overview, remoteDeviceId)?.id
            if (overview.devices.any { !it.revoked && it.online }) pairing = null
            true
        } catch (error: WaslaException) {
            if (epoch != sessionEpoch) return false
            if (error.status == 403 || error.status == 404) windows = null
            windowsProblem = error.message
            false
        }
    }

    fun setRemote(on: Boolean) {
        if (remoteBusy || !signedIn) return
        val epoch = sessionEpoch
        remoteBusy = true
        remoteNote = null
        if (!on) {
            remoteWanted = false
            stopFrames()
        }
        viewModelScope.launch {
            try {
                grantChange.withLock {
                    if (epoch != sessionEpoch) return@withLock
                    if (on) enableRemote(epoch) else disableRemote(epoch)
                }
            } catch (error: WaslaException) {
                if (epoch == sessionEpoch) remoteNote = error.message
            } finally {
                if (epoch == sessionEpoch && !stopQueued) remoteBusy = false
            }
        }
    }

    private suspend fun enableRemote(epoch: Int) {
        val client = client ?: return
        if (!refreshWindows() || epoch != sessionEpoch) return
        val readiness = remote ?: return
        val device = when (readiness) {
            is RemoteReadiness.Active -> readiness.device
            is RemoteReadiness.Ready -> readiness.device
            else -> {
                remoteNote = listOf(readiness.title, readiness.advice).filter(String::isNotBlank).joinToString(". ")
                return
            }
        }
        requestGrant(client, device, control = true)
        if (epoch != sessionEpoch || stopQueued) return
        remoteWanted = true
        keepRemoteGrant()
        startFrames()
        refreshWindows()
    }

    private suspend fun disableRemote(epoch: Int) {
        val client = client ?: return
        // A renewal already in flight must finish before the replacement grant is sent.
        renewJob?.cancel()
        renewJob = null
        if (!refreshWindows()) {
            if (epoch == sessionEpoch) remoteNote = "تعذّر إلغاء التحكم الآن. ينتهي الإذن خلال دقيقتين، أو استخدم «إيقاف كامل»."
            return
        }
        if (epoch != sessionEpoch || stopQueued) return
        val active = remote as? RemoteReadiness.Active ?: return
        try {
            requestGrant(client, active.device, control = false)
            if (epoch == sessionEpoch) remoteNote = "أُلغي التحكم. تنتهي المشاهدة أيضًا خلال ٣٠ ثانية."
        } catch (error: WaslaException) {
            if (epoch == sessionEpoch) remoteNote = "تعذّر إلغاء التحكم الآن. ينتهي الإذن خلال دقيقتين، أو استخدم «إيقاف كامل»."
        }
        if (epoch == sessionEpoch) refreshWindows()
    }

    fun stopRemoteCompletely() {
        val client = client ?: return
        val id = remoteDeviceId?.takeIf(::isUuid) ?: return
        if (stopQueued) return
        val epoch = sessionEpoch
        stopQueued = true
        remoteWanted = false
        remoteBusy = true
        stopFrames()
        viewModelScope.launch {
            try {
                grantChange.withLock {
                    if (epoch != sessionEpoch) return@withLock
                    renewJob?.cancel()
                    renewJob = null
                    client.post<EmptyBody, OkReply>("/api/windows/devices/$id/stop", EmptyBody(), timeoutSeconds = 15)
                    if (epoch == sessionEpoch) {
                        remoteNote = "أُوقف التحكم والمشاهدة. يلزم إذن محلي جديد من Mohassan Companion."
                        refreshWindows()
                    }
                }
            } catch (error: WaslaException) {
                if (epoch == sessionEpoch) show(error)
            } finally {
                if (epoch == sessionEpoch) {
                    stopQueued = false
                    remoteBusy = false
                }
            }
        }
    }

    fun pairWindows() {
        val client = client ?: return
        if (remoteBusy) return
        val epoch = sessionEpoch
        remoteBusy = true
        viewModelScope.launch {
            try {
                val code: WindowsPairing = client.post("/api/windows/pairing", EmptyBody(), timeoutSeconds = 15)
                if (epoch != sessionEpoch) return@launch
                pairing = code
                watchPairing()
            } catch (error: WaslaException) {
                if (epoch == sessionEpoch) show(error)
            } finally {
                if (epoch == sessionEpoch && !stopQueued) remoteBusy = false
            }
        }
    }

    private fun watchPairing() {
        pairingJob?.cancel()
        if (!foreground) return
        val epoch = sessionEpoch
        pairingJob = viewModelScope.launch {
            while (isActive && epoch == sessionEpoch) {
                val code = pairing ?: return@launch
                delay(3_000)
                if (parseWindowsTime(code.expiresAt)?.isBefore(Instant.now()) == true) {
                    pairing = null
                    return@launch
                }
                refreshWindows()
            }
        }
    }

    private suspend fun requestGrant(client: CloudClient, device: WindowsDevice, control: Boolean): WindowsGrant {
        val body = device.state?.let { RemoteTiming.request(it, control) }
        if (!isUuid(device.id) || body == null) {
            throw WaslaException.message("اختر نافذة واسمح بها في Mohassan Companion على الكمبيوتر أولًا.")
        }
        return client.post("/api/windows/devices/${device.id}/grants", body, timeoutSeconds = 15)
    }

    private fun keepRemoteGrant(immediate: Boolean = false) {
        if (!remoteWanted || !foreground || renewJob?.isActive == true) return
        val epoch = sessionEpoch
        renewJob = viewModelScope.launch {
            var checkNow = immediate
            while (isActive && remoteWanted && epoch == sessionEpoch) {
                if (!checkNow) delay(RemoteTiming.RENEW_EVERY_MS)
                checkNow = false
                grantChange.withLock {
                    val client = client ?: return@launch
                    if (!remoteWanted || !foreground || epoch != sessionEpoch) return@launch
                    if (!refreshWindows()) return@withLock
                    if (!remoteWanted || !foreground || epoch != sessionEpoch) return@launch
                    val readiness = remote
                    val device = when (readiness) {
                        is RemoteReadiness.Active -> {
                            if (!RemoteTiming.shouldRenew(readiness.grant, Instant.now())) return@withLock
                            readiness.device
                        }
                        is RemoteReadiness.Ready -> readiness.device
                        else -> {
                            remoteWanted = false
                            remoteNote = readiness?.title
                            stopFrames()
                            return@launch
                        }
                    }
                    try {
                        // Hold grantChange through this write even if the screen goes to background.
                        withContext(NonCancellable) { requestGrant(client, device, control = true) }
                    } catch (error: WaslaException) {
                        if (epoch == sessionEpoch) remoteNote = error.message
                    }
                }
            }
        }
    }

    fun remoteScreenOpened() {
        remoteScreenShown = true
        startFrames()
    }

    fun remoteScreenClosed() {
        remoteScreenShown = false
        stopFrames()
    }

    private fun startFrames() {
        val client = client ?: return
        val id = remoteDeviceId?.takeIf(::isUuid) ?: return
        if (!remoteScreenShown || !remoteWanted || !foreground || frameJob?.isActive == true) return
        val epoch = sessionEpoch
        frameJob = viewModelScope.launch {
            var misses = 0
            while (isActive && epoch == sessionEpoch) {
                try {
                    val reply: WindowsFrameReply = client.get("/api/windows/devices/$id/frame", timeoutSeconds = 10)
                    val image = withContext(Dispatchers.Default) {
                        reply.frame.imageData()?.let { BitmapFactory.decodeByteArray(it, 0, it.size)?.asImageBitmap() }
                    } ?: throw WaslaException.invalidResponse()
                    if (epoch != sessionEpoch) return@launch
                    frame = reply
                    remoteFrame = image
                    misses = 0
                } catch (error: WaslaException) {
                    if (epoch != sessionEpoch) return@launch
                    misses += 1
                    if (misses >= 3) {
                        frame = null
                        remoteFrame = null
                        remoteNote = "لا تصل صورة حديثة من الكمبيوتر الآن."
                    }
                }
                delay(RemoteTiming.FRAME_EVERY_MS)
            }
        }
    }

    fun remoteAct(action: WindowsAction) {
        val client = client ?: return
        val id = remoteDeviceId?.takeIf(::isUuid) ?: return
        val frame = frame
        val epoch = sessionEpoch
        if (!remoteWanted || !remoteScreenShown || !foreground || frame?.grant?.controls != true) {
            remoteNote = "انتظر صورة حديثة من الكمبيوتر قبل الإدخال."
            return
        }
        if (action.text?.let { !WindowsAction.textFits(it) } == true) {
            remoteNote = "النص من حرف إلى ١٢٠ حرفًا، دون أسطر جديدة."
            return
        }
        viewModelScope.launch {
            if (epoch != sessionEpoch || !remoteWanted || !remoteScreenShown || !foreground) return@launch
            try {
                val body = WindowsActionRequest(frame.grant.id, newRequestId(), frame.frame.id, action)
                client.post<WindowsActionRequest, WindowsActionReply>("/api/windows/devices/$id/actions", body, timeoutSeconds = 10)
            } catch (error: WaslaException) {
                if (epoch == sessionEpoch) remoteNote = error.message
            }
        }
    }

    private fun stopFrames() {
        frameJob?.cancel()
        frameJob = null
        frame = null
        remoteFrame = null
    }

    private fun stopRemoteTasks() {
        renewJob?.cancel()
        renewJob = null
        stopFrames()
    }

}
