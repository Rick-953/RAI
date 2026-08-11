package sarl.rick.rai.ui

import android.content.Context
import android.net.Uri
import android.provider.OpenableColumns
import java.io.ByteArrayOutputStream
import java.io.IOException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.animateContentSize
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkVertically
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Add
import androidx.compose.material.icons.rounded.ArrowBack
import androidx.compose.material.icons.rounded.ArrowDropDown
import androidx.compose.material.icons.rounded.ArrowUpward
import androidx.compose.material.icons.rounded.AttachFile
import androidx.compose.material.icons.rounded.Bookmark
import androidx.compose.material.icons.rounded.BookmarkBorder
import androidx.compose.material.icons.rounded.Close
import androidx.compose.material.icons.rounded.DeleteOutline
import androidx.compose.material.icons.rounded.Edit
import androidx.compose.material.icons.rounded.Language
import androidx.compose.material.icons.rounded.MoreVert
import androidx.compose.material.icons.rounded.Psychology
import androidx.compose.material.icons.rounded.Send
import androidx.compose.material.icons.rounded.Stop
import androidx.compose.material.icons.rounded.Visibility
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.AssistChip
import androidx.compose.material3.AssistChipDefaults
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExperimentalMaterial3ExpressiveApi
import androidx.compose.material3.FilledIconButton
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.IconToggleButton
import androidx.compose.material3.InputChip
import androidx.compose.material3.InputChipDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.material3.TooltipBox
import androidx.compose.material3.TooltipDefaults
import androidx.compose.material3.PlainTooltip
import androidx.compose.material3.rememberTooltipState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import sarl.rick.rai.model.Attachment
import sarl.rick.rai.model.ChatMessage
import sarl.rick.rai.model.ChatSource
import sarl.rick.rai.model.ConversationSummary
import sarl.rick.rai.model.UploadPayload
import sarl.rick.rai.viewmodel.RaiUiState
import sarl.rick.rai.viewmodel.RaiViewModel

@Composable
fun CompactConversationHost(state: RaiUiState, viewModel: RaiViewModel) {
    var showConversation by rememberSaveable { mutableStateOf(false) }
    LaunchedEffect(state.selectedConversationId) {
        if (state.selectedConversationId == null) showConversation = false
    }
    if (showConversation) {
        ConversationPane(state, viewModel, Modifier.fillMaxSize(), showBack = true) { showConversation = false }
    } else {
        ConversationListPane(
            state = state,
            viewModel = viewModel,
            modifier = Modifier.fillMaxSize(),
            onConversationSelected = { id ->
                viewModel.selectConversation(id)
                showConversation = true
            },
            onNewConversation = {
                viewModel.newConversation()
                showConversation = true
            }
        )
    }
}

@Composable
fun ConversationListPane(
    state: RaiUiState,
    viewModel: RaiViewModel,
    modifier: Modifier = Modifier,
    onConversationSelected: (String) -> Unit = viewModel::selectConversation,
    onNewConversation: () -> Unit = viewModel::newConversation
) {
    val pinned = state.conversations.filter { it.pinned }
    val regular = state.conversations.filterNot { it.pinned }
    Column(modifier.fillMaxHeight()) {
        TopAppBar(
            title = {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    RaiLogo(34.dp)
                    Text("RAI", style = MaterialTheme.typography.titleLarge)
                }
            },
            actions = {
                RaiTooltip("新建对话") {
                    IconButton(onClick = onNewConversation, enabled = !state.isBusy) {
                        Icon(Icons.Rounded.Add, contentDescription = "新建对话")
                    }
                }
            }
        )
        if (state.isBusy && state.conversations.isEmpty()) {
            Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
        } else if (state.conversations.isEmpty()) {
            Box(Modifier.fillMaxSize().padding(24.dp), contentAlignment = Alignment.Center) {
                Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(16.dp)) {
                    RaiLogo(72.dp)
                    Text("开始一段新对话", style = MaterialTheme.typography.titleLarge)
                    Button(onClick = onNewConversation) { Text("新建对话") }
                }
            }
        } else {
            LazyColumn(contentPadding = PaddingValues(horizontal = 8.dp, vertical = 4.dp)) {
                if (pinned.isNotEmpty()) {
                    item(key = "pinned-label") { SectionLabel("已置顶") }
                    items(pinned, key = { it.id }) { conversation ->
                        ConversationRow(conversation, conversation.id == state.selectedConversationId, onConversationSelected, viewModel)
                    }
                }
                if (regular.isNotEmpty()) {
                    item(key = "recent-label") { SectionLabel(if (pinned.isEmpty()) "最近对话" else "其他对话") }
                    items(regular, key = { it.id }) { conversation ->
                        ConversationRow(conversation, conversation.id == state.selectedConversationId, onConversationSelected, viewModel)
                    }
                }
            }
        }
    }
}

