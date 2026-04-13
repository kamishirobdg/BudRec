package com.example.squatcounter.data

import android.content.Context
import androidx.datastore.preferences.core.*
import androidx.datastore.preferences.preferencesDataStore
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map

private val Context.dataStore by preferencesDataStore(name = "app_settings")

class PreferencesRepository(private val context: Context) {

    companion object {
        val KEY_GOAL_COUNT = intPreferencesKey("goal_count")
        val KEY_REQUIRE_MEMO = booleanPreferencesKey("require_memo")
        val KEY_INVERT_VOLUME = booleanPreferencesKey("invert_volume")
        val KEY_NOTIFICATION_MODE = stringPreferencesKey("notification_mode")
        val KEY_NOTIFICATION_SOUND_URI = stringPreferencesKey("notification_sound_uri")
        val KEY_APP_VOLUME = floatPreferencesKey("app_volume")
        val KEY_READ_ALOUD_MODE = stringPreferencesKey("read_aloud_mode")
        val KEY_READ_ALOUD_LANGUAGE = stringPreferencesKey("read_aloud_language")
        val KEY_SQUAT_ASSIST = booleanPreferencesKey("squat_assist")
        val KEY_SQUAT_SOUND_DOWN = stringPreferencesKey("squat_sound_down")
        val KEY_SQUAT_SOUND_HOLD = stringPreferencesKey("squat_sound_hold")
        val KEY_SQUAT_SOUND_UP = stringPreferencesKey("squat_sound_up")
    }

    val settingsFlow: Flow<AppSettings> = context.dataStore.data.map { prefs ->
        prefs.toAppSettings()
    }

    suspend fun update(block: suspend (AppSettings) -> AppSettings) {
        context.dataStore.updateData { prefs ->
            val updated = block(prefs.toAppSettings())
            prefs.toMutablePreferences().apply {
                set(KEY_GOAL_COUNT, updated.goalCount)
                set(KEY_REQUIRE_MEMO, updated.requireMemoOnAchieve)
                set(KEY_INVERT_VOLUME, updated.invertVolumeKeys)
                set(KEY_NOTIFICATION_MODE, updated.notificationMode.name)
                set(KEY_NOTIFICATION_SOUND_URI, updated.notificationSoundUri)
                set(KEY_APP_VOLUME, updated.appVolume)
                set(KEY_READ_ALOUD_MODE, updated.readAloudMode.name)
                set(KEY_READ_ALOUD_LANGUAGE, updated.readAloudLanguageBcp47)
                set(KEY_SQUAT_ASSIST, updated.squatAssistEnabled)
                set(KEY_SQUAT_SOUND_DOWN, updated.squatSoundDown.name)
                set(KEY_SQUAT_SOUND_HOLD, updated.squatSoundHold.name)
                set(KEY_SQUAT_SOUND_UP, updated.squatSoundUp.name)
            }
        }
    }

    private fun Preferences.toAppSettings() = AppSettings(
        goalCount = this[KEY_GOAL_COUNT] ?: 80,
        requireMemoOnAchieve = this[KEY_REQUIRE_MEMO] ?: false,
        invertVolumeKeys = this[KEY_INVERT_VOLUME] ?: false,
        notificationMode = this[KEY_NOTIFICATION_MODE]
            ?.let { runCatching { NotificationMode.valueOf(it) }.getOrNull() }
            ?: NotificationMode.SOUND_AND_VIBRATION,
        notificationSoundUri = this[KEY_NOTIFICATION_SOUND_URI] ?: "",
        appVolume = this[KEY_APP_VOLUME] ?: 0.8f,
        readAloudMode = this[KEY_READ_ALOUD_MODE]
            ?.let { runCatching { ReadAloudMode.valueOf(it) }.getOrNull() }
            ?: ReadAloudMode.EVERY_5,
        readAloudLanguageBcp47 = this[KEY_READ_ALOUD_LANGUAGE] ?: "",
        squatAssistEnabled = this[KEY_SQUAT_ASSIST] ?: false,
        squatSoundDown = this[KEY_SQUAT_SOUND_DOWN]
            ?.let { runCatching { SoundType.valueOf(it) }.getOrNull() }
            ?: SoundType.BEEP_LOW,
        squatSoundHold = this[KEY_SQUAT_SOUND_HOLD]
            ?.let { runCatching { SoundType.valueOf(it) }.getOrNull() }
            ?: SoundType.CLICK,
        squatSoundUp = this[KEY_SQUAT_SOUND_UP]
            ?.let { runCatching { SoundType.valueOf(it) }.getOrNull() }
            ?: SoundType.BEEP_HIGH
    )
}
