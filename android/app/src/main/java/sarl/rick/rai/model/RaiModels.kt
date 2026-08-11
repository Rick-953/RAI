package sarl.rick.rai.model

import org.json.JSONArray
import org.json.JSONObject

data class RaiUser(
    val id: Long,
    val email: String,
    val username: String,
    val avatarUrl: String? = null,
    val twoFactorEnabled: Boolean = false
)

data class SessionSecrets(
    val accessToken: String,
    val expiresAt: Long,
    val refreshCookie: String
)

data class LoginSession(
    val user: RaiUser,
    val secrets: SessionSecrets
)

sealed interface LoginOutcome {
    data class Authenticated(val session: LoginSession) : LoginOutcome
    data class TwoFactorRequired(val token: String, val message: String) : LoginOutcome
    data class EmailVerificationRequired(val email: String, val message: String) : LoginOutcome
}

data class ConversationSummary(
    val id: String,
    val title: String,
    val model: String,
    val updatedAt: String,
    val createdAt: String,
    val pinned: Boolean = false,
    val sessionKind: String = "chat"
)

data class Attachment(
    val filename: String,
    val originalName: String,
    val filePath: String,
    val fileType: String,
    val size: Long = 0
) {
    fun toJson(): JSONObject = JSONObject()
        .put("type", attachmentType(fileType))
        .put("fileName", originalName)
        .put("filename", filename)
        .put("originalName", originalName)
        .put("filePath", filePath)
        .put("mimeType", fileType)
        .put("fileType", fileType)
        .put("size", size)
}

data class ChatSource(
    val title: String,
    val url: String,
    val snippet: String = ""
)

data class ChatMessage(
    val id: Long? = null,
    val sessionId: String,
    val role: String,
    val content: String,
    val reasoning: String = "",
    val model: String = "",
    val enableSearch: Boolean = false,
    val thinkingMode: Boolean = false,
    val sources: List<ChatSource> = emptyList(),
    val attachments: List<Attachment> = emptyList(),
    val hasAttachments: Boolean = attachments.isNotEmpty(),
    val createdAt: String = "",
    val isStreaming: Boolean = false,
    val streamError: String? = null
)

data class ModelOption(
    val id: String,
    val label: String,
    val description: String = "",
    val enabled: Boolean = true,
    val supportsThinking: Boolean = true
)

data class Membership(
    val membership: String,
    val totalPoints: Int,
    val canCheckin: Boolean
)

data class Capabilities(
    val packageVersion: String,
    val keyId: String,
    val userSessionRequired: Boolean,
    val adminAllowed: Boolean
)

data class UploadPayload(
    val displayName: String,
    val mimeType: String,
    val bytes: ByteArray
)

data class SendChatRequest(
    val sessionId: String,
    val messages: List<ChatMessage>,
    val model: String,
    val internetMode: Boolean,
    val thinkingMode: Boolean,
    val uiLanguage: String = "zh-CN"
) {
    fun toJson(): JSONObject = JSONObject()
        .put("sessionId", sessionId)
        .put("model", model)
        .put("internetMode", internetMode)
        .put("thinkingMode", thinkingMode)
        .put("uiLanguage", uiLanguage)
        .put(
            "messages",
            JSONArray().also { array ->
                messages.forEach { message ->
                    array.put(
                        JSONObject()
                            .put("role", message.role)
                            .put("content", message.content)
                            .put("attachments", JSONArray().also { attachments ->
                                message.attachments.forEach { attachments.put(it.toJson()) }
                            })
                    )
                }
            }
        )
}

sealed interface ChatStreamEvent {
    data class Content(val delta: String) : ChatStreamEvent
    data class Reasoning(val delta: String) : ChatStreamEvent
    data class Sources(val sources: List<ChatSource>) : ChatStreamEvent
    data class Title(val title: String) : ChatStreamEvent
    data class ModelInfo(val model: String) : ChatStreamEvent
    data class PointsInfo(val remaining: Int?) : ChatStreamEvent
    data class Error(val message: String) : ChatStreamEvent
    data object Done : ChatStreamEvent
    data object Cancelled : ChatStreamEvent
}

