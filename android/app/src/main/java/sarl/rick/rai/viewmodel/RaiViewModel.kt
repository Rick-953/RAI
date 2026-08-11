package sarl.rick.rai.viewmodel

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import java.io.IOException
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import sarl.rick.rai.BuildConfig
import sarl.rick.rai.data.AppSettings
import sarl.rick.rai.data.RaiApiClient
import sarl.rick.rai.data.RaiApiException
import sarl.rick.rai.data.SecureSessionStore
import sarl.rick.rai.data.ServerUrl
import sarl.rick.rai.data.SettingsRepository
import sarl.rick.rai.data.ThemeMode
import sarl.rick.rai.model.Attachment
import sarl.rick.rai.model.Capabilities
import sarl.rick.rai.model.ChatMessage
import sarl.rick.rai.model.ChatStreamEvent
import sarl.rick.rai.model.ConversationSummary
import sarl.rick.rai.model.LoginOutcome
import sarl.rick.rai.model.Membership
import sarl.rick.rai.model.ModelOption
import sarl.rick.rai.model.RaiUser
import sarl.rick.rai.model.SendChatRequest
import sarl.rick.rai.model.UploadPayload

enum class AuthStage { Checking, SignedOut, TwoFactor, SignedIn }
enum class MainDestination { Conversations, Settings }

data class RaiUiState(
    val settings: AppSettings = AppSettings(),
    val authStage: AuthStage = AuthStage.Checking,
    val user: RaiUser? = null,
    val capabilities: Capabilities? = null,
    val clientAuthorizationError: String? = null,
    val pendingTwoFactorToken: String = "",
    val pendingTwoFactorMessage: String = "",
    val destination: MainDestination = MainDestination.Conversations,
    val conversations: List<ConversationSummary> = emptyList(),
    val selectedConversationId: String? = null,
    val messages: List<ChatMessage> = emptyList(),
    val models: List<ModelOption> = emptyList(),
    val selectedModel: String = "auto",
    val internetMode: Boolean = true,
    val thinkingMode: Boolean = false,
    val pendingAttachments: List<Attachment> = emptyList(),
    val membership: Membership? = null,
    val isBusy: Boolean = false,
    val isLoadingMessages: Boolean = false,
    val isUploading: Boolean = false,
    val isStreaming: Boolean = false,
    val activeRequestId: String = "",
    val error: String? = null,
    val notice: String? = null
)

class RaiViewModel(application: Application) : AndroidViewModel(application) {
    private val settingsRepository = SettingsRepository(application)
    private val api = RaiApiClient(SecureSessionStore(application))
    private val mutableState = MutableStateFlow(RaiUiState())
    val state: StateFlow<RaiUiState> = mutableState.asStateFlow()

    @Volatile
    private var stopRequested = false

    private var bootstrapped = false

    init {
        viewModelScope.launch {
            settingsRepository.settings.collect { settings ->
                api.configure(settings.serverUrl)
                mutableState.update { it.copy(settings = settings) }
                if (!bootstrapped) {
                    bootstrapped = true
                    bootstrap()
                }
            }
        }
    }

    fun bootstrap() {
        viewModelScope.launch {
            mutableState.update {
                it.copy(authStage = AuthStage.Checking, isBusy = true, error = null, clientAuthorizationError = null)
            }
            val capabilities = runCatching { api.getCapabilities() }.getOrElse { error ->
                val message = if (BuildConfig.RAI_CLIENT_KEY.isBlank()) {
                    "当前 APK 未注入软件客户端凭据"
                } else {
                    error.userMessage("无法验证软件客户端凭据")
                }
                mutableState.update {
                    it.copy(
                        authStage = AuthStage.SignedOut,
                        isBusy = false,
                        clientAuthorizationError = message
                    )
                }
                return@launch
            }
            mutableState.update { it.copy(capabilities = capabilities) }
            if (api.persistedSession() == null) {
                mutableState.update { it.copy(authStage = AuthStage.SignedOut, isBusy = false) }
                return@launch
            }
            runCatching { api.verifyUser() }
                .onSuccess { user ->
                    mutableState.update { it.copy(authStage = AuthStage.SignedIn, user = user, isBusy = false) }
                    refreshWorkspace()
                }
                .onFailure {
                    api.clearSession()
                    mutableState.update { state ->
                        state.copy(authStage = AuthStage.SignedOut, user = null, isBusy = false)
                    }
                }
        }
    }

