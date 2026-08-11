package sarl.rick.rai.ui

import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.expandVertically
import androidx.compose.animation.shrinkVertically
import androidx.compose.animation.scaleIn
import androidx.compose.animation.scaleOut
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.asPaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.ArrowBack
import androidx.compose.material.icons.rounded.ChatBubbleOutline
import androidx.compose.material.icons.rounded.Check
import androidx.compose.material.icons.rounded.DarkMode
import androidx.compose.material.icons.rounded.Edit
import androidx.compose.material.icons.rounded.LightMode
import androidx.compose.material.icons.rounded.Lock
import androidx.compose.material.icons.rounded.Public
import androidx.compose.material.icons.rounded.Refresh
import androidx.compose.material.icons.rounded.Settings
import androidx.compose.material.icons.rounded.Visibility
import androidx.compose.material.icons.rounded.VisibilityOff
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExperimentalMaterial3ExpressiveApi
import androidx.compose.material3.FilledIconButton
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.NavigationRail
import androidx.compose.material3.NavigationRailItem
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.VerticalDivider
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import sarl.rick.rai.R
import sarl.rick.rai.viewmodel.AuthStage
import sarl.rick.rai.viewmodel.MainDestination
import sarl.rick.rai.viewmodel.RaiUiState
import sarl.rick.rai.viewmodel.RaiViewModel

enum class RaiWindowWidth { Compact, Medium, Expanded }

@Composable
fun rememberRaiWindowWidth(): RaiWindowWidth {
    val width = LocalConfiguration.current.screenWidthDp
    return when {
        width < 600 -> RaiWindowWidth.Compact
        width < 840 -> RaiWindowWidth.Medium
        else -> RaiWindowWidth.Expanded
    }
}

@OptIn(ExperimentalMaterial3ExpressiveApi::class)
@Composable
fun RaiApp(state: RaiUiState, viewModel: RaiViewModel) {
    val snackbarHostState = remember { SnackbarHostState() }
    val authEffectsSpec = MaterialTheme.motionScheme.fastEffectsSpec<Float>()
    val authSpatialSpec = MaterialTheme.motionScheme.fastSpatialSpec<Float>()
    val transientMessage = state.error ?: state.notice
    LaunchedEffect(transientMessage) {
        transientMessage?.let {
            snackbarHostState.showSnackbar(it)
            viewModel.clearTransientMessages()
        }
    }

    Box(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background)) {
        AnimatedContent(
            targetState = state.authStage,
            transitionSpec = {
                (
                    fadeIn(authEffectsSpec) + scaleIn(authSpatialSpec, initialScale = 0.98f)
                ) togetherWith (
                    fadeOut(authEffectsSpec) + scaleOut(authSpatialSpec, targetScale = 0.98f)
                )
            },
            label = "auth-stage"
        ) { authStage ->
            when (authStage) {
                AuthStage.Checking -> CheckingScreen()
                AuthStage.SignedOut -> LoginScreen(state, viewModel)
                AuthStage.TwoFactor -> TwoFactorScreen(state, viewModel)
                AuthStage.SignedIn -> SignedInShell(state, viewModel, snackbarHostState)
            }
        }
        if (state.authStage != AuthStage.SignedIn) {
            SnackbarHost(
                hostState = snackbarHostState,
                modifier = Modifier.align(Alignment.BottomCenter).padding(16.dp)
            )
        }
    }
}