fun JSONObject.toRaiUser(): RaiUser {
    return RaiUser(
        id = optLong("id"),
        email = optString("email"),
        username = optString("username", optString("email", "RAI")),
        avatarUrl = optNullableString("avatar_url"),
        twoFactorEnabled = optBoolean("two_factor_enabled")
    )
}

fun JSONObject.toConversationSummary(pinnedOverride: Boolean? = null): ConversationSummary {
    return ConversationSummary(
        id = optString("id"),
        title = optString("title", "新对话"),
        model = optString("model", "auto"),
        updatedAt = optString("updated_at"),
        createdAt = optString("created_at"),
        pinned = pinnedOverride ?: optBooleanish("pinned"),
        sessionKind = optString("session_kind", "chat")
    )
}

fun JSONObject.toAttachment(): Attachment = Attachment(
    filename = optString("filename", optString("fileId")),
    originalName = optString(
        "originalName",
        optString("original_name", optString("fileName", optString("filename", "附件")))
    ),
    filePath = optString("filePath", optString("file_path")),
    fileType = optString(
        "fileType",
        optString("mimeType", optString("file_type", optString("type", "application/octet-stream")))
    ),
    size = optLong("size", 0)
)

fun JSONObject.toChatMessage(): ChatMessage {
    val attachments = jsonArrayOrEmpty("attachments").mapTypedObjects { it.toAttachment() }
    return ChatMessage(
        id = if (has("id") && !isNull("id")) optLong("id") else null,
        sessionId = optString("session_id"),
        role = optString("role"),
        content = optString("content"),
        reasoning = optString("reasoning_content"),
        model = optString("model"),
        enableSearch = optBooleanish("enable_search") || optBooleanish("internet_mode"),
        thinkingMode = optBooleanish("thinking_mode"),
        sources = parseSources(opt("sources")),
        attachments = attachments,
        hasAttachments = optBooleanish("has_attachments") || attachments.isNotEmpty(),
        createdAt = optString("created_at")
    )
}

fun JSONObject.toModelOption(): ModelOption = ModelOption(
    id = optString("id"),
    label = optString("label", optString("name", optString("displayName", optString("id")))),
    description = optString("description"),
    enabled = !has("enabled") || optBoolean("enabled", true),
    supportsThinking = !has("supportsThinking") || optBoolean("supportsThinking", true)
)

fun parseSources(value: Any?): List<ChatSource> {
    val sourceArray = when (value) {
        is JSONArray -> value
        is String -> runCatching { JSONArray(value) }.getOrNull()
        else -> null
    } ?: return emptyList()
    return sourceArray.mapTypedObjects {
        ChatSource(
            title = it.optString("title", it.optString("name", it.optString("url"))),
            url = it.optString("url", it.optString("link")),
            snippet = it.optString("snippet", it.optString("content"))
        )
    }.filter { it.url.isNotBlank() }
}

fun <T> JSONArray.mapTypedObjects(transform: (JSONObject) -> T): List<T> {
    return buildList {
        for (index in 0 until length()) {
            optJSONObject(index)?.let { add(transform(it)) }
        }
    }
}

fun JSONObject.jsonArrayOrEmpty(name: String): JSONArray = optJSONArray(name) ?: JSONArray()

fun JSONObject.optNullableString(name: String): String? =
    if (!has(name) || isNull(name)) null else optString(name).takeIf(String::isNotBlank)

fun JSONObject.optBooleanish(name: String, default: Boolean = false): Boolean = when (val value = opt(name)) {
    is Boolean -> value
    is Number -> value.toInt() != 0
    is String -> when (value.trim().lowercase()) {
        "true", "1", "yes" -> true
        "false", "0", "no" -> false
        else -> default
    }
    else -> default
}

private fun attachmentType(mimeType: String): String = when {
    mimeType.startsWith("image/") -> "image"
    mimeType.startsWith("audio/") -> "audio"
    mimeType.startsWith("video/") -> "video"
    else -> "file"
}