    fun login(email: String, password: String) {
        if (mutableState.value.clientAuthorizationError != null) return
        viewModelScope.launch {
            mutableState.update { it.copy(isBusy = true, error = null) }
            runCatching { api.login(email.trim(), password) }
                .onSuccess { outcome ->
                    when (outcome) {
                        is LoginOutcome.Authenticated -> {
                            mutableState.update {
                                it.copy(
                                    authStage = AuthStage.SignedIn,
                                    user = outcome.session.user,
                                    isBusy = false,
                                    pendingTwoFactorToken = ""
                                )
                            }
                            refreshWorkspace()
                        }
                        is LoginOutcome.TwoFactorRequired -> mutableState.update {
                            it.copy(
                                authStage = AuthStage.TwoFactor,
                                pendingTwoFactorToken = outcome.token,
                                pendingTwoFactorMessage = outcome.message,
                                isBusy = false
                            )
                        }
                        is LoginOutcome.EmailVerificationRequired -> mutableState.update {
                            it.copy(
                                authStage = AuthStage.SignedOut,
                                isBusy = false,
                                notice = outcome.message.ifBlank { "请先验证 ${outcome.email}" }
                            )
                        }
                    }
                }
                .onFailure { error -> mutableState.update { it.copy(isBusy = false, error = error.userMessage()) } }
        }
    }

    fun completeTwoFactor(code: String) {
        val token = mutableState.value.pendingTwoFactorToken
        if (token.isBlank()) return
        viewModelScope.launch {
            mutableState.update { it.copy(isBusy = true, error = null) }
            runCatching { api.completeTwoFactor(token, code.trim()) }
                .onSuccess { session ->
                    mutableState.update {
                        it.copy(
                            authStage = AuthStage.SignedIn,
                            user = session.user,
                            pendingTwoFactorToken = "",
                            isBusy = false
                        )
                    }
                    refreshWorkspace()
                }
                .onFailure { error -> mutableState.update { it.copy(isBusy = false, error = error.userMessage()) } }
        }
    }

    fun cancelTwoFactor() {
        mutableState.update {
            it.copy(authStage = AuthStage.SignedOut, pendingTwoFactorToken = "", pendingTwoFactorMessage = "", error = null)
        }
    }

    fun logout() {
        viewModelScope.launch {
            stopGeneration()
            api.logout()
            mutableState.update {
                RaiUiState(settings = it.settings, authStage = AuthStage.SignedOut, capabilities = it.capabilities)
            }
        }
    }

    fun setDestination(destination: MainDestination) {
        mutableState.update { it.copy(destination = destination) }
    }

    fun refreshWorkspace() {
        viewModelScope.launch {
            mutableState.update { it.copy(isBusy = true, error = null) }
            val sessionsResult = runCatching { api.getSessions() }
            val modelsResult = runCatching { api.getModels() }
            val membershipResult = runCatching { api.getMembership() }
            val sessions = sessionsResult.getOrDefault(emptyList())
            val selected = mutableState.value.selectedConversationId
                ?.takeIf { id -> sessions.any { it.id == id } }
                ?: sessions.firstOrNull()?.id
            mutableState.update {
                it.copy(
                    conversations = sessions,
                    selectedConversationId = selected,
                    models = modelsResult.getOrDefault(it.models).ifEmpty { it.models },
                    membership = membershipResult.getOrNull() ?: it.membership,
                    isBusy = false,
                    error = sessionsResult.exceptionOrNull()?.userMessage()
                )
            }
            selected?.let { loadMessages(it) }
        }
    }

    fun selectConversation(id: String) {
        if (id == mutableState.value.selectedConversationId && mutableState.value.messages.isNotEmpty()) return
        mutableState.update { it.copy(selectedConversationId = id, destination = MainDestination.Conversations) }
        loadMessages(id)
    }

    fun newConversation() {
        viewModelScope.launch {
            mutableState.update { it.copy(isBusy = true, error = null) }
            runCatching { api.createSession(mutableState.value.selectedModel) }
                .onSuccess { conversation ->
                    mutableState.update {
                        it.copy(
                            conversations = listOf(conversation) + it.conversations,
                            selectedConversationId = conversation.id,
                            messages = emptyList(),
                            isBusy = false,
                            destination = MainDestination.Conversations
                        )
                    }
                }
                .onFailure { error -> mutableState.update { it.copy(isBusy = false, error = error.userMessage()) } }
        }
    }

    fun renameConversation(id: String, title: String) {
        val normalized = title.trim()
        if (normalized.isBlank()) return
        viewModelScope.launch {
            runCatching { api.renameSession(id, normalized) }
                .onSuccess {
                    mutableState.update { state ->
                        state.copy(conversations = state.conversations.map {
                            if (it.id == id) it.copy(title = normalized) else it
                        })
                    }
                }
                .onFailure { error -> setError(error.userMessage()) }
        }
    }

