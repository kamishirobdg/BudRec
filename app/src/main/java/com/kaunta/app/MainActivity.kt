package com.kaunta.app

import android.os.Bundle
import android.view.KeyEvent
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.ui.Modifier
import androidx.navigation.compose.rememberNavController
import com.kaunta.app.ui.navigation.AppNavigation
import com.kaunta.app.ui.theme.KauntaTheme

class MainActivity : ComponentActivity() {

    private var volumeKeyListener: ((Boolean) -> Unit)? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // enableEdgeToEdge() is intentionally omitted:
        // targetSdk=35 already enforces edge-to-edge system-side (compat change 349153669).
        // Calling it additionally made the window background transparent before Compose
        // could render, producing a black screen on emulators.
        setContent {
            KauntaTheme {
                Surface(
                    modifier = Modifier.fillMaxSize(),
                    color = MaterialTheme.colorScheme.background
                ) {
                    val navController = rememberNavController()
                    AppNavigation(navController = navController)
                }
            }
        }
    }

    override fun onKeyDown(keyCode: Int, event: KeyEvent?): Boolean {
        return when (keyCode) {
            KeyEvent.KEYCODE_VOLUME_UP -> {
                volumeKeyListener?.invoke(true)
                true
            }
            KeyEvent.KEYCODE_VOLUME_DOWN -> {
                volumeKeyListener?.invoke(false)
                true
            }
            else -> super.onKeyDown(keyCode, event)
        }
    }

    fun setVolumeKeyListener(listener: (Boolean) -> Unit) {
        volumeKeyListener = listener
    }

    fun clearVolumeKeyListener() {
        volumeKeyListener = null
    }
}
