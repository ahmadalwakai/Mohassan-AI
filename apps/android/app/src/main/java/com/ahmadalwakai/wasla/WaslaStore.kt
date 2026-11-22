package com.ahmadalwakai.wasla

import android.app.Application
import android.content.Context
import android.graphics.BitmapFactory
import android.os.Build
import android.provider.Settings
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.encodeToString

/**
 * The phone's state and every call to the computer, as in the iOS app's WaslaStore: pairing,
 * the local fallback chat, images, search and desktop control. Mohassan's chat lives in
 * Mohassan.kt. Each long operation carries the epoch it started in, so a result that arrives
 * after a new chat, a new pairing or a stopped session is dropped instead of shown.
 */
class WaslaStore(application: Application) : AndroidViewModel(application) {
    internal val app: Context = application.applicationContext
    private val prefs = app.getSharedPreferences("wasla", Context.MODE_PRIVATE)
    val bundledIdentity: ServerIdentity? = try {
        app.assets.open("ConnectionDefaults.json").use { BundledConnection.decode(it.readBytes().decodeToString()) }
    } catch (_: Exception) { null }

    var identity by mutableStateOf<ServerIdentity?>(null); private set
    var status by mutableStateOf<ServerStatus?>(null); private set
    var errorMessage by mutableStateOf<String?>(null)
    var isLoading by mutableStateOf(true); private set
    var isPairing by mutableStateOf(false); private set
    var isRefreshing by mutableStateOf(false); private set
    var selectedTab by mutableStateOf(0); private set
    val messages = mutableStateListOf<ChatMessage>()
    var chatBusy by mutableStateOf(false); private set
    /** The composer's text, so a new chat from the toolbar clears it, as on iOS. */
    var chatDraft by mutableStateOf("")
    var chatContextNote by mutableStateOf(""); private set
    var chatMode by mutableStateOf(ChatMode.AUTOMATIC)
    var rememberConversation by mutableStateOf(false)
    var useSavedKnowledge by mutableStateOf(false)
    val chatMetadata = mutableStateMapOf<String, ChatResponse>()
    var imagePreparing by mutableStateOf(false); private set
    var preparedImage by mutableStateOf<PreparedImage?>(null)
    var imageBusy by mutableStateOf(false); private set
    var imageSubmitting by mutableStateOf(false); private set
    var imageStatus by mutableStateOf("صف الصورة، ثم راجع الوصف قبل بدء الإنشاء."); private set
    var pendingImageId by mutableStateOf<String?>(null); private set
    var lastImage by mutableStateOf<ImageBitmap?>(null); private set
    var lastImageBytes: ByteArray? = null; private set
    var searchBusy by mutableStateOf(false); private set
    var searchResponse by mutableStateOf<SearchResponse?>(null); private set
    var desktopStarting by mutableStateOf(false); private set
    var desktopSession by mutableStateOf<DesktopSession?>(null); private set
    var desktopFrame by mutableStateOf<ImageBitmap?>(null); private set
    var frameTime by mutableStateOf<Long?>(null); private set
    var pointer by mutableStateOf(Offset(0.5f, 0.5f)); private set
    var desktopMessage by mutableStateOf("ابدأ جلسة لعرض الشاشة والتحكم بها."); private set
    var foreground by mutableStateOf(true); private set

    // Mohassan, through the computer service. Logic lives in Mohassan.kt.
    var mohassanLink by mutableStateOf<MohassanLink?>(null); internal set
    val mohassanList = mutableStateListOf<MohassanSummary>()
    var mohassanConversation by mutableStateOf<MohassanConversation?>(null); internal set
    var mohassanSending by mutableStateOf(false); internal set
    var mohassanPendingText by mutableStateOf<String?>(null); internal set
    var mohassanDraft by mutableStateOf("")
    internal var mohassanPollJob: Job? = null
    internal var mohassanPollId = 0
    internal var mohassanEpoch = 0