    fun deleteConversation(id: String) {
        viewModelScope.launch {
            runCatching { api.deleteSession(id) }
                .onSuccess {
                    val remaining = mutableState.value.conversations.filterNot { it.id == id }
                    val selected = remaining.firstOrNull()?.id
                    mutableState.update {
                        it.copy(
                            conversations = remaining,
                            selectedConversationId = selected,
                            messages = emptyList()
                        )
                    }
                    selected?.let { loadMessages(it) }
                }
                .onFailure { error -> setError(error.userMessage()) }
        }
    }

    fun togglePinned(conversation: ConversationSummary) {
        viewModelScope.launch {
            runCatching { api.setPinned(conversation.id, !conversation.pinned) }
                .onSuccess { refreshWorkspace() }
                .onFailure { error -> setError(error.userMessage()) }
        }
    }

    fun setModel(model: String) {
        val option = mutableState.value.models.firstOrNull { it.id == model }
        mutableState.update {
            it.copy(
                selectedModel = model,
                thinkingMode = if (option?.supportsThinking == false) false else it.thinkingMode
            )
        }
    }

    fun setInternetMode(enabled: Boolean) {
        mutableState.update { it.copy(internetMode = enabled) }
    }

    fun setThinkingMode(enabled: Boolean) {
        mutableState.update { it.copy(thinkingMode = enabled) }
    }

    fun upload(payload: UploadPayload) {
        viewModelScope.launch {
            mutableState.update { it.copy(isUploading = true, error = null) }
            runCatching { api.upload(payload) }
                .onSuccess { attachment ->
                    mutableState.update {
                        it.copy(isUploading = false, pendingAttachments = it.pendingAttachments + attachment)
                    }
                }
                .onFailure { error -> mutableState.update { it.copy(isUploading = false, error = error.userMessage()) } }
        }
    }

    fun removePendingAttachment(filename: String) {
        mutableState.update { state ->
            state.copy(pendingAttachments = state.pendingAttachments.filterNot { it.filename == filename })
        }
    }

    fun sendMessage(text: String) {
        val initial = mutableState.value
        if (initial.isStreaming || (text.isBlank() && initial.pendingAttachments.isEmpty())) return
        viewModelScope.launch {
            val sessionId = initial.selectedConversationId ?: runCatching {
                api.createSession(initial.selectedModel)
            }.getOrElse { error ->
                setError(error.userMessage())
                return@launch
            }.also { created ->
                mutableState.update {
                    it.copy(
                        conversations = listOf(created) + it.conversations,
                        selectedConversationId = created.id
                    )
                }
            }.id

            val current = mutableState.value
            val userMessage = ChatMessage(
                sessionId = sessionId,
                role = "user",
                content = text.trim(),
                attachments = current.pendingAttachments
            )
            val assistantMessage = ChatMessage(
                sessionId = sessionId,
                role = "assistant",
                content = "",
                isStreaming = true
            )
            val requestMessages = current.messages.filterNot { it.isStreaming } + userMessage
            mutableState.update {
                it.copy(
                    messages = requestMessages + assistantMessage,
                    pendingAttachments = emptyList(),
                    isStreaming = true,
                    activeRequestId = "",
                    error = null
                )
            }
            stopRequested = false
            try {
                api.streamChat(
                    SendChatRequest(
                        sessionId = sessionId,
                        messages = requestMessages,
                        model = current.selectedModel,
                        internetMode = current.internetMode,
                        thinkingMode = current.thinkingMode
                    ),
                    onOpened = { requestId -> mutableState.update { it.copy(activeRequestId = requestId) } },
                    onEvent = ::handleStreamEvent
                )
            } catch (error: Throwable) {
                if (error is CancellationException) throw error
                if (!stopRequested) {
                    updateStreamingMessage { it.copy(isStreaming = false, streamError = error.userMessage()) }
                    mutableState.update { it.copy(isStreaming = false, activeRequestId = "") }
                }
            } finally {
                if (!stopRequested) finishStream(sessionId)
            }
        }
    }

    fun stopGeneration() {
        val requestId = mutableState.value.activeRequestId
        if (!mutableState.value.isStreaming) return
        stopRequested = true
        updateStreamingMessage { it.copy(isStreaming = false) }
        mutableState.update { it.copy(isStreaming = false, activeRequestId = "", notice = "已停止生成") }
        viewModelScope.launch { api.stopChat(requestId) }
    }

