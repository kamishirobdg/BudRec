package com.kaunta.app.domain.usecase

import com.kaunta.app.data.repository.CounterRepository
import com.kaunta.app.domain.model.CounterUpdateResult

class UpdateCounterUseCase(private val repository: CounterRepository) {

    suspend fun increment(): CounterUpdateResult {
        val state = repository.getCounterState()
        val settings = repository.getSettings()
        val newCount = state.currentCount + settings.countStep
        val goalJustReached = !state.hasReachedTargetInCurrentSession &&
                newCount >= settings.targetCount
        val newHasReached = state.hasReachedTargetInCurrentSession || goalJustReached
        repository.saveCounterState(
            state.copy(
                currentCount = newCount,
                hasReachedTargetInCurrentSession = newHasReached
            )
        )
        val shouldSpeak = settings.speechInterval.shouldSpeak(newCount)
        return CounterUpdateResult(
            newCount = newCount,
            goalJustReached = goalJustReached,
            shouldSpeak = shouldSpeak
        )
    }

    suspend fun decrement(): CounterUpdateResult {
        val state = repository.getCounterState()
        val settings = repository.getSettings()
        val newCount = maxOf(0, state.currentCount - settings.countStep)
        repository.saveCounterState(state.copy(currentCount = newCount))
        return CounterUpdateResult(
            newCount = newCount,
            goalJustReached = false,
            shouldSpeak = false
        )
    }
}