    internal var client: ApiClient? = null; private set
    private var frameJob: Job? = null
    private var inputJob: Job? = null
    private var imageJob: Job? = null
    private var chatJob: Job? = null
    private val inputQueue = ArrayDeque<DesktopCommand>()
    private var desktopEpoch = 0
    internal var sessionEpoch = 0; private set
    private var chatEpoch = 0
    private var chatConversationId: String? = null

    val paired: Boolean get() = identity != null && client != null
    val connected: Boolean get() = paired && status != null
    val computerBusy: Boolean get() = chatBusy || imagePreparing || imageBusy || imageSubmitting || mohassanBusy || status?.busyState?.isBusy == true

    init {
        viewModelScope.launch { start() }
    }

    private suspend fun start() {
        try {
            val saved = prefs.getString(IDENTITY_KEY, null)?.let { runCatching { WaslaJson.decodeFromString(ServerIdentity.serializer(), it) }.getOrNull() } ?: return
            val checked = ServerIdentity.validate(saved.baseUrl, saved.fingerprint, saved.deviceId, saved.name)
            val token = TokenVault.read(app) ?: return
            if (!validToken(token)) return
            identity = checked
            client = ApiClient(checked, token)
            prefs.getString(PENDING_KEY, null)?.takeIf { isUuid(it) }?.let {
                pendingImageId = it
                imageStatus = "يوجد طلب سابق. استعد حالته دون إعادة إرساله."
            }
            refreshStatus()
            if (pendingImageId != null) {
                resumeImage()
            } else {
                val id = prefs.getString(LAST_IMAGE_KEY, null)?.takeIf { isUuid(it) }
                val current = client
                if (id != null && current != null) {
                    try { setLastImage(loadImage(id, current)) } catch (error: Exception) {
                        if (error is CancellationException) throw error
                        imageStatus = "تعذّر تحميل الصورة السابقة. يمكنك إنشاء طلب جديد."
                    }
                }
            }
        } catch (error: Exception) {
            if (error is CancellationException) throw error
            show(error)
        } finally {
            isLoading = false
        }
    }

    fun selectTab(tab: Int) {
        if (tab == selectedTab) return
        selectedTab = tab
        if (tab != 0 && (desktopSession != null || desktopStarting)) stopDesktop()
    }

    fun pair(address: String, fingerprint: String, code: String) {
        if (isPairing) return
        isPairing = true
        viewModelScope.launch {
            try {
                val checked = ServerIdentity.validate(address, fingerprint)
                val pairingCode = PairingCode.normalized(code)
                if (!PairingCode.isValid(pairingCode)) throw WaslaException.invalidPairingCode()
                val deviceName = deviceName()
                val pairing = ApiClient(checked)
                val response: PairResponse = pairing.post("/v1/pair", PairRequest(pairingCode, deviceName))
                if (!validToken(response.token)) throw WaslaException.invalidResponse()
                val saved = ServerIdentity(checked.baseUrl, checked.fingerprint, response.device_id, response.name)
                val authenticated = ApiClient(saved, response.token)
                try { TokenVault.save(app, response.token) } catch (error: Exception) {
                    runCatching { authenticated.delete("/v1/session") }
                    throw error
                }
                prefs.edit().putString(IDENTITY_KEY, WaslaJson.encodeToString(saved)).apply()
                identity = saved
                client = authenticated
                refreshStatus()
            } catch (error: Exception) {
                if (error is CancellationException) throw error
                show(error)
            } finally {
                isPairing = false
            }
        }
    }

    private fun deviceName(): String {
        val fromSettings = try { Settings.Global.getString(app.contentResolver, Settings.Global.DEVICE_NAME) } catch (_: Exception) { null }
        val name = (fromSettings ?: Build.MODEL ?: "").trim().take(60)
        return name.ifEmpty { "Android" }
    }

    suspend fun refreshStatus() {
        val client = client ?: return
        if (isRefreshing) return
        val epoch = sessionEpoch
        isRefreshing = true
        try {
            val fresh: ServerStatus = client.get("/v1/status", timeoutSeconds = 20)
            if (epoch != sessionEpoch) return
            status = fresh
            refreshMohassanLink()
        } catch (error: Exception) {
            if (error is CancellationException) throw error
            if (epoch != sessionEpoch) return
            status = null
            show(error)
        } finally {
            isRefreshing = false
        }
    }

