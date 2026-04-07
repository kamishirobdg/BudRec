package com.kaunta.app.ui.main

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.kaunta.app.KauntaApp
import com.kaunta.app.domain.model.CounterSettings
import com.kaunta.app.domain.model.CounterState
import com.kaunta.app.domain.model.VolumeKeyMode
import com.kaunta.app.tts.CounterTts
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

data class MainUiState(
    val counterState: CounterState = CounterState(),
    val settings: CounterSettings = CounterSettings(),
    val showMemoDialog: Boolean = false,
    val pendingAchievementCount: Int = 0,
    val pendingAchievementTarget: Int = 0
)

class MainViewModel(application: Application) : AndroidViewModel(application) {

    private val app get() = getApplication<KauntaApp>()

    private val _uiState = MutableStateFlow(MainUiState())
    val uiState: StateFlow<MainUiState> = _uiState.asStateFlow()

    // TTS is held here so it survives recompositions and isn't created on the Composition thread
    private var tts: CounterTts? = null

    fun ensureTts() {
        if (tts == null) tts = CounterTts(getApplication())
    }

    fun speakCount(count: Int) = tts?.speak(count)

    var onGoalReached: (() -> Unit)? = null

    init {
        viewModelScope.launch {
            combine(
                app.counterRepository.counterStateFlow,
                app.counterRepository.settingsFlow
            ) { state, settings -> state to settings }
                .collect { (state, settings) ->
                    _uiState.update { it.copy(counterState = state, settings = settings) }
                }
        }
    }

    fun increment() {
        viewModelScope.launch {
            val result = app.updateCounterUseCase.increment()
            if (result.shouldSpeak) speakCount(result.newCount)
            if (result.goalJustReached) {
                val settings = app.counterRepository.getSettings()
                app.goalNotifier.notify(settings.goalNotificationMode, settings.notificationSoundUri)
                if (settings.showMemoDialogOnAchievement) {
                    _uiState.update {
                        it.copy(
                            showMemoDialog = true,
                            pendingAchievementCount = result.newCount,
                            pendingAchievementTarget = settings.targetCount
                        )
                    }
                } else {
                    // Skip dialog: auto-save with empty memo
                    app.saveAchievementUseCase.execute(settings.targetCount, result.newCount, "")
                }
            }
        }
    }

    fun decrement() {
        viewModelScope.launch {
            app.updateCounterUseCase.decrement()
        }
    }

    fun reset() {
        viewModelScope.launch {
            app.resetCounterUseCase.execute()
        }
    }

    fun saveMemo(memo: String) {
        viewModelScope.launch {
            val count = _uiState.value.pendingAchievementCount
            val target = _uiState.value.pendingAchievementTarget
            app.saveAchievementUseCase.execute(target, count, memo)
            _uiState.update { it.copy(showMemoDialog = false) }
        }
    }

    fun dismissMemoDialog() {
        viewModelScope.launch {
            val count = _uiState.value.pendingAchievementCount
            val target = _uiState.value.pendingAchievementTarget
            app.saveAchievementUseCase.execute(target, count, "")
            _uiState.update { it.copy(showMemoDialog = false) }
        }
    }

    override fun onCleared() {
        super.onCleared()
        tts?.shutdown()
    }

    fun onVolumeKeyEvent(isUp: Boolean) {
        val mode = _uiState.value.settings.volumeKeyMode
        val shouldIncrement = when (mode) {
            VolumeKeyMode.NORMAL -> isUp
            VolumeKeyMode.REVERSED -> !isUp
        }
        if (shouldIncrement) increment() else decrement()
    }
}
