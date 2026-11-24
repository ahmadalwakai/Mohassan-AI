package com.ahmadalwakai.wasla

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import java.io.IOException
import java.time.Instant
import java.util.UUID

internal data class RemoteScreenFrame(
    val deviceId: String,
    val frameId: String,
    val grantId: String,
    val imageData: ByteArray,
    val receivedAt: Instant,
)

internal data class RemoteControlState(
    val overview: WindowsOverview? = null,
    val deviceId: String? = null,
    val wanted: Boolean = false,
    val busy: Boolean = false,
    val frame: RemoteScreenFrame? = null,
    val problem: String? = null,
    val note: String? = null,
    val pairing: WindowsPairing? = null,
) {
    val device: WindowsDevice?
        get() = overview?.devices?.firstOrNull { it.id == deviceId && !it.revoked }
    val readiness: WindowsReadiness?
        get() = overview?.let { WindowsRemotePolicy.readiness(it, device) }
}

internal class RemoteControlStore(private val api: CloudApi, private val scope: CoroutineScope) {
    private val mutableState = MutableStateFlow(RemoteControlState())
    val state = mutableState.asStateFlow()

    // A grant renewal already in flight must finish before the switch can replace it or STOP can revoke it.
    private val operations = Mutex()
    private val input = Mutex()
    private var epoch = 0
    private var foreground = false
    private var screenOpen = false
    private var renewJob: Job? = null
    private var frameJob: Job? = null
    private var pairingJob: Job? = null

    fun reset() {
        epoch++
        stopTimers()
        pairingJob?.cancel()
        pairingJob = null
        screenOpen = false
        mutableState.value = RemoteControlState()
    }

    fun setForeground(active: Boolean) {
        if (active == foreground) return
        foreground = active
        if (active) {
            if (state.value.wanted) {
                startRenewal(checkImmediately = true)
                startFrames()
            } else if (screenOpen) {
                refresh()
            }
            if (state.value.pairing != null && screenOpen) watchPairing()
        } else {
            stopTimers()
            pairingJob?.cancel()
            pairingJob = null
            mutableState.value = state.value.copy(frame = null)
        }
    }

    fun setScreenOpen(open: Boolean) {
        if (open == screenOpen) return
        screenOpen = open
        if (open) {
            if (foreground) {
                refresh()
                startFrames()
                if (state.value.pairing != null) watchPairing()
            }
        } else {
            frameJob?.cancel()
            frameJob = null
            pairingJob?.cancel()
            pairingJob = null
            mutableState.value = state.value.copy(frame = null)
        }
    }

    fun refresh() {
        val token = epoch
        scope.launch {
            operations.withLock {
                if (epoch == token) loadWindows(token)
            }
        }
    }

    fun setControl(on: Boolean) {
        val current = state.value
        if (current.busy || on == current.wanted) return
        if (!on) stopTimers()
        mutableState.value = current.copy(wanted = false, frame = null)
        runOperation(onError = { error ->
            if (on) error.displayText("تعذّر تفعيل التحكم.")
            else "تعذّر إلغاء إذن التحكم. ينتهي تلقائيًا خلال دقيقتين. يمكنك طلب الإيقاف الكامل الآن."
        }) { token ->
            if (on) turnOn(token) else turnOff(token, current.deviceId)
        }
    }

    fun stop() {
        val current = state.value
        val id = current.deviceId ?: return
        if (current.busy) return
        stopTimers()
        mutableState.value = current.copy(wanted = false, frame = null)
        runOperation(onError = { it.displayText("تعذّر الإيقاف الكامل الآن.") }) { token ->
            api.windowsStop(id)
            if (epoch == token) {
                rememberGrant(id, null)
                mutableState.value = state.value.copy(
                    note = "أُوقف التحكم والمشاهدة. اسمح من جديد في Mohassan Companion على الكمبيوتر.",
                )
                loadWindows(token)
            }
        }
    }

    fun pair() {
        if (state.value.busy) return
        runOperation(onError = { it.displayText("تعذّر إنشاء رمز الربط.") }) { token ->
            val pairing = api.pairWindows()
            if (epoch == token) {
                mutableState.value = state.value.copy(pairing = pairing)
                watchPairing()
            }
        }
    }

