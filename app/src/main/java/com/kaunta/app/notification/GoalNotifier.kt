package com.kaunta.app.notification

import android.content.Context
import android.media.AudioAttributes
import android.media.MediaPlayer
import android.media.RingtoneManager
import android.net.Uri
import android.os.Build
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import com.kaunta.app.domain.model.GoalNotificationMode

class GoalNotifier(private val context: Context) {

    fun notify(mode: GoalNotificationMode, soundUriString: String) {
        when (mode) {
            GoalNotificationMode.OFF -> return
            GoalNotificationMode.SOUND_ONLY -> playSound(soundUriString)
            GoalNotificationMode.VIBRATION_ONLY -> vibrate()
            GoalNotificationMode.SOUND_AND_VIBRATION -> {
                playSound(soundUriString)
                vibrate()
            }
        }
    }

    private fun playSound(uriString: String) {
        val uri: Uri = if (uriString.isNotEmpty()) {
            runCatching { Uri.parse(uriString) }.getOrNull()
                ?: RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION)
        } else {
            RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION)
        }

        runCatching {
            MediaPlayer().apply {
                setAudioAttributes(
                    AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_NOTIFICATION)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                        .build()
                )
                setDataSource(context, uri)
                setOnCompletionListener { release() }
                prepare()
                start()
            }
        }
    }

    private fun vibrate() {
        val vibrator = getVibrator()
        // Short two-pulse vibration: 100ms on, 100ms off, 100ms on
        val effect = VibrationEffect.createWaveform(
            longArrayOf(0, 100, 100, 100),
            intArrayOf(0, VibrationEffect.DEFAULT_AMPLITUDE, 0, VibrationEffect.DEFAULT_AMPLITUDE),
            -1
        )
        vibrator.vibrate(effect)
    }

    private fun getVibrator(): Vibrator {
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            val vm = context.getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as VibratorManager
            vm.defaultVibrator
        } else {
            @Suppress("DEPRECATION")
            context.getSystemService(Context.VIBRATOR_SERVICE) as Vibrator
        }
    }
}
