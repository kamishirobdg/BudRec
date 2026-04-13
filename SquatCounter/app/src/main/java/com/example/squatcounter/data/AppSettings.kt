package com.example.squatcounter.data

enum class NotificationMode { OFF, SOUND_ONLY, VIBRATION_ONLY, SOUND_AND_VIBRATION }
enum class ReadAloudMode { OFF, EVERY_1, EVERY_5, EVERY_10 }
enum class SoundType {
    BEEP_LOW, BEEP_HIGH, CLICK, BEEP_LOW_SOFT, BEEP_HIGH_SOFT,
    METRONOME_4BEAT, METRONOME_NOISE, SWEEP_UP, SWEEP_DOWN,
    SILENT
}

data class AppSettings(
    val goalCount: Int = 80,
    val requireMemoOnAchieve: Boolean = false,
    val invertVolumeKeys: Boolean = false,
    val notificationMode: NotificationMode = NotificationMode.SOUND_AND_VIBRATION,
    val notificationSoundUri: String = "",
    val appVolume: Float = 0.8f,
    val readAloudMode: ReadAloudMode = ReadAloudMode.EVERY_5,
    val readAloudLanguageBcp47: String = "",
    val squatAssistEnabled: Boolean = false,
    val squatSoundDown: SoundType = SoundType.BEEP_LOW,
    val squatSoundHold: SoundType = SoundType.CLICK,
    val squatSoundUp: SoundType = SoundType.BEEP_HIGH
)
