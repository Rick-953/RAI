package sarl.rick.rai.data

import android.content.Context
import androidx.datastore.preferences.core.PreferenceDataStoreFactory
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStoreFile
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map

data class AppSettings(
    val serverUrl: String = ServerUrl.Default,
    val themeMode: ThemeMode = ThemeMode.System,
    val dynamicColor: Boolean = true
)

enum class ThemeMode { System, Light, Dark }

class SettingsRepository(context: Context) {
    private val dataStore = PreferenceDataStoreFactory.create(
        produceFile = { context.preferencesDataStoreFile("rai_preferences.preferences_pb") }
    )

    val settings: Flow<AppSettings> = dataStore.data.map { preferences ->
        AppSettings(
            serverUrl = preferences[ServerUrlKey] ?: ServerUrl.Default,
            themeMode = runCatching { ThemeMode.valueOf(preferences[ThemeModeKey] ?: ThemeMode.System.name) }
                .getOrDefault(ThemeMode.System),
            dynamicColor = preferences[DynamicColorKey] ?: true
        )
    }

    suspend fun saveServerUrl(serverUrl: String) {
        dataStore.edit { it[ServerUrlKey] = serverUrl }
    }

    suspend fun saveThemeMode(themeMode: ThemeMode) {
        dataStore.edit { it[ThemeModeKey] = themeMode.name }
    }

    suspend fun saveDynamicColor(enabled: Boolean) {
        dataStore.edit { it[DynamicColorKey] = enabled }
    }

    private companion object {
        val ServerUrlKey = stringPreferencesKey("server_url")
        val ThemeModeKey = stringPreferencesKey("theme_mode")
        val DynamicColorKey = booleanPreferencesKey("dynamic_color")
    }
}
