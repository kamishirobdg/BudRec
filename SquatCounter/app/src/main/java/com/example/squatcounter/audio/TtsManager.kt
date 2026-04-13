package com.example.squatcounter.audio

import android.content.Context
import android.media.AudioManager
import android.os.Bundle
import android.speech.tts.TextToSpeech
import android.util.Log
import java.util.Locale

class TtsManager(context: Context) {

    private var tts: TextToSpeech? = null
    private var isReady = false
    private var pendingText: String? = null
    private var currentLocale: Locale = Locale.getDefault()

    init {
        tts = TextToSpeech(context) { status ->
            if (status == TextToSpeech.SUCCESS) {
                isReady = true
                tts?.language = currentLocale
                pendingText?.let { speak(it) }
                pendingText = null
            } else {
                Log.w("TtsManager", "TTS init failed: $status")
            }
        }
    }

    fun setLanguage(bcp47: String) {
        currentLocale = if (bcp47.isEmpty()) Locale.getDefault() else Locale.forLanguageTag(bcp47)
        if (isReady) tts?.language = currentLocale
    }

    fun speak(text: String) {
        if (!isReady) {
            pendingText = text
            return
        }
        val params = Bundle().apply {
            putInt(TextToSpeech.Engine.KEY_PARAM_STREAM, AudioManager.STREAM_ALARM)
        }
        tts?.speak(text, TextToSpeech.QUEUE_ADD, params, null)
    }

    fun getAvailableLocales(): List<Locale> {
        return tts?.availableLanguages
            ?.sortedBy { it.displayName }
            ?: emptyList()
    }

    fun shutdown() {
        tts?.stop()
        tts?.shutdown()
        tts = null
        isReady = false
    }
}
