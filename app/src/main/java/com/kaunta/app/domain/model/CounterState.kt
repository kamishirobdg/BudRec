package com.kaunta.app.domain.model

data class CounterState(
    val currentCount: Int = 0,
    val hasReachedTargetInCurrentSession: Boolean = false
)