    fun saveServerUrl(value: String) {
        val normalized = ServerUrl.normalize(value).getOrElse { error ->
            setError(error.message ?: "服务器地址无效")
            return
        }
        if (normalized == mutableState.value.settings.serverUrl) return
        viewModelScope.launch {
            stopGeneration()
            api.clearSession()
            api.configure(normalized)
            settingsRepository.saveServerUrl(normalized)
            mutableState.update {
                RaiUiState(
                    settings = it.settings.copy(serverUrl = normalized),
                    authStage = AuthStage.Checking
                )
            }
            bootstrap()
        }
    }

    fun saveThemeMode(themeMode: ThemeMode) {
        mutableState.update { it.copy(settings = it.settings.copy(themeMode = themeMode)) }
        viewModelScope.launch { settingsRepository.saveThemeMode(themeMode) }
    }

    fun saveDynamicColor(enabled: Boolean) {
        mutableState.update { it.copy(settings = it.settings.copy(dynamicColor = enabled)) }
        viewModelScope.launch { settingsRepository.saveDynamicColor(enabled) }
    }

    fun clearTransientMessages() {
        mutableState.update { it.copy(error = null, notice = null) }
    }

    fun reportError(message: String) {
        setError(message)
    }

    private fun loadMessages(sessionId: String) {
        viewModelScope.launch {
            mutableState.update { it.copy(isLoadingMessages = true, error = null) }
            runCatching { api.getMessages(sessionId) }
                .onSuccess { messages ->
                    if (mutableState.value.selectedConversationId == sessionId) {
                        mutableState.update { it.copy(messages = messages, isLoadingMessages = false) }
                    }
                }
                .onFailure { error ->
                    mutableState.update { it.copy(isLoadingMessages = false, error = error.userMessage()) }
                }
        }
    }

    private fun handleStreamEvent(event: ChatStreamEvent) {
        when (event) {
            is ChatStreamEvent.Content -> updateStreamingMessage { it.copy(content = it.content + event.delta) }
            is ChatStreamEvent.Reasoning -> updateStreamingMessage { it.copy(reasoning = it.reasoning + event.delta) }
            is ChatStreamEvent.Sources -> updateStreamingMessage {
                it.copy(sources = (it.sources + event.sources).distinctBy { source -> source.url })
            }
            is ChatStreamEvent.Title -> mutableState.update { state ->
                state.copy(conversations = state.conversations.map {
                    if (it.id == state.selectedConversationId) it.copy(title = event.title) else it
                })
            }
            is ChatStreamEvent.ModelInfo -> updateStreamingMessage { it.copy(model = event.model) }
            is ChatStreamEvent.PointsInfo -> event.remaining?.let { remaining ->
                mutableState.update { state ->
                    state.copy(membership = state.membership?.copy(totalPoints = remaining))
                }
            }
            is ChatStreamEvent.Error -> {
                updateStreamingMessage { it.copy(isStreaming = false, streamError = event.message) }
                mutableState.update { it.copy(isStreaming = false) }
            }
            ChatStreamEvent.Cancelled -> {
                stopRequested = true
                updateStreamingMessage { it.copy(isStreaming = false) }
                mutableState.update { it.copy(isStreaming = false, activeRequestId = "") }
            }
            ChatStreamEvent.Done -> mutableState.update { it.copy(isStreaming = false, activeRequestId = "") }
        }
    }

    private fun updateStreamingMessage(transform: (ChatMessage) -> ChatMessage) {
        mutableState.update { state ->
            val index = state.messages.indexOfLast { it.role == "assistant" && it.id == null }
            if (index < 0) state else state.copy(
                messages = state.messages.toMutableList().also { it[index] = transform(it[index]) }
            )
        }
    }

    private fun finishStream(sessionId: String) {
        mutableState.update { it.copy(isStreaming = false, activeRequestId = "") }
        loadMessages(sessionId)
        viewModelScope.launch {
            runCatching { api.getSessions() }.onSuccess { sessions ->
                mutableState.update { it.copy(conversations = sessions) }
            }
            runCatching { api.getMembership() }.onSuccess { membership ->
                mutableState.update { it.copy(membership = membership) }
            }
        }
    }

    private fun setError(message: String) {
        mutableState.update { it.copy(error = message) }
    }
}

private fun Throwable.userMessage(fallback: String = "请求失败，请稍后重试"): String = when (this) {
    is RaiApiException -> message ?: fallback
    is IOException -> "无法连接 RAI 服务器"
    else -> message?.takeIf { it.isNotBlank() } ?: fallback
}
