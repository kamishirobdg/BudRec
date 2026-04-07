package com.kaunta.app.ui.settings

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.kaunta.app.KauntaApp
import com.kaunta.app.domain.model.CounterSettings
import com.kaunta.app.domain.model.GoalNotificationMode
import com.kaunta.app.domain.model.SpeechInterval
import com.kaunta.app.domain.model.VolumeKeyMode
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch

class SettingsViewModel(application: Application) : AndroidViewModel(application) {

    private val repo get() = getApplication<KauntaApp>().counterRepository

    val settings: StateFlow<CounterSettings> = repo.settingsFlow
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), CounterSettings())

    fun updateTargetCount(value: Int) {
        if (value < 1) return
        save { it.copy(targetCount = value) }
    }

    fun updateVolumeKeyMode(mode: VolumeKeyMode) = save { it.copy(volumeKeyMode = mode) }

    fun updateGoalNotificationMode(mode: GoalNotificationMode) =
        save { it.copy(goalNotificationMode = mode) }

    fun updateNotificationSoundUri(uri: String) = save { it.copy(notificationSoundUri = uri) }

    fun updateSpeechInterval(interval: SpeechInterval) = save { it.copy(speechInterval = interval) }

    fun updateShowMemoDialog(enabled: Boolean) = save { it.copy(showMemoDialogOnAchievement = enabled) }

    private fun save(transform: (CounterSettings) -> CounterSettings) {
        viewModelScope.launch {
            repo.saveSettings(transform(repo.getSettings()))
        }
    }
}
