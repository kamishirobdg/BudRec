package com.kaunta.app.domain

import com.kaunta.app.domain.model.SpeechInterval
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SpeechIntervalTest {

    @Test
    fun `OFF never speaks`() {
        listOf(1, 5, 10, 100).forEach {
            assertFalse(SpeechInterval.OFF.shouldSpeak(it))
        }
    }

    @Test
    fun `EVERY_1 always speaks on increment`() {
        listOf(1, 2, 3, 7, 11).forEach {
            assertTrue(SpeechInterval.EVERY_1.shouldSpeak(it))
        }
    }

    @Test
    fun `EVERY_5 speaks only on multiples of 5`() {
        assertTrue(SpeechInterval.EVERY_5.shouldSpeak(5))
        assertTrue(SpeechInterval.EVERY_5.shouldSpeak(10))
        assertTrue(SpeechInterval.EVERY_5.shouldSpeak(15))
        assertFalse(SpeechInterval.EVERY_5.shouldSpeak(1))
        assertFalse(SpeechInterval.EVERY_5.shouldSpeak(3))
        assertFalse(SpeechInterval.EVERY_5.shouldSpeak(11))
    }

    @Test
    fun `EVERY_10 speaks only on multiples of 10`() {
        assertTrue(SpeechInterval.EVERY_10.shouldSpeak(10))
        assertTrue(SpeechInterval.EVERY_10.shouldSpeak(20))
        assertTrue(SpeechInterval.EVERY_10.shouldSpeak(100))
        assertFalse(SpeechInterval.EVERY_10.shouldSpeak(5))
        assertFalse(SpeechInterval.EVERY_10.shouldSpeak(9))
        assertFalse(SpeechInterval.EVERY_10.shouldSpeak(11))
    }
}
