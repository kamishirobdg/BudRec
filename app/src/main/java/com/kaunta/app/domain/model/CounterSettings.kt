package com.kaunta.app.domain.model

data class CounterSettings(
    val targetCount: Int = 10,
    val countStep: Int = 1,
    val volumeKeyMode: VolumeKeyMode = VolumeKeyMode.NORMAL,
    val goalNotificationMode: GoalNotificationMode = GoalNotificationMode.SOUND_AND_VIBRATION,
    val notificationSoundUri: String = "",
    val speechInterval: SpeechInterval = SpeechInterval.OFF,
    val showMemoDialogOnAchievement: Boolean = true
)
