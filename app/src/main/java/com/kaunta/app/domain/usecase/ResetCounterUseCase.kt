package com.kaunta.app.domain.usecase

import com.kaunta.app.data.repository.CounterRepository
import com.kaunta.app.domain.model.CounterState

class ResetCounterUseCase(private val repository: CounterRepository) {

    suspend fun execute() {
        repository.saveCounterState(
            CounterState(currentCount = 0, hasReachedTargetInCurrentSession = false)
        )
    }
}
