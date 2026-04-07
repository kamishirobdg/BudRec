package com.kaunta.app.domain.model

import com.kaunta.app.data.local.entity.AchievementEntity
import java.time.LocalDate

sealed class HistoryAggregationItem {
    data class YearItem(
        val year: Int,
        val count: Int
    ) : HistoryAggregationItem()

    data class MonthItem(
        val year: Int,
        val month: Int,
        val count: Int
    ) : HistoryAggregationItem()

    data class WeekItem(
        val year: Int,
        val month: Int,
        val weekOfMonth: Int,
        val count: Int,
        val weekStart: LocalDate,
        val weekEnd: LocalDate
    ) : HistoryAggregationItem()

    data class DetailItem(
        val entity: AchievementEntity
    ) : HistoryAggregationItem()
}
