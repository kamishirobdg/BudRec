package com.kaunta.app.ui.history

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.kaunta.app.KauntaApp
import com.kaunta.app.data.local.entity.AchievementEntity
import com.kaunta.app.domain.aggregation.HistoryAggregator
import com.kaunta.app.domain.model.HistoryAggregationItem
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

sealed class HistoryNavState {
    object TopLevel : HistoryNavState()
    data class YearDetail(val year: Int) : HistoryNavState()
    data class MonthDetail(val year: Int, val month: Int) : HistoryNavState()
    data class WeekDetail(val year: Int, val month: Int, val weekOfMonth: Int) : HistoryNavState()
    data class RecordDetail(val id: Long) : HistoryNavState()
}

data class HistoryUiState(
    val navState: HistoryNavState = HistoryNavState.TopLevel,
    val allRecords: List<AchievementEntity> = emptyList(),
    val displayItems: List<HistoryAggregationItem> = emptyList(),
    val selectedRecord: AchievementEntity? = null,
    val showDeleteAllDialog: Boolean = false,
    val showEditMemoDialog: Boolean = false,
    val editingMemo: String = ""
)

class HistoryViewModel(application: Application) : AndroidViewModel(application) {

    private val repo get() = getApplication<KauntaApp>().historyRepository

    private val _uiState = MutableStateFlow(HistoryUiState())
    val uiState: StateFlow<HistoryUiState> = _uiState.asStateFlow()

    init {
        viewModelScope.launch {
            repo.allHistoryFlow.collect { records ->
                _uiState.update { state ->
                    state.copy(
                        allRecords = records,
                        displayItems = computeDisplayItems(state.navState, records)
                    )
                }
            }
        }
    }

    private fun computeDisplayItems(
        navState: HistoryNavState,
        records: List<AchievementEntity>
    ): List<HistoryAggregationItem> = when (navState) {
        HistoryNavState.TopLevel -> HistoryAggregator.aggregateForTopLevel(records)
        is HistoryNavState.YearDetail ->
            HistoryAggregator.aggregateByMonth(records, navState.year)
        is HistoryNavState.MonthDetail ->
            HistoryAggregator.aggregateByWeek(records, navState.year, navState.month)
        is HistoryNavState.WeekDetail ->
            HistoryAggregator.getWeekRecords(records, navState.year, navState.month, navState.weekOfMonth)
        is HistoryNavState.RecordDetail -> emptyList()
    }

    fun navigateTo(navState: HistoryNavState) {
        val records = _uiState.value.allRecords
        val selected = if (navState is HistoryNavState.RecordDetail) {
            records.find { it.id == navState.id }
        } else null
        _uiState.update {
            it.copy(
                navState = navState,
                displayItems = computeDisplayItems(navState, records),
                selectedRecord = selected
            )
        }
    }

    fun navigateBack(): Boolean {
        val current = _uiState.value.navState
        val parent: HistoryNavState? = when (current) {
            HistoryNavState.TopLevel -> null
            is HistoryNavState.YearDetail -> HistoryNavState.TopLevel
            is HistoryNavState.MonthDetail -> HistoryNavState.YearDetail(current.year)
            is HistoryNavState.WeekDetail -> HistoryNavState.MonthDetail(current.year, current.month)
            is HistoryNavState.RecordDetail -> {
                val records = _uiState.value.allRecords
                val rec = records.find { it.id == current.id }
                if (rec != null) {
                    val date = java.time.Instant.ofEpochMilli(rec.achievedAt)
                        .atZone(java.time.ZoneId.systemDefault()).toLocalDate()
                    val weekFields = java.time.temporal.WeekFields.of(java.time.DayOfWeek.SUNDAY, 1)
                    HistoryNavState.WeekDetail(date.year, date.monthValue, date.get(weekFields.weekOfMonth()))
                } else HistoryNavState.TopLevel
            }
        }
        return if (parent != null) {
            navigateTo(parent)
            true
        } else false
    }

    fun deleteRecord(id: Long) {
        viewModelScope.launch {
            repo.deleteById(id)
            if (_uiState.value.navState is HistoryNavState.RecordDetail) {
                navigateBack()
            }
        }
    }

    fun requestDeleteAll() = _uiState.update { it.copy(showDeleteAllDialog = true) }
    fun cancelDeleteAll() = _uiState.update { it.copy(showDeleteAllDialog = false) }

    fun requestEditMemo() {
        val current = _uiState.value.selectedRecord?.memo ?: ""
        _uiState.update { it.copy(showEditMemoDialog = true, editingMemo = current) }
    }

    fun cancelEditMemo() = _uiState.update { it.copy(showEditMemoDialog = false) }

    fun confirmEditMemo(newMemo: String) {
        val id = (_uiState.value.navState as? HistoryNavState.RecordDetail)?.id ?: return
        viewModelScope.launch {
            repo.updateMemo(id, newMemo)
            // Reflect update immediately in selectedRecord without waiting for Room flow
            _uiState.update { state ->
                state.copy(
                    showEditMemoDialog = false,
                    selectedRecord = state.selectedRecord?.copy(memo = newMemo)
                )
            }
        }
    }

    fun confirmDeleteAll() {
        viewModelScope.launch {
            repo.deleteAll()
            _uiState.update { it.copy(showDeleteAllDialog = false, navState = HistoryNavState.TopLevel) }
        }
    }
}
