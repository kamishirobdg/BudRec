package com.example.squatcounter.audio

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioTrack
import android.media.MediaPlayer
import com.example.squatcounter.R
import com.example.squatcounter.data.SoundType
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import kotlin.math.*

class SquatSoundPlayer(private val context: Context) {

    private val sampleRate = 44100

    private val alarmAttributes = AudioAttributes.Builder()
        .setUsage(AudioAttributes.USAGE_ALARM)
        .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
        .build()

    suspend fun playSequence(
        downSound: SoundType,
        holdSound: SoundType,
        upSound: SoundType,
        volume: Float
    ) {
        playPhase(downSound, 2000, volume)
        playPhase(holdSound, 1000, volume)
        playPhase(upSound, 2000, volume)
    }

    suspend fun previewSound(sound: SoundType, volume: Float) {
        playPhase(sound, 500, volume)
    }

    private suspend fun playPhase(sound: SoundType, durationMs: Int, volume: Float) {
        val rawResId = sound.rawResId()
        if (rawResId != null) {
            playRawResource(rawResId, volume, durationMs)
        } else {
            playGeneratedSound(sound, durationMs, volume)
        }
    }

    // WAVファイルを MediaPlayer で再生。durationMs 経過 or 再生完了で終了。
    // ※ MediaPlayer.create() は内部で prepare() まで済ませるため、その後に
    //    setAudioAttributes() を呼ぶと IllegalStateException が発生して無音になる。
    //    正しい順序: setAudioAttributes → setDataSource → prepare → start
    private suspend fun playRawResource(resId: Int, volume: Float, durationMs: Int) =
        withContext(Dispatchers.IO) {
            val mp = MediaPlayer()
            try {
                mp.setAudioAttributes(alarmAttributes)          // (1) prepare より前
                val afd = context.resources.openRawResourceFd(resId) ?: run {
                    delay(durationMs.toLong())
                    return@withContext
                }
                mp.setDataSource(afd.fileDescriptor, afd.startOffset, afd.length)
                afd.close()
                mp.prepare()                                    // (2) 同期 prepare
                mp.setVolume(volume, volume)
                mp.start()
                delay(durationMs.toLong())
            } finally {
                runCatching { if (mp.isPlaying) mp.stop() }
                mp.release()
            }
        }

    // PCM合成音を AudioTrack で再生
    private suspend fun playGeneratedSound(sound: SoundType, durationMs: Int, volume: Float) =
        withContext(Dispatchers.IO) {
            if (sound == SoundType.SILENT) {
                delay(durationMs.toLong())
                return@withContext
            }
            val samples = generateSamples(sound, durationMs)
            val bufferSize = samples.size * 2
            val track = AudioTrack.Builder()
                .setAudioAttributes(alarmAttributes)
                .setAudioFormat(
                    AudioFormat.Builder()
                        .setSampleRate(sampleRate)
                        .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                        .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
                        .build()
                )
                .setBufferSizeInBytes(bufferSize)
                .setTransferMode(AudioTrack.MODE_STATIC)
                .build()
            track.setVolume(volume)
            track.write(samples, 0, samples.size)
            track.play()
            delay(durationMs.toLong())
            track.stop()
            track.release()
        }

    private fun generateSamples(sound: SoundType, durationMs: Int): ShortArray {
        val numSamples = sampleRate * durationMs / 1000
        return when (sound) {
            SoundType.BEEP_LOW       -> generateSineWithHarmonics(200.0, numSamples)
            SoundType.BEEP_HIGH      -> generateSine(800.0, numSamples, 1.0)
            SoundType.CLICK          -> generateClick(numSamples)
            SoundType.BEEP_LOW_SOFT  -> generateSineFade(150.0, numSamples)
            SoundType.BEEP_HIGH_SOFT -> generateSineFade(1000.0, numSamples)
            else                     -> ShortArray(numSamples) { 0 }
        }
    }

    private fun generateSine(freq: Double, numSamples: Int, amplitude: Double): ShortArray =
        ShortArray(numSamples) { i ->
            (sin(2 * PI * freq * i / sampleRate) * amplitude * Short.MAX_VALUE).toInt().toShort()
        }

    // 基音＋倍音を重ねて聴感上の音量・存在感を高める（低域向け）
    private fun generateSineWithHarmonics(freq: Double, numSamples: Int): ShortArray =
        ShortArray(numSamples) { i ->
            val s = sin(2 * PI * freq * i / sampleRate) * 0.60 +
                    sin(2 * PI * freq * 2 * i / sampleRate) * 0.28 +
                    sin(2 * PI * freq * 3 * i / sampleRate) * 0.12
            (s * Short.MAX_VALUE).toInt().toShort()
        }

    private fun generateClick(numSamples: Int): ShortArray {
        val clickLen = (sampleRate * 0.05).toInt()
        return ShortArray(numSamples) { i ->
            if (i < clickLen) {
                val env = 1.0 - i.toDouble() / clickLen
                (sin(2 * PI * 1000.0 * i / sampleRate) * env * Short.MAX_VALUE).toInt().toShort()
            } else 0
        }
    }

    // フェードイン・フェードアウト付きサイン波
    private fun generateSineFade(freq: Double, numSamples: Int): ShortArray {
        val fadeLen = (sampleRate * 0.15).toInt()
        return ShortArray(numSamples) { i ->
            val env = when {
                i < fadeLen              -> i.toDouble() / fadeLen
                i > numSamples - fadeLen -> (numSamples - i).toDouble() / fadeLen
                else                     -> 1.0
            }
            (sin(2 * PI * freq * i / sampleRate) * env * Short.MAX_VALUE).toInt().toShort()
        }
    }
}

// WAVファイルと SoundType のマッピング（null = PCM合成）
private fun SoundType.rawResId(): Int? = when (this) {
    SoundType.METRONOME_4BEAT -> R.raw.metronome_120bpm_4beat
    SoundType.METRONOME_NOISE -> R.raw.metronome_noise_05
    SoundType.SWEEP_UP        -> R.raw.sweep_major_up
    SoundType.SWEEP_DOWN      -> R.raw.sweep_major_down
    else                      -> null
}
