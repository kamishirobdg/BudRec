package com.example.squatcounter.audio

import android.content.Context
import android.media.AudioAttributes
import android.media.RingtoneManager
import android.net.Uri
import android.os.*
import com.example.squatcounter.data.NotificationMode

class NotificationPlayer(private val context: Context) {

    @Suppress("DEPRECATION")
    fun notify(mode: NotificationMode, soundUri: String, volume: Float) {
        when (mode) {
            NotificationMode.OFF -> return
            NotificationMode.SOUND_ONLY -> playSound(soundUri, volume)
            NotificationMode.VIBRATION_ONLY -> vibrate()
            NotificationMode.SOUND_AND_VIBRATION -> {
                playSound(soundUri, volume)
                vibrate()
            }
        }
    }

    private fun playSound(uriString: String, volume: Float) {
        val uri: Uri = if (uriString.isNotEmpty()) {
            Uri.parse(uriString)
        } else {
            RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION)
        }
        val ringtone = RingtoneManager.getRingtone(context, uri) ?: return
        ringtone.audioAttributes = AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_ALARM)
            .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
            .build()
        ringtone.volume = volume
        ringtone.play()
    }

    private fun vibrate() {
        val vibrator = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            val vm = context.getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as VibratorManager
            vm.defaultVibrator
        } else {
            @Suppress("DEPRECATION")
            context.getSystemService(Context.VIBRATOR_SERVICE) as Vibrator
        }
        vibrator.vibrate(VibrationEffect.createOneShot(500, VibrationEffect.DEFAULT_AMPLITUDE))
    }
}