    fun refreshStatusLater() {
        viewModelScope.launch { refreshStatus() }
    }

    fun revokePairing() {
        val client = client ?: return
        stopDesktop()
        viewModelScope.launch {
            try {
                client.delete("/v1/session")
                clearPairing()
            } catch (error: Exception) {
                if (error is CancellationException) throw error
                show(error)
            }
        }
    }

    fun forgetPairing() {
        viewModelScope.launch {
            try { clearPairing() } catch (error: Exception) {
                if (error is CancellationException) throw error
                show(error)
            }
        }
    }

    private suspend fun clearPairing() {
        stopDesktop()
        chatJob?.cancel(); imageJob?.cancel()
        sessionEpoch += 1
        TokenVault.delete(app)
        prefs.edit().remove(IDENTITY_KEY).remove(PENDING_KEY).remove(LAST_IMAGE_KEY).apply()
        client = null; identity = null; status = null
        messages.clear(); chatContextNote = ""; chatDraft = ""; pendingImageId = null; lastImage = null; lastImageBytes = null; preparedImage = null; searchResponse = null
        chatMetadata.clear(); chatConversationId = null; chatEpoch += 1
        rememberConversation = false; useSavedKnowledge = false; chatMode = ChatMode.AUTOMATIC
        imageBusy = false; imageSubmitting = false; imagePreparing = false; chatBusy = false; selectedTab = 0
        resetMohassan()
    }

    fun newChat() {
        chatEpoch += 1
        chatJob?.cancel(); chatJob = null
        messages.clear(); chatMetadata.clear(); chatConversationId = null; chatContextNote = ""; chatBusy = false; chatDraft = ""
        rememberConversation = false; useSavedKnowledge = false; chatMode = ChatMode.AUTOMATIC
    }

    /** The local fallback chat: one question, one answer, within the computer's limits. */
    fun sendChat(text: String): Boolean {
        val client = client ?: run { show(WaslaException.notPaired()); return false }
        if (computerBusy) { errorMessage = "المساعد مشغول حاليًا. انتظر انتهاء المهمة قبل إرسال رسالة أخرى."; return false }
        val clean = text.trim()
        if (clean.isEmpty()) return false
        if (clean.codePoints() > 8_000) { errorMessage = "الرسالة تتجاوز ٨٬٠٠٠ حرف. اختصرها قبل الإرسال."; return false }
        messages.add(ChatMessage("user", clean))
        // Python counts Unicode code points; so does codePoints(). Trim only old context; keep the new message.
        val history = ArrayDeque(messages.toList())
        while (history.size > 1 && (history.size > 16 || history.sumOf { it.content.codePoints() } > 24_000 || history.any { it.content.codePoints() > 8_000 })) history.removeFirst()
        chatContextNote = if (history.size < messages.size) "أُرسل أحدث جزء من المحادثة ضمن حدود النموذج: ${history.size} رسالة." else ""
        val request = ChatRequest(history.toList(), newRequestId(), chatMode.wire, rememberConversation, useSavedKnowledge, if (rememberConversation) chatConversationId else null)
        val epoch = sessionEpoch
        val conversationEpoch = chatEpoch
        chatBusy = true
        chatJob = viewModelScope.launch {
            try {
                val answer: ChatResponse = client.post("/v1/chat", request, timeoutSeconds = 210)
                if (!isActive || epoch != sessionEpoch || conversationEpoch != chatEpoch) return@launch
                val reply = ChatMessage("assistant", answer.content)
                chatMetadata[reply.id] = answer
                messages.add(reply)
                chatConversationId = if (answer.memory_saved == true) answer.conversation_id else null
                refreshStatus()
            } catch (error: Exception) {
                if (error is CancellationException) throw error
                if (epoch == sessionEpoch && conversationEpoch == chatEpoch) show(error)
            } finally {
                if (epoch == sessionEpoch && conversationEpoch == chatEpoch) { chatBusy = false; chatJob = null }
            }
        }
        return true
    }