@Composable
private fun CheckingScreen() {
    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(20.dp)) {
            RaiLogo(92.dp)
            Text("RAI", style = MaterialTheme.typography.headlineLarge)
            CircularProgressIndicator(
                modifier = Modifier.size(32.dp).semantics { contentDescription = "正在连接 RAI" },
                strokeWidth = 3.dp
            )
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class, ExperimentalMaterial3ExpressiveApi::class)
@Composable
private fun LoginScreen(state: RaiUiState, viewModel: RaiViewModel) {
    var email by rememberSaveable { mutableStateOf("") }
    var password by rememberSaveable { mutableStateOf("") }
    var passwordVisible by rememberSaveable { mutableStateOf(false) }
    var editingServer by rememberSaveable { mutableStateOf(false) }
    var serverUrl by rememberSaveable(state.settings.serverUrl) { mutableStateOf(state.settings.serverUrl) }
    val submit = { viewModel.login(email, password) }

    Box(
        modifier = Modifier.fillMaxSize().padding(WindowInsets.safeDrawing.asPaddingValues()).imePadding(),
        contentAlignment = Alignment.Center
    ) {
        Column(
            modifier = Modifier.fillMaxWidth().widthIn(max = 440.dp).padding(horizontal = 28.dp, vertical = 24.dp),
            horizontalAlignment = Alignment.CenterHorizontally
        ) {
            RaiLogo(88.dp)
            Spacer(Modifier.height(16.dp))
            Text("RAI", style = MaterialTheme.typography.displaySmall)
            Text("欢迎回来", style = MaterialTheme.typography.titleMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Spacer(Modifier.height(36.dp))

            state.clientAuthorizationError?.let { message ->
                Surface(
                    color = MaterialTheme.colorScheme.errorContainer,
                    contentColor = MaterialTheme.colorScheme.onErrorContainer,
                    shape = MaterialTheme.shapes.small,
                    modifier = Modifier.fillMaxWidth()
                ) {
                    Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                        Text(message, style = MaterialTheme.typography.bodyMedium)
                        OutlinedButton(onClick = viewModel::bootstrap) {
                            Icon(Icons.Rounded.Refresh, contentDescription = null)
                            Spacer(Modifier.width(8.dp))
                            Text("重试")
                        }
                    }
                }
                Spacer(Modifier.height(18.dp))
            }

            OutlinedTextField(
                value = email,
                onValueChange = { email = it },
                label = { Text("邮箱") },
                singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email, imeAction = ImeAction.Next),
                leadingIcon = { Icon(Icons.Rounded.Public, contentDescription = null) },
                modifier = Modifier.fillMaxWidth(),
                shape = RoundedCornerShape(8.dp)
            )
            Spacer(Modifier.height(12.dp))
            OutlinedTextField(
                value = password,
                onValueChange = { password = it },
                label = { Text("密码") },
                singleLine = true,
                visualTransformation = if (passwordVisible) VisualTransformation.None else PasswordVisualTransformation(),
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password, imeAction = ImeAction.Done),
                keyboardActions = KeyboardActions(onDone = { submit() }),
                leadingIcon = { Icon(Icons.Rounded.Lock, contentDescription = null) },
                trailingIcon = {
                    IconButton(onClick = { passwordVisible = !passwordVisible }) {
                        Icon(
                            if (passwordVisible) Icons.Rounded.VisibilityOff else Icons.Rounded.Visibility,
                            contentDescription = if (passwordVisible) "隐藏密码" else "显示密码"
                        )
                    }
                },
                modifier = Modifier.fillMaxWidth(),
                shape = RoundedCornerShape(8.dp)
            )
            Spacer(Modifier.height(20.dp))
            Button(
                onClick = submit,
                enabled = email.isNotBlank() && password.isNotBlank() && !state.isBusy && state.clientAuthorizationError == null,
                modifier = Modifier.fillMaxWidth().height(52.dp)
            ) {
                if (state.isBusy) {
                    CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
                } else {
                    Text("登录")
                }
            }
            Spacer(Modifier.height(20.dp))
            OutlinedButton(onClick = { editingServer = !editingServer }) {
                Icon(Icons.Rounded.Public, contentDescription = null)
                Spacer(Modifier.width(8.dp))
                Text(state.settings.serverUrl)
                Spacer(Modifier.width(8.dp))
                Icon(Icons.Rounded.Edit, contentDescription = "修改服务器")
            }
            AnimatedVisibility(
                visible = editingServer,
                enter = expandVertically(MaterialTheme.motionScheme.defaultSpatialSpec()) +
                    fadeIn(MaterialTheme.motionScheme.fastEffectsSpec()),
                exit = shrinkVertically(MaterialTheme.motionScheme.fastSpatialSpec()) +
                    fadeOut(MaterialTheme.motionScheme.fastEffectsSpec())
            ) {
                Column(Modifier.padding(top = 12.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    OutlinedTextField(
                        value = serverUrl,
                        onValueChange = { serverUrl = it },
                        label = { Text("服务器地址") },
                        singleLine = true,
                        modifier = Modifier.fillMaxWidth(),
                        shape = RoundedCornerShape(8.dp)
                    )
                    Button(onClick = { viewModel.saveServerUrl(serverUrl); editingServer = false }, modifier = Modifier.align(Alignment.End)) {
                        Icon(Icons.Rounded.Check, contentDescription = null)
                        Spacer(Modifier.width(8.dp))
                        Text("应用")
                    }
                }
            }
        }
        if (state.isBusy) LinearProgressIndicator(Modifier.fillMaxWidth().align(Alignment.TopCenter))
    }
}

