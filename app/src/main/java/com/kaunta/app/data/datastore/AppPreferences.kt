package com.kaunta.app.data.datastore

import android.content.Context
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.intPreferencesKey
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import com.kaunta.app.domain.model.CounterSettings
import com.kaunta.app.domain.model.CounterState
import com.kaunta.app.domain.model.GoalNotificationMode
import com.kaunta.app.domain.model.SpeechInterval
import com.kaunta.app.domain.model.VolumeKeyMode
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map

private val Context.dataStore: DataStore<Preferences> by preferencesDataStore(name = "kaunta_prefs")

class AppPreferences(private val context: Context) {

    private object Keys {
        val CURRENT_COUNT = intPreferencesKey("current_count")
        val HAS_REACHED_TARGET = booleanPreferencesKey("has_reached_target")
        val TARGET_COUNT = intPreferencesKey("target_count")
        val COUNT_STEP = intPreferencesKey("count_step")
        val VOLUME_KEY_MODE = stringPreferencesKey("volume_key_mode")
        val GOAL_NOTIFICATION_MODE = stringPreferencesKey("goal_notification_mode")
        val NOTIFICATION_SOUND_URI = stringPreferencesKey("notification_sound_uri")
        val SPEECH_INTERVAL = stringPreferencesKey("speech_interval")
        val SHOW_MEMO_DIALOG = booleanPreferencesKey("show_memo_dialog_on_achievement")
    }

    val counterStateFlow: Flow<CounterState> = context.dataStore.data.map { prefs ->
        CounterState(
            currentCount = prefs[Keys.CURRENT_COUNT] ?: 0,
            hasReachedTargetInCurrentSession = prefs[Keys.HAS_REACHED_TARGET] ?: false
        )
    }

    val settingsFlow: Flow<CounterSettings> = context.dataStore.data.map { prefs ->
        CounterSettings(
            targetCount = prefs[Keys.TARGET_COUNT] ?: 10,
            countStep = prefs[Keys.COUNT_STEP] ?: 1,
            volumeKeyMode = prefs[Keys.VOLUME_KEY_MODE]
                ?.let { runCatching { VolumeKeyMode.valueOf(it) }.getOrNull() }
                ?: VolumeKeyMode.NORMAL,
            goalNotificationMode = prefs[Keys.GOAL_NOTIFICATION_MODE]
                ?.let { runCatching { GoalNotificationMode.valueOf(it) }.getOrNull() }
                ?: GoalNotificationMode.SOUND_AND_VIBRATION,
            notificationSoundUri = prefs[Keys.NOTIFICATION_SOUND_URI] ?: "",
            speechInterval = prefs[Keys.SPEECH_INTERVAL]
                ?.let { runCatching { SpeechInterval.valueOf(it) }.getOrNull() }
                ?: SpeechInterval.OFF,
            showMemoDialogOnAchievement = prefs[Keys.SHOW_MEMO_DIALOG] ?: true
        )
    }

    suspend fun saveCounterState(state: CounterState) {
        context.dataStore.edit { prefs ->
            prefs[Keys.CURRENT_COUNT] = state.currentCount
            prefs[Keys.HAS_REACHED_TARGET] = state.hasReachedTargetInCurrentSession
        }
    }

    suspend fun saveSettings(settings: CounterSettings) {
        context.dataStore.edit { prefs ->
            prefs[Keys.TARGET_COUNT] = settings.targetCount
            prefs[Keys.COUNT_STEP] = settings.countStep
            prefs[Keys.VOLUME_KEY_MODE] = settings.volumeKeyMode.name
            prefs[Keys.GOAL_NOTIFICATION_MODE] = settings.goalNotificationMode.name
            prefs[Keys.NOTIFICATION_SOUND_URI] = settings.notificationSoundUri
            prefs[Keys.SPEECH_INTERVAL] = settings.speechInterval.name
            prefs[Keys.SHOW_MEMO_DIALOG] = settings.showMemoDialogOnAchievement
        }
    }
}
