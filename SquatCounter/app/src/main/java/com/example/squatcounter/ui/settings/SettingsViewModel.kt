package com.example.squatcounter.ui.settings

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.example.squatcounter.CounterApp
import com.example.squatcounter.data.*
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import java.util.Locale

class SettingsViewModel(app: Application) : AndroidViewModel(app) {

    private val application = app as CounterApp
    private val prefsRepo = application.prefsRepo
    private val squatPlayer = application.squatSoundPlayer
    private val tts = application.ttsManager

    val settings = prefsRepo.settingsFlow
        .stateIn(viewModelScope, SharingStarted.Eagerly, AppSettings())

    fun setGoalCount(value: Int) = save { it.copy(goalCount = value) }
    fun setRequireMemo(value: Boolean) = save { it.copy(requireMemoOnAchieve = value) }
    fun setInvertVolumeKeys(value: Boolean) = save { it.copy(invertVolumeKeys = value) }
    fun setNotificationMode(value: NotificationMode) = save { it.copy(notificationMode = value) }
    fun setNotificationSoundUri(uri: String) = save { it.copy(notificationSoundUri = uri) }
    fun setAppVolume(value: Float) = save { it.copy(appVolume = value) }
    fun setReadAloudMode(value: ReadAloudMode) = save { it.copy(readAloudMode = value) }
    fun setReadAloudLanguage(bcp47: String) {
        tts.setLanguage(bcp47)
        save { it.copy(readAloudLanguageBcp47 = bcp47) }
    }
    fun setSquatAssistEnabled(value: Boolean) = save { it.copy(squatAssistEnabled = value) }
    fun setSquatSoundDown(value: SoundType) = save { it.copy(squatSoundDown = value) }
    fun setSquatSoundHold(value: SoundType) = save { it.copy(squatSoundHold = value) }
    fun setSquatSoundUp(value: SoundType) = save { it.copy(squatSoundUp = value) }

    fun previewSound(sound: SoundType) {
        viewModelScope.launch {
            squatPlayer.previewSound(sound, settings.value.appVolume)
        }
    }

    fun getAvailableLocales(): List<Locale> = tts.getAvailableLocales()

    private fun save(block: suspend (AppSettings) -> AppSettings) {
        viewModelScope.launch { prefsRepo.update(block) }
    }
}
