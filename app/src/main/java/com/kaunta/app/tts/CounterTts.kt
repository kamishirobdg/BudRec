package com.kaunta.app.tts

import android.content.Context
import android.speech.tts.TextToSpeech
import java.util.Locale

class CounterTts(context: Context) : TextToSpeech.OnInitListener {

    private val tts: TextToSpeech = TextToSpeech(context, this)
    private var isReady = false

    override fun onInit(status: Int) {
        if (status == TextToSpeech.SUCCESS) {
            val result = tts.setLanguage(Locale.JAPAN)
            isReady = result != TextToSpeech.LANG_MISSING_DATA &&
                    result != TextToSpeech.LANG_NOT_SUPPORTED
        }
    }

    fun speak(count: Int) {
        if (!isReady) return
        tts.speak(count.toString(), TextToSpeech.QUEUE_FLUSH, null, "kaunta_$count")
    }

    fun shutdown() {
        tts.stop()
        tts.shutdown()
        isReady = false
    }
}
