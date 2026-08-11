package sarl.rick.rai

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.runtime.getValue
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import sarl.rick.rai.ui.RaiApp
import sarl.rick.rai.ui.theme.RaiTheme
import sarl.rick.rai.viewmodel.RaiViewModel

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent {
            val viewModel: RaiViewModel = viewModel()
            val state by viewModel.state.collectAsStateWithLifecycle()
            RaiTheme(
                themeMode = state.settings.themeMode,
                dynamicColor = state.settings.dynamicColor
            ) {
                RaiApp(state = state, viewModel = viewModel)
            }
        }
    }
}