@Composable
private fun TwoFactorScreen(state: RaiUiState, viewModel: RaiViewModel) {
    var code by rememberSaveable { mutableStateOf("") }
    val submit = { viewModel.completeTwoFactor(code) }
    Box(
        Modifier.fillMaxSize().padding(WindowInsets.safeDrawing.asPaddingValues()).imePadding(),
        contentAlignment = Alignment.Center
    ) {
        Column(
            Modifier.fillMaxWidth().widthIn(max = 420.dp).padding(28.dp),
            horizontalAlignment = Alignment.CenterHorizontally
        ) {
            RaiLogo(76.dp)
            Spacer(Modifier.height(20.dp))
            Text("二步验证", style = MaterialTheme.typography.headlineMedium)
            if (state.pendingTwoFactorMessage.isNotBlank()) {
                Text(
                    state.pendingTwoFactorMessage,
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(top = 8.dp)
                )
            }
            Spacer(Modifier.height(28.dp))
            OutlinedTextField(
                value = code,
                onValueChange = { code = it.filter(Char::isDigit).take(8) },
                label = { Text("验证码") },
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.NumberPassword, imeAction = ImeAction.Done),
                keyboardActions = KeyboardActions(onDone = { submit() }),
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
                shape = RoundedCornerShape(8.dp)
            )
            Spacer(Modifier.height(20.dp))
            Button(onClick = submit, enabled = code.length >= 6 && !state.isBusy, modifier = Modifier.fillMaxWidth().height(52.dp)) {
                if (state.isBusy) CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp) else Text("验证")
            }
            Spacer(Modifier.height(8.dp))
            OutlinedButton(onClick = viewModel::cancelTwoFactor, modifier = Modifier.fillMaxWidth()) {
                Icon(Icons.Rounded.ArrowBack, contentDescription = null)
                Spacer(Modifier.width(8.dp))
                Text("返回")
            }
        }
    }
}

@Composable
private fun SignedInShell(state: RaiUiState, viewModel: RaiViewModel, snackbarHostState: SnackbarHostState) {
    val width = rememberRaiWindowWidth()
    if (width == RaiWindowWidth.Compact) {
        CompactSignedInShell(state, viewModel, snackbarHostState)
    } else {
        WideSignedInShell(state, viewModel, snackbarHostState, width)
    }
}

@Composable
private fun CompactSignedInShell(state: RaiUiState, viewModel: RaiViewModel, snackbarHostState: SnackbarHostState) {
    Scaffold(
        contentWindowInsets = WindowInsets.safeDrawing,
        snackbarHost = { SnackbarHost(snackbarHostState) },
        bottomBar = {
            NavigationBar {
                NavigationBarItem(
                    selected = state.destination == MainDestination.Conversations,
                    onClick = { viewModel.setDestination(MainDestination.Conversations) },
                    icon = { Icon(Icons.Rounded.ChatBubbleOutline, contentDescription = null) },
                    label = { Text("对话") }
                )
                NavigationBarItem(
                    selected = state.destination == MainDestination.Settings,
                    onClick = { viewModel.setDestination(MainDestination.Settings) },
                    icon = { Icon(Icons.Rounded.Settings, contentDescription = null) },
                    label = { Text("设置") }
                )
            }
        }
    ) { padding ->
        Box(Modifier.fillMaxSize().padding(padding)) {
            when (state.destination) {
                MainDestination.Conversations -> CompactConversationHost(state, viewModel)
                MainDestination.Settings -> SettingsScreen(state, viewModel, compact = true)
            }
        }
    }
}

@Composable
private fun WideSignedInShell(
    state: RaiUiState,
    viewModel: RaiViewModel,
    snackbarHostState: SnackbarHostState,
    width: RaiWindowWidth
) {
    Scaffold(contentWindowInsets = WindowInsets.safeDrawing, snackbarHost = { SnackbarHost(snackbarHostState) }) { padding ->
        Row(Modifier.fillMaxSize().padding(padding)) {
            NavigationRail {
                Spacer(Modifier.height(12.dp))
                RaiLogo(48.dp)
                Spacer(Modifier.height(20.dp))
                NavigationRailItem(
                    selected = state.destination == MainDestination.Conversations,
                    onClick = { viewModel.setDestination(MainDestination.Conversations) },
                    icon = { Icon(Icons.Rounded.ChatBubbleOutline, contentDescription = null) },
                    label = { Text("对话") }
                )
                NavigationRailItem(
                    selected = state.destination == MainDestination.Settings,
                    onClick = { viewModel.setDestination(MainDestination.Settings) },
                    icon = { Icon(Icons.Rounded.Settings, contentDescription = null) },
                    label = { Text("设置") }
                )
            }
            VerticalDivider(Modifier.fillMaxHeight())
            when (state.destination) {
                MainDestination.Conversations -> {
                    ConversationListPane(
                        state = state,
                        viewModel = viewModel,
                        modifier = Modifier.width(if (width == RaiWindowWidth.Expanded) 340.dp else 292.dp)
                    )
                    VerticalDivider(Modifier.fillMaxHeight())
                    ConversationPane(state, viewModel, Modifier.weight(1f), showBack = false)
                }
                MainDestination.Settings -> SettingsScreen(state, viewModel, compact = false, modifier = Modifier.weight(1f))
            }
        }
    }
}

@Composable
fun RaiLogo(size: androidx.compose.ui.unit.Dp) {
    Image(
        painter = painterResource(R.drawable.rai_app_icon),
        contentDescription = "RAI",
        contentScale = ContentScale.Fit,
        modifier = Modifier.size(size).clip(RoundedCornerShape(size * 0.22f))
    )
}

private infix fun androidx.compose.animation.EnterTransition.togetherWith(
    exit: androidx.compose.animation.ExitTransition
): androidx.compose.animation.ContentTransform = androidx.compose.animation.ContentTransform(this, exit)
