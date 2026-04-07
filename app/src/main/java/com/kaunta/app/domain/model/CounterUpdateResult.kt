package com.kaunta.app.domain.model

data class CounterUpdateResult(
    val newCount: Int,
    val goalJustReached: Boolean,
    val shouldSpeak: Boolean
)