    private fun runOperation(onError: (IOException) -> String, run: suspend (Int) -> Unit) {
        mutableState.value = state.value.copy(busy = true, note = null)
        val token = epoch
        scope.launch {
            operations.withLock {
                if (epoch != token) return@withLock
                try {
                    run(token)
                } catch (_: CloudSignedOut) {
                    if (epoch == token) reset()
                } catch (error: IOException) {
                    if (epoch == token) mutableState.value = state.value.copy(note = onError(error))
                } finally {
                    if (epoch == token) mutableState.value = state.value.copy(busy = false)
                }
            }
        }
    }

    fun act(action: WindowsAction, displayedFrame: RemoteScreenFrame) {
        val token = epoch
        scope.launch {
            input.withLock {
                val current = state.value
                if (epoch != token || !current.wanted || !screenOpen || !foreground) return@withLock
                val frame = current.frame
                if (frame == null || frame.deviceId != displayedFrame.deviceId || frame.grantId != displayedFrame.grantId) {
                    mutableState.value = current.copy(note = "انتظر صورة حديثة من الكمبيوتر قبل الإدخال.")
                    return@withLock
                }
                val request = WindowsActionRequest(
                    grantId = displayedFrame.grantId,
                    nonce = UUID.randomUUID().toString(),
                    frameId = displayedFrame.frameId,
                    action = action,
                )
                try {
                    api.windowsAction(displayedFrame.deviceId, request)
                } catch (_: CloudSignedOut) {
                    if (epoch == token) reset()
                } catch (error: IOException) {
                    if (epoch == token) mutableState.value = state.value.copy(
                        note = error.displayText("تعذّر إرسال الإدخال إلى الكمبيوتر."),
                    )
                }
            }
        }
    }

    private suspend fun turnOn(token: Int) {
        val overview = loadWindows(token) ?: return
        val device = state.value.device
        if (!overview.enabled || device == null) return
        val request = WindowsRemotePolicy.grantRequest(device, control = true) ?: return
        val grant = if (WindowsRemotePolicy.renewalDue(device.grant, Instant.now())) {
            api.windowsGrant(device.id, request)
        } else {
            requireNotNull(device.grant)
        }
        if (epoch != token) return
        rememberGrant(device.id, grant)
        mutableState.value = state.value.copy(wanted = true)
        startRenewal(checkImmediately = false)
        startFrames()
    }

    private suspend fun turnOff(token: Int, deviceId: String?) {
        if (deviceId == null) return
        val overview = loadWindows(token)
        if (epoch != token) return
        if (overview == null) throw IOException("Could not verify the current grant")
        if (!overview.enabled) return
        val device = overview.devices.firstOrNull { it.id == deviceId && it.grant?.controls == true } ?: return
        val request = WindowsRemotePolicy.grantRequest(device, control = false)
            ?: throw IOException("The PC cannot replace an active control grant")
        val grant = api.windowsGrant(deviceId, request)
        if (epoch != token) return
        rememberGrant(deviceId, grant)
        mutableState.value = state.value.copy(note = "أُلغي التحكم. ينتهي إذن المشاهدة خلال ٣٠ ثانية.")
    }

    private fun rememberGrant(deviceId: String, grant: WindowsGrant?) {
        val current = state.value
        val overview = current.overview ?: return
        mutableState.value = current.copy(
            overview = overview.copy(devices = overview.devices.map { device ->
                if (device.id == deviceId) device.copy(grant = grant) else device
            }),
            frame = current.frame?.takeIf { it.grantId == grant?.id },
        )
    }

    private suspend fun loadWindows(token: Int): WindowsOverview? {
        try {
            val overview = api.windows()
            if (epoch != token) return null
            val current = state.value
            val deviceId = if (current.wanted) current.deviceId
            else WindowsRemotePolicy.preferredDevice(overview, current.deviceId)?.id
            val pairing = current.pairing?.takeUnless { overview.devices.any { !it.revoked && it.online } }
            mutableState.value = current.copy(overview = overview, deviceId = deviceId, problem = null, pairing = pairing)
            return overview
        } catch (_: CloudSignedOut) {
            if (epoch == token) reset()
        } catch (error: IOException) {
            if (epoch == token) {
                val current = state.value
                val status = (error as? CloudHttpError)?.status
                val forbidden = status == 403 || status == 404
                mutableState.value = current.copy(
                    overview = current.overview.takeUnless { forbidden },
                    problem = error.displayText("تعذّرت قراءة حالة الكمبيوتر."),
                )
            }
        }
        return null
    }