    fun prepareImage(description: String, style: String) {
        val client = client ?: return
        if (computerBusy || pendingImageId != null) return
        val clean = description.trim()
        if (clean.isEmpty()) return
        imagePreparing = true
        val epoch = sessionEpoch
        viewModelScope.launch {
            try {
                val prepared: PreparedImage = client.post("/v1/images/prepare", ImagePreparation(clean, style), timeoutSeconds = 210)
                if (epoch == sessionEpoch) preparedImage = prepared
            } catch (error: Exception) {
                if (error is CancellationException) throw error
                if (epoch == sessionEpoch) show(error)
            } finally {
                imagePreparing = false
            }
        }
    }

    fun generateImage(prepared: PreparedImage) {
        val client = client ?: return
        if (imageBusy || pendingImageId != null) return
        preparedImage = null
        val id = newRequestId()
        val request = ImageRequest(prepared.prompt, prepared.negative_prompt, prepared.seed, id)
        pendingImageId = id
        prefs.edit().putString(PENDING_KEY, id).apply()
        imageBusy = true
        imageSubmitting = true
        imageStatus = "جارٍ إرسال الطلب…"
        val epoch = sessionEpoch
        viewModelScope.launch {
            try {
                val accepted: ImageJob = client.post("/v1/images", request)
                if (epoch != sessionEpoch) return@launch
                if (accepted.status.isEmpty()) throw WaslaException.invalidResponse()
                imageSubmitting = false
                resumeImage()
            } catch (error: Exception) {
                if (error is CancellationException) throw error
                if (epoch != sessionEpoch) return@launch
                imageSubmitting = false
                imageBusy = false
                // A lost response is not proof that generation never started. Do not POST again.
                imageStatus = "لم يتأكد استلام الطلب. تحقّق من حالته؛ لن يُعاد إرساله تلقائيًا."
                show(error)
            }
        }
    }

    /** Follows the computer's image job every two seconds, in the foreground only; never re-sends it. */
    fun resumeImage() {
        val client = client ?: return
        val id = pendingImageId ?: return
        if (imageSubmitting || !isUuid(id) || !foreground) return
        imageJob?.cancel()
        imageBusy = true
        val epoch = sessionEpoch
        imageJob = viewModelScope.launch {
            try {
                while (isActive) {
                    val job: ImageJob = client.get("/v1/images/$id")
                    if (!isActive || epoch != sessionEpoch) return@launch
                    when (job.status) {
                        "queued" -> imageStatus = "الطلب في الانتظار."
                        "running" -> imageStatus = "الجهاز ينشئ الصورة. ستعود المحادثة بعد اكتمالها."
                        "completed" -> {
                            val image = loadImage(id, client)
                            if (!isActive || epoch != sessionEpoch) return@launch
                            setLastImage(image)
                            prefs.edit().putString(LAST_IMAGE_KEY, id).apply()
                            finishImage("اكتمل إنشاء الصورة على الكمبيوتر.")
                            refreshStatus()
                            return@launch
                        }
                        "failed" -> {
                            finishImage("فشل الطلب. لم تتم إعادة المحاولة تلقائيًا.")
                            errorMessage = job.error ?: "تعذّر إنشاء الصورة."
                            refreshStatus()
                            return@launch
                        }
                        else -> throw WaslaException.invalidResponse()
                    }
                    delay(2_000)
                }
            } catch (error: Exception) {
                if (error is CancellationException) throw error
                if (epoch != sessionEpoch) return@launch
                imageBusy = false
                if (error is WaslaException && error.isServer404) {
                    finishImage("الكمبيوتر لا يعرف هذا الطلب. لم نُعِد إرساله. يمكنك إنشاء طلب جديد.")
                } else {
                    imageStatus = "توقفت متابعة الطلب. تحقّق من حالته عند عودة الاتصال."
                    show(error)
                }
            }
        }
    }

