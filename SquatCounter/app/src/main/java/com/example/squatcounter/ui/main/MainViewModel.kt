package com.example.squatcounter.ui.main

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.example.squatcounter.CounterApp
import com.example.squatcounter.data.*
import kotlinx.coroutines.flow.*
import kotlinx.coroutines.launch

data class MainUiState(
    val count: Int = 0,
    val settings: AppSettings = AppSettings(),
    val isSequencePlaying: Boolean = false,
    val isGoalAchieved: Boolean = false,   // count >= goal
    val showMemoDialog: Boolean = false,
    val pendingMemoHistoryId: Long? = null
)

class MainViewModel(app: Application) : AndroidViewModel(app) {

    private val application = app as CounterApp
    private val dao = application.db.historyDao()
    private val prefsRepo = application.prefsRepo
    private val squatPlayer = application.squatSoundPlayer
    private val tts = application.ttsManager
    private val notificationPlayer = application.notificationPlayer

    private val _uiState = MutableStateFlow(MainUiState())
    val uiState: StateFlow<MainUiState> = _uiState.asStateFlow()

    // session state (not in UI state)
    private var currentHistoryId: Long? = null
    private var achievedAt: Long? = null
    private var savedFinalCount: Int = 0
    private var hasAchievedGoal: Boolean = false
    private var pendingTtsCount: Int? = null

    init {
        viewModelScope.launch {
            prefsRepo.settingsFlow.collect { settings ->
                _uiState.update { it.copy(settings = settings) }
                tts.setLanguage(settings.readAloudLanguageBcp47)
            }
        }
    }

    fun increment() {
        var newCount = -1
        _uiState.update { current ->
            if (current.isSequencePlaying) return@update current
            val next = current.count + 1
            newCount = next
            current.copy(count = next)
        }
        if (newCount < 0) return  // isSequencePlaying だったので何もしない
        handleCountChange(newCount)
        if (_uiState.value.settings.squatAssistEnabled) {
            launchSquatSequence()
        }
    }

    fun decrement() {
        _uiState.update { current ->
            if (current.isSequencePlaying || current.count == 0) return@update current
            current.copy(count = current.count - 1)
        }
        // デクリメントはシーケンス発動なし
    }

    fun reset() {
        if (_uiState.value.isSequencePlaying) return
        val count = _uiState.value.count
        if (count == 0) return

        val goal = _uiState.value.settings.goalCount
        val now = System.currentTimeMillis()

        viewModelScope.launch {
            if (hasAchievedGoal && currentHistoryId != null) {
                // 到達後にカウントが増えていれば上書き
                if (count > savedFinalCount) {
                    dao.updateFinalCount(currentHistoryId!!, count, now)
                }
            } else if (!hasAchievedGoal && count > 0) {
                // 未達レコードとして保存
                dao.insert(
                    HistoryEntity(
                        createdAt = now,
                        updatedAt = now,
                        goal = goal,
                        finalCount = count,
                        memo = null,
                        isAchieved = false
                    )
                )
            }
        }

        _uiState.update {
            it.copy(count = 0, isGoalAchieved = false)
        }
        hasAchievedGoal = false
        currentHistoryId = null
        achievedAt = null
        savedFinalCount = 0
    }

    fun dismissMemoDialog(memo: String?) {
        val id = _uiState.value.pendingMemoHistoryId ?: return
        _uiState.update { it.copy(showMemoDialog = false, pendingMemoHistoryId = null) }
        if (memo != null) {
            viewModelScope.launch {
                dao.updateMemo(id, memo, System.currentTimeMillis())
            }
        }
    }

    private fun handleCountChange(count: Int) {
        val settings = _uiState.value.settings
        val goal = settings.goalCount
        val achieved = count >= goal

        // count と isGoalAchieved を1回の update で同期（中間状態をComposeに見せない）
        _uiState.update { it.copy(count = count, isGoalAchieved = achieved) }

        // 目標到達（初回のみ）
        if (achieved && !hasAchievedGoal) {
            hasAchievedGoal = true
            val now = System.currentTimeMillis()
            achievedAt = now
            viewModelScope.launch {
                val id = dao.insert(
                    HistoryEntity(
                        createdAt = now,
                        updatedAt = now,
                        goal = goal,
                        finalCount = count,
                        memo = null,
                        isAchieved = true
                    )
                )
                currentHistoryId = id
                savedFinalCount = count
                notificationPlayer.notify(settings.notificationMode, settings.notificationSoundUri, settings.appVolume)
                if (settings.requireMemoOnAchieve) {
                    _uiState.update { it.copy(showMemoDialog = true, pendingMemoHistoryId = id) }
                }
            }
        }

        // 読み上げ
        val shouldSpeak = when (settings.readAloudMode) {
            ReadAloudMode.OFF -> false
            ReadAloudMode.EVERY_1 -> true
            ReadAloudMode.EVERY_5 -> count % 5 == 0
            ReadAloudMode.EVERY_10 -> count % 10 == 0
        }
        if (shouldSpeak) {
            if (settings.squatAssistEnabled) {
                pendingTtsCount = count
            } else {
                tts.speak(count.toString())
            }
        }
    }

    private fun launchSquatSequence() {
        val settings = _uiState.value.settings
        _uiState.update { it.copy(isSequencePlaying = true) }
        viewModelScope.launch {
            squatPlayer.playSequence(
                downSound = settings.squatSoundDown,
                holdSound = settings.squatSoundHold,
                upSound = settings.squatSoundUp,
                volume = settings.appVolume
            )
            _uiState.update { it.copy(isSequencePlaying = false) }
            // シーケンス完了後に読み上げ
            pendingTtsCount?.let { c ->
                tts.speak(c.toString())
                pendingTtsCount = null
            }
        }
    }
}