    private fun startRenewal(checkImmediately: Boolean) {
        renewJob?.cancel()
        if (!foreground || !state.value.wanted) return
        val token = epoch
        renewJob = scope.launch {
            if (!checkImmediately) delay(WindowsRemotePolicy.GRANT_CHECK_MILLIS)
            while (isActive && epoch == token && foreground && state.value.wanted) {
                operations.withLock { renewIfNeeded(token) }
                delay(WindowsRemotePolicy.GRANT_CHECK_MILLIS)
            }
        }
    }

    private suspend fun renewIfNeeded(token: Int) {
        if (epoch != token || !foreground || !state.value.wanted) return
        val overview = loadWindows(token)
        if (epoch != token || !foreground || !state.value.wanted) return
        val current = state.value
        if (overview == null && current.overview != null) return
        val device = current.device
        val request = device?.let { WindowsRemotePolicy.grantRequest(it, control = true) }
        if (overview?.enabled != true || device == null || request == null) {
            frameJob?.cancel()
            frameJob = null
            mutableState.value = current.copy(wanted = false, frame = null)
            return
        }
        if (!WindowsRemotePolicy.renewalDue(device.grant, Instant.now())) return
        try {
            val grant = withContext(NonCancellable) { api.windowsGrant(device.id, request) }
            currentCoroutineContext().ensureActive()
            if (epoch == token && state.value.wanted) rememberGrant(device.id, grant)
        } catch (_: CloudSignedOut) {
            if (epoch == token) reset()
        } catch (error: IOException) {
            if (epoch == token && state.value.wanted) mutableState.value = state.value.copy(
                note = error.displayText("تعذّر تجديد إذن التحكم."),
            )
        }
    }

    private fun startFrames() {
        frameJob?.cancel()
        val id = state.value.deviceId ?: return
        if (!screenOpen || !foreground || !state.value.wanted) return
        val token = epoch
        frameJob = scope.launch {
            var misses = 0
            while (isActive && epoch == token && foreground && screenOpen && state.value.wanted) {
                try {
                    val reply = api.windowsFrame(id)
                    if (!isActive || epoch != token || !foreground || !state.value.wanted || !screenOpen) break
                    val current = state.value
                    val frame = current.frame
                    if (reply.grant.controls) {
                        if (frame == null || frame.frameId != reply.frame.id || frame.grantId != reply.grant.id) {
                            val image = reply.frame.imageData ?: throw IOException("Invalid Windows JPEG")
                            mutableState.value = current.copy(
                                frame = RemoteScreenFrame(id, reply.frame.id, reply.grant.id, image, Instant.now()),
                            )
                        }
                        misses = 0
                    } else {
                        mutableState.value = current.copy(frame = null)
                    }
                } catch (_: CloudSignedOut) {
                    if (epoch == token) reset()
                    break
                } catch (_: IOException) {
                    if (++misses == 3 && isActive && epoch == token && foreground && screenOpen && state.value.wanted) {
                        mutableState.value = state.value.copy(
                            frame = null, note = "لا تصل صورة حديثة من الكمبيوتر الآن.",
                        )
                    }
                }
                delay(WindowsRemotePolicy.FRAME_POLL_MILLIS)
            }
        }
    }

    private fun watchPairing() {
        pairingJob?.cancel()
        if (!screenOpen || !foreground) return
        val token = epoch
        pairingJob = scope.launch {
            while (isActive && epoch == token && screenOpen && foreground) {
                delay(3_000)
                operations.withLock {
                    if (epoch != token) return@launch
                    val pairing = state.value.pairing ?: return@launch
                    val valid = runCatching { Instant.parse(pairing.expiresAt).isAfter(Instant.now()) }.getOrDefault(false)
                    if (!valid) {
                        mutableState.value = state.value.copy(pairing = null)
                        return@launch
                    }
                    loadWindows(token)
                }
            }
        }
    }

    private fun stopTimers() {
        renewJob?.cancel()
        renewJob = null
        frameJob?.cancel()
        frameJob = null
    }

    private fun IOException.displayText(fallback: String): String =
        (this as? CloudHttpError)?.message?.takeIf { it.isNotBlank() } ?: fallback
}
