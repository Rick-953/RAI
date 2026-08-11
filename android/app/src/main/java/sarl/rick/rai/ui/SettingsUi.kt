package sarl.rick.rai.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Check
import androidx.compose.material.icons.rounded.ColorLens
import androidx.compose.material.icons.rounded.DarkMode
import androidx.compose.material.icons.rounded.Devices
import androidx.compose.material.icons.rounded.LightMode
import androidx.compose.material.icons.rounded.Logout
import androidx.compose.material.icons.rounded.Public
import androidx.compose.material.icons.rounded.SettingsBrightness
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import sarl.rick.rai.BuildConfig
import sarl.rick.rai.data.ThemeMode
import sarl.rick.rai.viewmodel.RaiUiState
import sarl.rick.rai.viewmodel.RaiViewModel

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingsScreen(
    state: RaiUiState,
    viewModel: RaiViewModel,
    compact: Boolean,
    modifier: Modifier = Modifier
) {
    var serverUrl by rememberSaveable(state.settings.serverUrl) { mutableStateOf(state.settings.serverUrl) }
    var confirmServerChange by remember { mutableStateOf(false) }

    Column(modifier.fillMaxSize()) {
        TopAppBar(title = { Text("设置") })
        HorizontalDivider()
        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.TopCenter) {
            LazyColumn(
                modifier = Modifier.fillMaxWidth().widthIn(max = if (compact) 720.dp else 860.dp),
                contentPadding = PaddingValues(horizontal = if (compact) 16.dp else 28.dp, vertical = 20.dp),
                verticalArrangement = Arrangement.spacedBy(4.dp)
            ) {
                item {
                    SettingsSectionHeader(Icons.Rounded.Public, "服务器")
                    OutlinedTextField(
                        value = serverUrl,
                        onValueChange = { serverUrl = it },
                        label = { Text("RAI 服务器地址") },
                        singleLine = true,
                        modifier = Modifier.fillMaxWidth()
                    )
                    Row(
                        modifier = Modifier.fillMaxWidth().padding(top = 10.dp),
                        horizontalArrangement = Arrangement.End
                    ) {
                        Button(
                            onClick = { confirmServerChange = true },
                            enabled = serverUrl.trim() != state.settings.serverUrl
                        ) {
                            Icon(Icons.Rounded.Check, contentDescription = null)
                            Spacer(Modifier.width(8.dp))
                            Text("应用")
                        }
                    }
                    SettingsDivider()
                }

                item {
                    SettingsSectionHeader(Icons.Rounded.ColorLens, "外观")
                    Text("主题", style = MaterialTheme.typography.labelLarge, modifier = Modifier.padding(bottom = 8.dp))
                    SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth()) {
                        ThemeMode.entries.forEachIndexed { index, mode ->
                            SegmentedButton(
                                selected = state.settings.themeMode == mode,
                                onClick = { viewModel.saveThemeMode(mode) },
                                shape = SegmentedButtonDefaults.itemShape(index, ThemeMode.entries.size),
                                icon = {
                                    Icon(
                                        when (mode) {
                                            ThemeMode.System -> Icons.Rounded.SettingsBrightness
                                            ThemeMode.Light -> Icons.Rounded.LightMode
                                            ThemeMode.Dark -> Icons.Rounded.DarkMode
                                        },
                                        contentDescription = null,
                                        modifier = Modifier.size(18.dp)
                                    )
                                },
                                label = {
                                    Text(
                                        when (mode) {
                                            ThemeMode.System -> "系统"
                                            ThemeMode.Light -> "浅色"
                                            ThemeMode.Dark -> "深色"
                                        }
                                    )
                                }
                            )
                        }
                    }
                    ListItem(
                        headlineContent = { Text("动态色彩") },
                        leadingContent = { Icon(Icons.Rounded.ColorLens, contentDescription = null) },
                        trailingContent = {
                            Switch(checked = state.settings.dynamicColor, onCheckedChange = viewModel::saveDynamicColor)
                        }
                    )
                    SettingsDivider()
                }

                item {
                    SettingsSectionHeader(Icons.Rounded.Devices, "客户端")
                    SettingsValue("版本", BuildConfig.VERSION_NAME)
                    SettingsValue("软件授权", state.capabilities?.keyId?.let { "${it.take(6)}…${it.takeLast(4)}" } ?: "未验证")
                    SettingsValue("后端版本", state.capabilities?.packageVersion ?: "-")
                    SettingsDivider()
                }

                item {
                    SettingsSectionHeader(Icons.Rounded.Devices, "账号")
                    SettingsValue("用户", state.user?.username.orEmpty())
                    SettingsValue("邮箱", state.user?.email.orEmpty())
                    SettingsValue("会员", state.membership?.membership ?: "-")
                    SettingsValue("点数", state.membership?.totalPoints?.toString() ?: "-")
                    TextButton(
                        onClick = viewModel::logout,
                        modifier = Modifier.padding(top = 8.dp)
                    ) {
                        Icon(Icons.Rounded.Logout, contentDescription = null)
                        Spacer(Modifier.width(8.dp))
                        Text("退出登录")
                    }
                }
            }
        }
    }

    if (confirmServerChange) {
        AlertDialog(
            onDismissRequest = { confirmServerChange = false },
            title = { Text("切换 RAI 服务器") },
            text = { Text("切换服务器会先清除当前设备的登录会话，之后需要在新服务器重新登录。") },
            confirmButton = {
                TextButton(onClick = { viewModel.saveServerUrl(serverUrl); confirmServerChange = false }) { Text("切换") }
            },
            dismissButton = { TextButton(onClick = { confirmServerChange = false }) { Text("取消") } }
        )
    }
}

@Composable
private fun SettingsSectionHeader(icon: androidx.compose.ui.graphics.vector.ImageVector, label: String) {
    Row(
        modifier = Modifier.fillMaxWidth().padding(bottom = 14.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp)
    ) {
        Icon(icon, contentDescription = null, tint = MaterialTheme.colorScheme.primary)
        Text(label, style = MaterialTheme.typography.titleLarge)
    }
}

@Composable
private fun SettingsValue(label: String, value: String) {
    Row(Modifier.fillMaxWidth().padding(vertical = 7.dp), horizontalArrangement = Arrangement.spacedBy(16.dp)) {
        Text(label, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Text(value.ifBlank { "-" }, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.weight(1f), fontWeight = FontWeight.Medium)
    }
}

@Composable
private fun SettingsDivider() {
    HorizontalDivider(Modifier.padding(vertical = 24.dp), color = MaterialTheme.colorScheme.outlineVariant)
}
