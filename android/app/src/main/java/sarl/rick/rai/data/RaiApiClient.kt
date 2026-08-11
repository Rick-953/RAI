package sarl.rick.rai.data

import java.io.IOException
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import okhttp3.Call
import okhttp3.Headers
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.MultipartBody
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import org.json.JSONArray
import org.json.JSONObject
import sarl.rick.rai.BuildConfig
import sarl.rick.rai.model.Attachment
import sarl.rick.rai.model.Capabilities
import sarl.rick.rai.model.ChatMessage
import sarl.rick.rai.model.ChatSource
import sarl.rick.rai.model.ChatStreamEvent
import sarl.rick.rai.model.ConversationSummary
import sarl.rick.rai.model.LoginOutcome
import sarl.rick.rai.model.LoginSession
import sarl.rick.rai.model.Membership
import sarl.rick.rai.model.ModelOption
import sarl.rick.rai.model.RaiUser
import sarl.rick.rai.model.SendChatRequest
import sarl.rick.rai.model.SessionSecrets
import sarl.rick.rai.model.UploadPayload
import sarl.rick.rai.model.mapTypedObjects
import sarl.rick.rai.model.parseSources
import sarl.rick.rai.model.toAttachment
import sarl.rick.rai.model.toChatMessage
import sarl.rick.rai.model.toConversationSummary
import sarl.rick.rai.model.toModelOption
import sarl.rick.rai.model.toRaiUser

class RaiApiException(
    message: String,
    val statusCode: Int = 0,
    val errorCode: String? = null
) : IOException(message)

private data class RawResponse(
    val code: Int,
    val headers: Headers,
    val body: String
)