    private fun finishImage(message: String) {
        imageBusy = false; pendingImageId = null; imageStatus = message
        prefs.edit().remove(PENDING_KEY).apply()
    }

    private suspend fun loadImage(id: String, client: ApiClient): Pair<ImageBitmap, ByteArray> {
        if (!isUuid(id)) throw WaslaException.invalidResponse()
        val bytes = client.data("/v1/images/$id/content")
        val image = decodeImage(bytes) ?: throw WaslaException.invalidResponse()
        return image to bytes
    }

    private fun setLastImage(loaded: Pair<ImageBitmap, ByteArray>) {
        lastImage = loaded.first
        lastImageBytes = loaded.second
    }

    fun search(text: String) {
        val client = client ?: return
        if (searchBusy) return
        val query = text.trim()
        if (query.isEmpty()) return
        val epoch = sessionEpoch
        searchBusy = true
        viewModelScope.launch {
            try {
                val result: SearchResponse = client.post("/v1/search", SearchRequest(query))
                if (epoch == sessionEpoch) searchResponse = result
            } catch (error: Exception) {
                if (error is CancellationException) throw error
                if (epoch == sessionEpoch) show(error)
            } finally {
                searchBusy = false
            }
        }
    }

    fun startDesktop() {
        val client = client ?: return
        if (!foreground || desktopStarting || desktopSession != null) return
        if (status?.desktop_enabled != true) { errorMessage = "فعّل التحكم بسطح المكتب من الكمبيوتر أولًا."; return }
        desktopStarting = true
        desktopEpoch += 1
        val epoch = desktopEpoch
        viewModelScope.launch {
            try {
                val opened: DesktopSession = client.post("/v1/desktop/session", EmptyBody(), timeoutSeconds = 10)
                if (!foreground || epoch != desktopEpoch) { runCatching { client.delete("/v1/desktop/session", opened.session_id) }; return@launch }
                // Synchronize the real pointer before controls can be displayed or clicked.
                try {
                    client.send("/v1/desktop/input", DesktopCommand("move", x = pointer.x.toDouble(), y = pointer.y.toDouble()), desktopSession = opened.session_id, timeoutSeconds = 10)
                } catch (error: Exception) {
                    runCatching { client.delete("/v1/desktop/session", opened.session_id) }
                    throw error
                }
                if (!foreground || epoch != desktopEpoch) { runCatching { client.delete("/v1/desktop/session", opened.session_id) }; return@launch }
                desktopSession = opened
                desktopMessage = "جارٍ تحميل الشاشة…"
                frameJob = viewModelScope.launch {
                    var busyRetries = 0
                    try {
                        while (isActive && foreground && epoch == desktopEpoch) {
                            if (System.currentTimeMillis() / 1000.0 >= opened.expires_at) throw WaslaException.message("انتهت جلسة التحكم. ابدأ جلسة جديدة عند الحاجة.")
                            val bytes: ByteArray
                            try {
                                bytes = client.data("/v1/desktop/frame", desktopSession = opened.session_id, timeoutSeconds = 10)
                                busyRetries = 0
                            } catch (failure: WaslaException) {
                                if (failure.kind == WaslaException.Kind.SERVER && failure.status == 429 && busyRetries < 12) {
                                    busyRetries += 1
                                    desktopMessage = "عرض الشاشة ينتظر اكتمال الإدخال…"
                                    delay(minOf(2_000L, busyRetries * 250L))
                                    continue
                                }
                                throw failure
                            }
                            if (!isActive || epoch != desktopEpoch) return@launch
                            val image = decodeImage(bytes) ?: throw WaslaException.invalidResponse()
                            desktopFrame = image
                            frameTime = System.currentTimeMillis()
                            desktopMessage = "جلسة تحكم نشطة"
                            delay(500)
                        }
                    } catch (error: Exception) {
                        if (error is CancellationException) throw error
                        if (epoch != desktopEpoch) return@launch
                        stopDesktop()
                        desktopMessage = "توقف عرض الشاشة."
                        show(error)
                    }
                }
            } catch (error: Exception) {
                if (error is CancellationException) throw error
                if (epoch == desktopEpoch) show(error)
            } finally {
                desktopStarting = false
            }
        }
    }