@Composable
private fun SectionLabel(text: String) {
    Text(
        text,
        modifier = Modifier.padding(start = 12.dp, top = 14.dp, bottom = 6.dp),
        style = MaterialTheme.typography.labelLarge,
        color = MaterialTheme.colorScheme.onSurfaceVariant
    )
}

@OptIn(ExperimentalFoundationApi::class, ExperimentalMaterial3ExpressiveApi::class)
@Composable
private fun ConversationRow(
    conversation: ConversationSummary,
    selected: Boolean,
    onSelect: (String) -> Unit,
    viewModel: RaiViewModel
) {
    var menuVisible by remember { mutableStateOf(false) }
    var renameVisible by remember { mutableStateOf(false) }
    var deleteVisible by remember { mutableStateOf(false) }
    var title by remember(conversation.title) { mutableStateOf(conversation.title) }
    val alpha by animateFloatAsState(
        targetValue = if (selected) 1f else 0f,
        animationSpec = MaterialTheme.motionScheme.fastEffectsSpec(),
        label = "session-selected"
    )

    Surface(
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = 2.dp)
            .clip(MaterialTheme.shapes.small)
            .combinedClickable(onClick = { onSelect(conversation.id) }),
        color = MaterialTheme.colorScheme.secondaryContainer.copy(alpha = alpha),
        contentColor = if (selected) MaterialTheme.colorScheme.onSecondaryContainer else MaterialTheme.colorScheme.onSurface,
        shape = MaterialTheme.shapes.small
    ) {
        Row(
            Modifier.fillMaxWidth().padding(start = 12.dp, end = 4.dp, top = 10.dp, bottom = 10.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            Column(Modifier.weight(1f)) {
                Text(conversation.title, maxLines = 1, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.titleSmall)
                Spacer(Modifier.height(3.dp))
                Text(
                    displayTime(conversation.updatedAt),
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }
            Box {
                RaiTooltip("对话操作") {
                    IconButton(onClick = { menuVisible = true }, modifier = Modifier.size(40.dp)) {
                        Icon(Icons.Rounded.MoreVert, contentDescription = "对话操作")
                    }
                }
                DropdownMenu(expanded = menuVisible, onDismissRequest = { menuVisible = false }) {
                    DropdownMenuItem(
                        text = { Text("重命名") },
                        leadingIcon = { Icon(Icons.Rounded.Edit, contentDescription = null) },
                        onClick = { menuVisible = false; renameVisible = true }
                    )
                    DropdownMenuItem(
                        text = { Text(if (conversation.pinned) "取消置顶" else "置顶") },
                        leadingIcon = {
                            Icon(if (conversation.pinned) Icons.Rounded.BookmarkBorder else Icons.Rounded.Bookmark, contentDescription = null)
                        },
                        onClick = { menuVisible = false; viewModel.togglePinned(conversation) }
                    )
                    DropdownMenuItem(
                        text = { Text("删除", color = MaterialTheme.colorScheme.error) },
                        leadingIcon = { Icon(Icons.Rounded.DeleteOutline, contentDescription = null, tint = MaterialTheme.colorScheme.error) },
                        onClick = { menuVisible = false; deleteVisible = true }
                    )
                }
            }
        }
    }
    if (renameVisible) {
        AlertDialog(
            onDismissRequest = { renameVisible = false },
            title = { Text("重命名对话") },
            text = {
                OutlinedTextField(value = title, onValueChange = { title = it }, singleLine = true, modifier = Modifier.fillMaxWidth())
            },
            confirmButton = {
                TextButton(onClick = { viewModel.renameConversation(conversation.id, title); renameVisible = false }) { Text("保存") }
            },
            dismissButton = { TextButton(onClick = { renameVisible = false }) { Text("取消") } }
        )
    }
    if (deleteVisible) {
        AlertDialog(
            onDismissRequest = { deleteVisible = false },
            title = { Text("删除对话") },
            text = { Text("此操作不可撤销。") },
            confirmButton = {
                TextButton(onClick = { viewModel.deleteConversation(conversation.id); deleteVisible = false }) {
                    Text("删除", color = MaterialTheme.colorScheme.error)
                }
            },
            dismissButton = { TextButton(onClick = { deleteVisible = false }) { Text("取消") } }
        )
    }
}

@Composable
fun ConversationPane(
    state: RaiUiState,
    viewModel: RaiViewModel,
    modifier: Modifier = Modifier,
    showBack: Boolean,
    onBack: () -> Unit = {}
) {
    val selected = state.conversations.firstOrNull { it.id == state.selectedConversationId }
    Column(modifier.fillMaxSize()) {
        TopAppBar(
            title = {
                Column {
                    Text(selected?.title ?: "新对话", maxLines = 1, overflow = TextOverflow.Ellipsis)
                    selected?.model?.takeIf { it.isNotBlank() }?.let {
                        Text(it, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
            },
            navigationIcon = {
                if (showBack) {
                    IconButton(onClick = onBack) { Icon(Icons.Rounded.ArrowBack, contentDescription = "返回对话列表") }
                }
            }
        )
        HorizontalDivider()
        if (selected == null) {
            Box(Modifier.weight(1f).fillMaxWidth(), contentAlignment = Alignment.Center) {
                Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(16.dp)) {
                    RaiLogo(80.dp)
                    Text("今天想聊什么？", style = MaterialTheme.typography.headlineSmall)
                    Button(onClick = viewModel::newConversation) { Text("新建对话") }
                }
            }
        } else {
            ChatHistory(state, Modifier.weight(1f))
            HorizontalDivider()
            Composer(state, viewModel)
        }
    }
}

@Composable
private fun ChatHistory(state: RaiUiState, modifier: Modifier) {
    val listState = rememberLazyListState()
    val scrollKey = state.messages.lastOrNull()?.let { "${it.content.length}:${it.reasoning.length}:${it.isStreaming}" }
    LaunchedEffect(scrollKey) {
        if (state.messages.isNotEmpty()) listState.animateScrollToItem(state.messages.lastIndex)
    }
    if (state.isLoadingMessages) {
        Box(modifier.fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
    } else if (state.messages.isEmpty()) {
        Box(modifier.fillMaxSize().padding(28.dp), contentAlignment = Alignment.Center) {
            Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(12.dp)) {
                RaiLogo(64.dp)
                Text("从一个问题开始", style = MaterialTheme.typography.titleLarge)
            }
        }
    } else {
        LazyColumn(
            state = listState,
            modifier = modifier.fillMaxWidth(),
            contentPadding = PaddingValues(horizontal = 16.dp, vertical = 18.dp),
            verticalArrangement = Arrangement.spacedBy(18.dp)
        ) {
            items(state.messages, key = { message -> "${message.id ?: "stream"}-${message.role}-${message.content.length}" }) { message ->
                ChatMessageItem(message)
            }
        }
    }
}

@OptIn(ExperimentalMaterial3ExpressiveApi::class)
@Composable
private fun ChatMessageItem(message: ChatMessage) {
    val isUser = message.role == "user"
    Column(
        modifier = Modifier.fillMaxWidth(),
        horizontalAlignment = if (isUser) Alignment.End else Alignment.Start,
        verticalArrangement = Arrangement.spacedBy(8.dp)
    ) {
        if (!isUser) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                RaiLogo(28.dp)
                Text(message.model.ifBlank { "RAI" }, style = MaterialTheme.typography.labelLarge)
            }
        }
        if (isUser) {
            Surface(
                color = MaterialTheme.colorScheme.primaryContainer,
                contentColor = MaterialTheme.colorScheme.onPrimaryContainer,
                shape = MaterialTheme.shapes.small,
                modifier = Modifier.widthIn(max = 560.dp).animateContentSize(MaterialTheme.motionScheme.defaultSpatialSpec())
            ) {
                Column(Modifier.padding(horizontal = 14.dp, vertical = 11.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    if (message.content.isNotBlank()) MarkdownText(message.content)
                    MessageAttachments(message.attachments)
                }
            }
        } else {
            Column(Modifier.widthIn(max = 720.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                if (message.reasoning.isNotBlank()) ReasoningBlock(message.reasoning)
                if (message.content.isNotBlank()) MarkdownText(message.content)
                if (message.isStreaming && message.content.isBlank()) {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
                        Text("正在思考", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
                MessageSources(message.sources)
                message.streamError?.let {
                    Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium)
                }
            }
        }
    }
}

@OptIn(ExperimentalMaterial3ExpressiveApi::class)
@Composable
private fun ReasoningBlock(reasoning: String) {
    var expanded by rememberSaveable(reasoning.take(24)) { mutableStateOf(false) }
    TextButton(onClick = { expanded = !expanded }, contentPadding = PaddingValues(0.dp)) {
        Icon(Icons.Rounded.Psychology, contentDescription = null, modifier = Modifier.size(18.dp))
        Spacer(Modifier.width(6.dp))
        Text(if (expanded) "隐藏思考" else "查看思考")
    }
    AnimatedVisibility(
        visible = expanded,
        enter = expandVertically(MaterialTheme.motionScheme.defaultSpatialSpec()) + fadeIn(MaterialTheme.motionScheme.fastEffectsSpec()),
        exit = shrinkVertically(MaterialTheme.motionScheme.fastSpatialSpec()) + fadeOut(MaterialTheme.motionScheme.fastEffectsSpec())
    ) {
        Surface(color = MaterialTheme.colorScheme.surfaceVariant, shape = MaterialTheme.shapes.small) {
            Text(
                reasoning,
                modifier = Modifier.padding(12.dp),
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
        }
    }
}

@Composable
private fun MessageAttachments(attachments: List<Attachment>) {
    if (attachments.isEmpty()) return
    LazyRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        items(attachments, key = { it.originalName + it.filename }) { attachment ->
            AssistChip(
                onClick = {},
                label = { Text(attachment.originalName, maxLines = 1, overflow = TextOverflow.Ellipsis) },
                leadingIcon = { Icon(Icons.Rounded.AttachFile, contentDescription = null, modifier = Modifier.size(16.dp)) }
            )
        }
    }
}

@Composable
private fun MessageSources(sources: List<ChatSource>) {
    if (sources.isEmpty()) return
    val uriHandler = LocalUriHandler.current
    Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
        sources.take(8).forEach { source ->
            TextButton(
                onClick = { runCatching { uriHandler.openUri(source.url) } },
                contentPadding = PaddingValues(0.dp)
            ) {
                Icon(Icons.Rounded.Language, contentDescription = null, modifier = Modifier.size(16.dp))
                Spacer(Modifier.width(6.dp))
                Text(source.title.ifBlank { source.url }, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun Composer(state: RaiUiState, viewModel: RaiViewModel) {
    var input by rememberSaveable(state.selectedConversationId) { mutableStateOf("") }
    var modelMenuVisible by remember { mutableStateOf(false) }
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val picker = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        uri ?: return@rememberLauncherForActivityResult
        scope.launch {
            runCatching { readUploadPayload(context, uri) }
                .onSuccess(viewModel::upload)
                .onFailure { viewModel.reportError(it.message ?: "无法读取附件") }
        }
    }
    val supportsThinking = state.models.firstOrNull { it.id == state.selectedModel }?.supportsThinking ?: true
    Surface(
        color = MaterialTheme.colorScheme.surface,
        modifier = Modifier.fillMaxWidth().imePadding()
    ) {
        Column(Modifier.padding(horizontal = 12.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            if (state.pendingAttachments.isNotEmpty()) {
                LazyRow(horizontalArrangement = Arrangement.spacedBy(6.dp), modifier = Modifier.fillMaxWidth()) {
                    items(state.pendingAttachments, key = { it.filename }) { attachment ->
                        InputChip(
                            selected = true,
                            onClick = { viewModel.removePendingAttachment(attachment.filename) },
                            label = { Text(attachment.originalName, maxLines = 1, overflow = TextOverflow.Ellipsis) },
                            trailingIcon = { Icon(Icons.Rounded.Close, contentDescription = "移除附件", modifier = Modifier.size(16.dp)) }
                        )
                    }
                }
            }
            Row(verticalAlignment = Alignment.Bottom) {
                RaiTooltip("添加附件") {
                    IconButton(onClick = { picker.launch(arrayOf("image/*", "application/pdf", "text/*", "application/msword", "application/vnd.openxmlformats-officedocument.wordprocessingml.document")) }, enabled = !state.isUploading && !state.isStreaming) {
                        if (state.isUploading) CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
                        else Icon(Icons.Rounded.AttachFile, contentDescription = "添加附件")
                    }
                }
                OutlinedTextField(
                    value = input,
                    onValueChange = { input = it },
                    placeholder = { Text("发送消息") },
                    modifier = Modifier.weight(1f).heightIn(min = 54.dp, max = 156.dp),
                    maxLines = 6,
                    shape = RoundedCornerShape(8.dp)
                )
                Spacer(Modifier.width(6.dp))
                if (state.isStreaming) {
                    RaiTooltip("停止生成") {
                        FilledIconButton(onClick = viewModel::stopGeneration) {
                            Icon(Icons.Rounded.Stop, contentDescription = "停止生成")
                        }
                    }
                } else {
                    RaiTooltip("发送") {
                        FilledIconButton(
                            onClick = { viewModel.sendMessage(input); input = "" },
                            enabled = input.isNotBlank() || state.pendingAttachments.isNotEmpty()
                        ) {
                            Icon(Icons.Rounded.ArrowUpward, contentDescription = "发送")
                        }
                    }
                }
            }
            Row(verticalAlignment = Alignment.CenterVertically) {
                Box {
                    TextButton(onClick = { modelMenuVisible = true }, enabled = !state.isStreaming) {
                        Text(state.models.firstOrNull { it.id == state.selectedModel }?.label ?: state.selectedModel, maxLines = 1)
                        Icon(Icons.Rounded.ArrowDropDown, contentDescription = "选择模型")
                    }
                    DropdownMenu(expanded = modelMenuVisible, onDismissRequest = { modelMenuVisible = false }) {
                        state.models.forEach { model ->
                            DropdownMenuItem(
                                text = { Text(model.label) },
                                onClick = { viewModel.setModel(model.id); modelMenuVisible = false }
                            )
                        }
                    }
                }
                Spacer(Modifier.weight(1f))
                RaiTooltip(if (state.internetMode) "已开启联网" else "已关闭联网") {
                    IconToggleButton(checked = state.internetMode, onCheckedChange = viewModel::setInternetMode, enabled = !state.isStreaming) {
                        Icon(Icons.Rounded.Language, contentDescription = "联网搜索")
                    }
                }
                RaiTooltip(if (state.thinkingMode) "已开启思考" else "已关闭思考") {
                    IconToggleButton(checked = state.thinkingMode, onCheckedChange = viewModel::setThinkingMode, enabled = !state.isStreaming && supportsThinking) {
                        Icon(Icons.Rounded.Psychology, contentDescription = "思考模式")
                    }
                }
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun RaiTooltip(label: String, content: @Composable () -> Unit) {
    TooltipBox(
        positionProvider = TooltipDefaults.rememberPlainTooltipPositionProvider(),
        tooltip = { PlainTooltip { Text(label) } },
        state = rememberTooltipState()
    ) { content() }
}

private suspend fun readUploadPayload(context: Context, uri: Uri): UploadPayload = withContext(Dispatchers.IO) {
    val displayName = context.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)
        ?.use { cursor -> if (cursor.moveToFirst()) cursor.getString(0) else null }
        ?.takeIf { it.isNotBlank() }
        ?: "attachment"
    val mimeType = context.contentResolver.getType(uri) ?: "application/octet-stream"
    val maxBytes = 30L * 1024L * 1024L
    val output = ByteArrayOutputStream()
    context.contentResolver.openInputStream(uri)?.use { input ->
        val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
        while (true) {
            val count = input.read(buffer)
            if (count < 0) break
            if (output.size().toLong() + count > maxBytes) throw IOException("附件超过 30 MB 本地上限")
            output.write(buffer, 0, count)
        }
    } ?: throw IOException("无法读取附件")
    UploadPayload(displayName, mimeType, output.toByteArray())
}

private fun displayTime(value: String): String {
    return value.replace('T', ' ').substringBefore('.').take(16).ifBlank { "刚刚" }
}
