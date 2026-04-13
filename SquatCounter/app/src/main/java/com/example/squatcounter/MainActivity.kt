package com.example.squatcounter

import android.os.Bundle
import android.view.KeyEvent
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.viewModels
import com.example.squatcounter.ui.main.MainViewModel
import com.example.squatcounter.ui.theme.SquatCounterTheme

class MainActivity : ComponentActivity() {

    private val mainVm: MainViewModel by viewModels()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent {
            SquatCounterTheme {
                AppNavigation()
            }
        }
    }

    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        when (event.keyCode) {
            KeyEvent.KEYCODE_VOLUME_UP, KeyEvent.KEYCODE_VOLUME_DOWN -> {
                if (event.action == KeyEvent.ACTION_DOWN && event.repeatCount == 0) {
                    val settings = mainVm.uiState.value.settings
                    when (event.keyCode) {
                        KeyEvent.KEYCODE_VOLUME_UP ->
                            if (settings.invertVolumeKeys) mainVm.decrement() else mainVm.increment()
                        KeyEvent.KEYCODE_VOLUME_DOWN ->
                            if (settings.invertVolumeKeys) mainVm.increment() else mainVm.decrement()
                    }
                }
                return true  // ACTION_DOWN/UP 両方を消費してシステム音量変更を防ぐ
            }
        }
        return super.dispatchKeyEvent(event)
    }

    override fun onDestroy() {
        super.onDestroy()
        (application as CounterApp).ttsManager.shutdown()
    }
}