class RaiApiClient(private val secureSessionStore: SecureSessionStore) {
    private val http = OkHttpClient.Builder()
        .connectTimeout(20, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .writeTimeout(60, TimeUnit.SECONDS)
        .build()
    private val refreshMutex = Mutex()

    @Volatile
    private var baseUrl: HttpUrl = ServerUrl.Default.toHttpUrl()

    @Volatile
    private var activeStreamCall: Call? = null

    fun configure(serverUrl: String) {
        baseUrl = serverUrl.toHttpUrl()
    }

    suspend fun persistedSession(): SessionSecrets? = withContext(Dispatchers.IO) { secureSessionStore.load() }

    suspend fun clearSession() = withContext(Dispatchers.IO) { secureSessionStore.clear() }

    suspend fun login(email: String, password: String, fingerprint: String = ""): LoginOutcome {
        val payload = JSONObject()
            .put("email", email)
            .put("password", password)
            .put("fingerprint", fingerprint)
        val response = rawJson("POST", "/api/auth/login", payload, authenticated = false)
        val json = decodeJson(response)
        return parseLoginOutcome(response, json)
    }

    suspend fun completeTwoFactor(twoFactorToken: String, code: String, fingerprint: String = ""): LoginSession {
        val response = rawJson(
            method = "POST",
            path = "/api/auth/login/2fa",
            json = JSONObject().put("twoFactorToken", twoFactorToken).put("code", code).put("fingerprint", fingerprint),
            authenticated = false
        )
        return parseAuthenticatedResponse(response, decodeJson(response))
    }

    suspend fun verifyUser(): RaiUser {
        val json = authorizedJson("GET", "/api/auth/verify")
        return (json.optJSONObject("user") ?: json).toRaiUser()
    }

    suspend fun getCapabilities(): Capabilities {
        val response = rawJson("GET", "/api/client/capabilities", null, authenticated = false)
        val json = decodeJson(response)
        val client = json.optJSONObject("client") ?: JSONObject()
        return Capabilities(
            packageVersion = json.optString("packageVersion"),
            keyId = client.optString("keyId"),
            userSessionRequired = json.optBoolean("userSessionRequired", true),
            adminAllowed = json.optBoolean("adminAllowed", false)
        )
    }

    suspend fun logout() {
        runCatching { authorizedJson("POST", "/api/auth/logout", JSONObject()) }
        clearSession()
    }

    suspend fun getSessions(): List<ConversationSummary> {
        val json = authorizedJson("GET", "/api/sessions?offset=0&limit=100")
        val pinned = json.optJSONArray("pinned")?.mapTypedObjects { it.toConversationSummary(true) }.orEmpty()
        val sessions = json.optJSONArray("sessions")?.mapTypedObjects { it.toConversationSummary(false) }.orEmpty()
        return pinned + sessions
    }

    suspend fun createSession(model: String): ConversationSummary {
        val json = authorizedJson(
            "POST",
            "/api/sessions",
            JSONObject().put("title", "新对话").put("model", model).put("prompt_model_identity", promptIdentity(model))
        )
        return ConversationSummary(
            id = json.getString("sessionId"),
            title = "新对话",
            model = model,
            updatedAt = "",
            createdAt = ""
        )
    }

    suspend fun renameSession(id: String, title: String) {
        authorizedJson("PUT", "/api/sessions/$id", JSONObject().put("title", title))
    }

    suspend fun deleteSession(id: String) {
        authorizedJson("DELETE", "/api/sessions/$id")
    }

    suspend fun setPinned(id: String, pinned: Boolean): Boolean {
        val json = authorizedJson("POST", "/api/sessions/$id/pin", JSONObject().put("pinned", pinned))
        return json.optBoolean("pinned", pinned)
    }

    suspend fun getMessages(sessionId: String): List<ChatMessage> {
        val json = authorizedArray("GET", "/api/sessions/$sessionId/messages")
        val messages = json.mapTypedObjects { it.toChatMessage() }
        return coroutineScope {
            messages.map { message ->
                async {
                    if (!message.hasAttachments || message.id == null) return@async message
                    runCatching {
                        val attachmentsJson = authorizedJson("GET", "/api/messages/${message.id}/attachments")
                        val attachments = attachmentsJson.optJSONArray("attachments")
                            ?.mapTypedObjects { it.toAttachment() }
                            .orEmpty()
                        message.copy(attachments = attachments)
                    }.getOrDefault(message)
                }
            }.awaitAll()
        }
    }

    suspend fun getModels(): List<ModelOption> {
        val response = rawJson("GET", "/api/model-availability", null, authenticated = false)
        val json = decodeJson(response)
        return json.optJSONArray("models")?.mapTypedObjects { it.toModelOption() }
            ?.filter { it.enabled }
            ?.ifEmpty { defaultModels }
            ?: defaultModels
    }

    suspend fun getMembership(): Membership {
        val json = authorizedJson("GET", "/api/user/membership")
        return Membership(
            membership = json.optString("membership", "free"),
            totalPoints = json.optInt("totalPoints", json.optInt("points", 0)),
            canCheckin = json.optBoolean("canCheckin")
        )
    }

    suspend fun upload(payload: UploadPayload): Attachment {
        val body = MultipartBody.Builder()
            .setType(MultipartBody.FORM)
            .addFormDataPart(
                "file",
                payload.displayName,
                payload.bytes.toRequestBody(payload.mimeType.toMediaType())
            )
            .build()
        val response = authorizedRaw("POST", "/api/upload", body)
        val json = decodeJson(response)
        return (json.optJSONObject("file") ?: throw RaiApiException("上传响应缺少文件信息")).toAttachment()
    }

    suspend fun streamChat(
        request: SendChatRequest,
        onOpened: (requestId: String) -> Unit,
        onEvent: (ChatStreamEvent) -> Unit
    ) {
        val secrets = requireSession()
        val first = openStream(request, secrets)
        val response = if (first.code == 401) {
            first.close()
            val refreshed = refreshSession() ?: throw RaiApiException("登录已失效", 401)
            openStream(request, refreshed)
        } else first
        try {
            response.use { streamResponse ->
            if (!streamResponse.isSuccessful) throw apiError(streamResponse)
            val requestId = streamResponse.header("X-Request-ID").orEmpty()
            onOpened(requestId)
            val source = streamResponse.body?.source() ?: throw RaiApiException("聊天流缺失")
            val dataLines = mutableListOf<String>()
            fun dispatch() {
                if (dataLines.isEmpty()) return
                val data = dataLines.joinToString("\n")
                dataLines.clear()
                SseEventParser.parse(data)?.let(onEvent)
            }
            while (true) {
                val line = source.readUtf8Line() ?: break
                when {
                    line.isEmpty() -> dispatch()
                    line.startsWith("data:") -> dataLines += line.removePrefix("data:").trimStart()
                }
            }
            dispatch()
            }
        } finally {
            activeStreamCall = null
        }
    }

    suspend fun stopChat(requestId: String) {
        activeStreamCall?.cancel()
        if (requestId.isNotBlank()) {
            runCatching { authorizedJson("POST", "/api/chat/stop", JSONObject().put("requestId", requestId)) }
        }
    }

    private suspend fun openStream(request: SendChatRequest, secrets: SessionSecrets): Response = withContext(Dispatchers.IO) {
        val call = http.newCall(
            requestBuilder("/api/chat/stream", authenticated = true, secrets = secrets)
                .post(request.toJson().toString().toRequestBody(JsonMediaType))
                .build()
        )
        activeStreamCall = call
        call.execute()
    }

    private suspend fun authorizedJson(method: String, path: String, json: JSONObject? = null): JSONObject {
        return decodeJson(authorizedRaw(method, path, json?.toString()?.toRequestBody(JsonMediaType)))
    }

    private suspend fun authorizedArray(method: String, path: String): JSONArray {
        val response = authorizedRaw(method, path, null)
        if (response.code !in 200..299) throw apiError(response)
        return runCatching { JSONArray(response.body) }.getOrElse { throw RaiApiException("响应不是 JSON 数组") }
    }

    private suspend fun authorizedRaw(method: String, path: String, body: RequestBody?): RawResponse {
        val first = rawRequest(method, path, body, requireSession(), authenticated = true)
        if (first.code != 401) return checked(first)
        val refreshed = refreshSession() ?: throw apiError(first)
        return checked(rawRequest(method, path, body, refreshed, authenticated = true))
    }

    private suspend fun rawJson(
        method: String,
        path: String,
        json: JSONObject?,
        authenticated: Boolean
    ): RawResponse {
        val secrets = if (authenticated) requireSession() else null
        return rawRequest(method, path, json?.toString()?.toRequestBody(JsonMediaType), secrets, authenticated)
    }

    private suspend fun rawRequest(
        method: String,
        path: String,
        body: RequestBody?,
        secrets: SessionSecrets?,
        authenticated: Boolean
    ): RawResponse = withContext(Dispatchers.IO) {
        val builder = requestBuilder(path, authenticated, secrets)
        when (method) {
            "GET" -> builder.get()
            "DELETE" -> builder.delete()
            else -> builder.method(method, body ?: ByteArray(0).toRequestBody(null))
        }
        http.newCall(builder.build()).execute().use { response ->
            RawResponse(response.code, response.headers, response.body?.string().orEmpty())
        }
    }

    private fun requestBuilder(path: String, authenticated: Boolean, secrets: SessionSecrets?): Request.Builder {
        val url = baseUrl.resolve(path.removePrefix("/"))
            ?: throw RaiApiException("无效的 API 路径")
        return Request.Builder()
            .url(url)
            .header("Accept", "application/json")
            .header("User-Agent", "RAI-Android/${BuildConfig.VERSION_NAME}")
            .apply {
                BuildConfig.RAI_CLIENT_KEY.takeIf { it.isNotBlank() }?.let { header("X-RAI-Client-Key", it) }
                if (path.substringBefore('?') == "/api/auth/refresh") header("X-RAI-Refresh", "1")
                if (authenticated) {
                    val session = secrets ?: throw RaiApiException("请先登录")
                    header("Authorization", "Bearer ${session.accessToken}")
                    session.refreshCookie.takeIf { it.isNotBlank() }?.let { header("Cookie", it) }
                }
            }
    }

    private suspend fun requireSession(): SessionSecrets =
        persistedSession() ?: throw RaiApiException("登录已失效", 401)

    private suspend fun refreshSession(): SessionSecrets? = refreshMutex.withLock {
        val existing = persistedSession() ?: return@withLock null
        if (existing.refreshCookie.isBlank()) return@withLock null
        val response = rawRequest(
            method = "POST",
            path = "/api/auth/refresh",
            body = ByteArray(0).toRequestBody(null),
            secrets = existing,
            authenticated = true
        )
        if (response.code !in 200..299) {
            clearSession()
            return@withLock null
        }
        val json = decodeJson(response)
        val token = json.optString("token")
        if (token.isBlank()) return@withLock null
        val refreshed = SessionSecrets(
            accessToken = token,
            expiresAt = json.optLong("tokenExpiresAt", 0),
            refreshCookie = extractRefreshCookie(response.headers) ?: existing.refreshCookie
        )
        withContext(Dispatchers.IO) { secureSessionStore.save(refreshed) }
        refreshed
    }

    private fun parseLoginOutcome(response: RawResponse, json: JSONObject): LoginOutcome {
        if (json.optBoolean("requiresTwoFactor")) {
            return LoginOutcome.TwoFactorRequired(json.optString("twoFactorToken"), json.optString("message", "请输入验证码"))
        }
        if (json.optBoolean("requiresEmailVerification")) {
            return LoginOutcome.EmailVerificationRequired(json.optString("email"), json.optString("message"))
        }
        return LoginOutcome.Authenticated(parseAuthenticatedResponse(response, json))
    }

    private fun parseAuthenticatedResponse(response: RawResponse, json: JSONObject): LoginSession {
        if (response.code !in 200..299 || !json.optBoolean("success", true)) throw apiError(response, json)
        val token = json.optString("token")
        if (token.isBlank()) throw RaiApiException("登录响应缺少会话令牌")
        val secrets = SessionSecrets(
            accessToken = token,
            expiresAt = json.optLong("tokenExpiresAt", 0),
            refreshCookie = extractRefreshCookie(response.headers).orEmpty()
        )
        secureSessionStore.save(secrets)
        return LoginSession((json.optJSONObject("user") ?: JSONObject()).toRaiUser(), secrets)
    }

    private fun decodeJson(response: RawResponse): JSONObject {
        val json = runCatching { JSONObject(response.body) }.getOrElse {
            throw RaiApiException("服务器返回了无法解析的响应", response.code)
        }
        if (response.code !in 200..299) throw apiError(response, json)
        return json
    }

    private fun checked(response: RawResponse): RawResponse {
        if (response.code !in 200..299) throw apiError(response)
        return response
    }

    private fun apiError(response: RawResponse, parsed: JSONObject? = null): RaiApiException {
        val json = parsed ?: runCatching { JSONObject(response.body) }.getOrNull()
        return RaiApiException(
            message = json?.optString("error")?.takeIf { it.isNotBlank() }
                ?: "请求失败 (${response.code})",
            statusCode = response.code,
            errorCode = json?.optString("code")?.takeIf { it.isNotBlank() }
        )
    }

    private fun apiError(response: Response): RaiApiException {
        val body = runCatching { response.body?.string().orEmpty() }.getOrDefault("")
        return apiError(RawResponse(response.code, response.headers, body))
    }

    private fun extractRefreshCookie(headers: Headers): String? {
        return headers.values("Set-Cookie")
            .firstNotNullOfOrNull { header ->
                header.substringBefore(';').takeIf {
                    it.startsWith("__Host-rai_refresh=") || it.startsWith("rai_refresh=")
                }
            }
    }

    private companion object {
        val JsonMediaType = "application/json; charset=utf-8".toMediaType()
        val defaultModels = listOf(
            ModelOption("auto", "智能"),
            ModelOption("deepseek-flash", "快速"),
            ModelOption("deepseek-pro", "深度思考"),
            ModelOption("gpt-5.6-luna", "GPT 5.6"),
            ModelOption("claude-sonnet-5", "Claude Sonnet 5"),
            ModelOption("gemini-3.6-flash-low", "Gemini 3.6")
        )
    }

    private fun promptIdentity(model: String): String = when (model) {
        "auto" -> "smart"
        "deepseek-flash" -> "fast"
        "deepseek-pro" -> "think"
        else -> "model:$model"
    }
}

internal object SseEventParser {
    fun parse(data: String): ChatStreamEvent? {
        val json = runCatching { JSONObject(data) }.getOrNull() ?: return null
        return when (json.optString("type")) {
            "content" -> ChatStreamEvent.Content(json.optString("content"))
            "reasoning" -> ChatStreamEvent.Reasoning(json.optString("content"))
            "sources" -> ChatStreamEvent.Sources(parseSources(json.opt("sources")))
            "title" -> ChatStreamEvent.Title(json.optString("title"))
            "model_info" -> ChatStreamEvent.ModelInfo(json.optString("model"))
            "points_info" -> ChatStreamEvent.PointsInfo(
                json.optInt("remaining", json.optInt("totalPoints", -1)).takeIf { it >= 0 }
            )
            "error" -> ChatStreamEvent.Error(json.optString("error", "聊天请求失败"))
            "cancelled" -> ChatStreamEvent.Cancelled
            "done" -> ChatStreamEvent.Done
            "image" -> ChatStreamEvent.Content(
                json.optString("url", json.optString("filePath"))
                    .takeIf { it.isNotBlank() }
                    ?.let { "\n$it" }
                    .orEmpty()
            )
            else -> null
        }
    }
}
