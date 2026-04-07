package com.kaunta.app

import android.app.Application
import com.kaunta.app.data.datastore.AppPreferences
import com.kaunta.app.data.local.AppDatabase
import com.kaunta.app.data.repository.CounterRepository
import com.kaunta.app.data.repository.HistoryRepository
import com.kaunta.app.domain.usecase.ResetCounterUseCase
import com.kaunta.app.domain.usecase.SaveAchievementUseCase
import com.kaunta.app.domain.usecase.UpdateCounterUseCase
import com.kaunta.app.notification.GoalNotifier

class KauntaApp : Application() {

    val appPreferences by lazy { AppPreferences(this) }
    val database by lazy { AppDatabase.getInstance(this) }

    val counterRepository by lazy { CounterRepository(appPreferences) }
    val historyRepository by lazy { HistoryRepository(database.achievementDao()) }

    val updateCounterUseCase by lazy { UpdateCounterUseCase(counterRepository) }
    val resetCounterUseCase by lazy { ResetCounterUseCase(counterRepository) }
    val saveAchievementUseCase by lazy { SaveAchievementUseCase(historyRepository) }

    val goalNotifier by lazy { GoalNotifier(this) }
}
