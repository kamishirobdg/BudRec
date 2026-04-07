package com.kaunta.app.data.repository

import com.kaunta.app.data.datastore.AppPreferences
import com.kaunta.app.domain.model.CounterSettings
import com.kaunta.app.domain.model.CounterState
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.first

class CounterRepository(private val prefs: AppPreferences) {

    val counterStateFlow: Flow<CounterState> = prefs.counterStateFlow
    val settingsFlow: Flow<CounterSettings> = prefs.settingsFlow

    suspend fun getCounterState(): CounterState = prefs.counterStateFlow.first()
    suspend fun getSettings(): CounterSettings = prefs.settingsFlow.first()

    suspend fun saveCounterState(state: CounterState) = prefs.saveCounterState(state)
    suspend fun saveSettings(settings: CounterSettings) = prefs.saveSettings(settings)
}
