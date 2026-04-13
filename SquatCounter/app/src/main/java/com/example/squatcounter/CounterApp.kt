package com.example.squatcounter

import android.app.Application
import com.example.squatcounter.audio.NotificationPlayer
import com.example.squatcounter.audio.SquatSoundPlayer
import com.example.squatcounter.audio.TtsManager
import com.example.squatcounter.data.HistoryDatabase
import com.example.squatcounter.data.PreferencesRepository

class CounterApp : Application() {
    val db by lazy { HistoryDatabase.getInstance(this) }
    val prefsRepo by lazy { PreferencesRepository(this) }
    val squatSoundPlayer by lazy { SquatSoundPlayer(this) }
    val ttsManager by lazy { TtsManager(this) }
    val notificationPlayer by lazy { NotificationPlayer(this) }
}
