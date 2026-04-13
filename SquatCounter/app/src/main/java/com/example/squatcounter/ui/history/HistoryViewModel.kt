package com.example.squatcounter.ui.history

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.example.squatcounter.CounterApp
import com.example.squatcounter.data.HistoryEntity
import kotlinx.coroutines.flow.*
import kotlinx.coroutines.launch
import java.util.Calendar

data class WeekGroup(
    val year: Int,
    val month: Int,
    val weekOfMonth: Int,
    val records: List<HistoryEntity>
) {
    val label: String get() = "${month}月${weekOfMonth}週"
    val count: Int get() = records.size
}

class HistoryViewModel(app: Application) : AndroidViewModel(app) {

    private val dao = (app as CounterApp).db.historyDao()

    val groups: StateFlow<List<WeekGroup>> = dao.getAllFlow()
        .map { list -> list.groupByWeek() }
        .stateIn(viewModelScope, SharingStarted.Eagerly, emptyList())

    fun deleteRecord(id: Long) {
        viewModelScope.launch { dao.deleteById(id) }
    }

    fun deleteAll() {
        viewModelScope.launch { dao.deleteAll() }
    }

    private fun List<HistoryEntity>.groupByWeek(): List<WeekGroup> {
        val cal = Calendar.getInstance()
        return groupBy { entity ->
            cal.timeInMillis = entity.createdAt
            Triple(
                cal.get(Calendar.YEAR),
                cal.get(Calendar.MONTH) + 1,
                cal.get(Calendar.WEEK_OF_MONTH)
            )
        }.map { (key, records) ->
            WeekGroup(
                year = key.first,
                month = key.second,
                weekOfMonth = key.third,
                records = records.sortedByDescending { it.createdAt }
            )
        }.sortedByDescending { it.records.first().createdAt }
    }
}