    fun stopDesktop() {
        desktopEpoch += 1
        val endingEpoch = desktopEpoch
        frameJob?.cancel(); frameJob = null
        inputJob?.cancel(); inputJob = null
        inputQueue.clear()
        val oldSession = desktopSession
        val client = client
        desktopSession = null; desktopFrame = null; frameTime = null
        desktopMessage = "انتهت جلسة التحكم."
        if (oldSession != null && client != null) {
            viewModelScope.launch {
                try { client.delete("/v1/desktop/session", oldSession.session_id) } catch (error: Exception) {
                    if (error is CancellationException) throw error
                    if (endingEpoch == desktopEpoch && desktopSession == null) {
                        desktopMessage = "توقف التحكم على الهاتف؛ لم يتأكد إنهاء الجلسة على الكمبيوتر. تنتهي الجلسة تلقائيًا."
                    }
                }
            }
        }
    }

    fun movePointer(dx: Float, dy: Float) {
        pointer = Offset((pointer.x + dx).coerceIn(0f, 1f), (pointer.y + dy).coerceIn(0f, 1f))
        enqueue(DesktopCommand("move", x = pointer.x.toDouble(), y = pointer.y.toDouble()))
    }

    /** Sends input in order, at most ten commands a second; consecutive moves collapse into the latest. */
    fun enqueue(command: DesktopCommand) {
        val active = desktopSession ?: return
        val client = client ?: return
        if (!foreground) return
        if (command.action == "move" && inputQueue.lastOrNull()?.action == "move") inputQueue[inputQueue.lastIndex] = command
        else if (inputQueue.size < 30) inputQueue.addLast(command)
        if (inputJob != null) return
        val epoch = desktopEpoch
        inputJob = viewModelScope.launch {
            try {
                while (isActive && foreground && epoch == desktopEpoch && inputQueue.isNotEmpty()) {
                    val item = inputQueue.removeFirst()
                    client.send("/v1/desktop/input", item, desktopSession = active.session_id, timeoutSeconds = 10)
                    delay(100)
                }
            } catch (error: Exception) {
                if (error is CancellationException) throw error
                if (epoch != desktopEpoch) return@launch
                stopDesktop()
                show(error)
            } finally {
                if (epoch == desktopEpoch) inputJob = null
            }
        }
    }

    fun sceneChanged(active: Boolean) {
        foreground = active
        mohassanSceneChanged(active)
        if (!active) {
            if (desktopSession != null || desktopStarting) stopDesktop()
            imageJob?.cancel(); imageJob = null
            if (pendingImageId != null) { imageBusy = false; imageStatus = "سنتابع حالة الطلب عند عودتك؛ لن نعيد إنشاؤه." }
        } else {
            if (client != null) viewModelScope.launch { refreshStatus() }
            if (pendingImageId != null) resumeImage()
        }
    }

    internal fun show(error: Throwable) {
        if (error is CancellationException) return
        errorMessage = error.message?.takeIf { it.isNotBlank() } ?: "تعذّر إكمال الطلب."
    }

    companion object {
        private const val IDENTITY_KEY = "wasla.server.identity"
        private const val PENDING_KEY = "wasla.pending.image"
        private const val LAST_IMAGE_KEY = "wasla.last.image"

        fun validToken(token: String): Boolean =
            token.toByteArray(Charsets.UTF_8).size in 32..4096 && token.none { it.isWhitespace() || it.code < 32 || it.code == 127 }

        suspend fun decodeImage(bytes: ByteArray): ImageBitmap? = withContext(Dispatchers.Default) {
            try { BitmapFactory.decodeByteArray(bytes, 0, bytes.size)?.asImageBitmap() } catch (_: Exception) { null }
        }
    }
}
