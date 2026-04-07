package com.kaunta.app.domain.model

enum class VolumeKeyMode {
    NORMAL,   // UP = +step, DOWN = -step
    REVERSED  // UP = -step, DOWN = +step
}

enum class GoalNotificationMode {
    OFF,
    SOUND_ONLY,
    VIBRATION_ONLY,
    SOUND_AND_VIBRATION
}

enum class SpeechInterval {
    OFF,
    EVERY_1,
    EVERY_5,
    EVERY_10;

    fun shouldSpeak(count: Int): Boolean = when (this) {
        OFF -> false
        EVERY_1 -> true
        EVERY_5 -> count % 5 == 0
        EVERY_10 -> count % 10 == 0
    }
}
