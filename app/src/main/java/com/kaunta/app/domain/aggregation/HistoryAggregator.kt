package com.kaunta.app.domain.aggregation

import com.kaunta.app.data.local.entity.AchievementEntity
import com.kaunta.app.domain.model.HistoryAggregationItem
import java.time.DayOfWeek
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.temporal.TemporalAdjusters
import java.time.temporal.WeekFields

object HistoryAggregator {

    private val weekFields = WeekFields.of(DayOfWeek.SUNDAY, 1)

    /**
     * Aggregates history records for the top-level view.
     * - Records from before this year → grouped by year
     * - Records from this year but before this month → grouped by month
     * - Records from this month but before this week → grouped by week
     * - Records from this week (Sunday–Saturday) → individual items
     */
    fun aggregateForTopLevel(
        records: List<AchievementEntity>,
        today: LocalDate = LocalDate.now()
    ): List<HistoryAggregationItem> {
        if (records.isEmpty()) return emptyList()

        val currentYear = today.year
        val currentMonth = today.monthValue
        val currentWeekStart = today.with(TemporalAdjusters.previousOrSame(DayOfWeek.SUNDAY))
        val currentWeekEnd = currentWeekStart.plusDays(6)

        val result = mutableListOf<HistoryAggregationItem>()

        // This week: individual items (most recent first)
        val thisWeekRecords = records.filter { entity ->
            val date = entity.toLocalDate()
            !date.isBefore(currentWeekStart) && !date.isAfter(currentWeekEnd)
        }
        thisWeekRecords.forEach { result.add(HistoryAggregationItem.DetailItem(it)) }

        // This month, before this week: grouped by week
        val thisMonthBeforeThisWeekRecords = records.filter { entity ->
            val date = entity.toLocalDate()
            date.year == currentYear &&
                    date.monthValue == currentMonth &&
                    date.isBefore(currentWeekStart)
        }
        thisMonthBeforeThisWeekRecords
            .groupBy { weekOfMonthKey(it.toLocalDate()) }
            .entries
            .sortedByDescending { it.key }
            .forEach { (key, groupRecords) ->
                val sampleDate = groupRecords.first().toLocalDate()
                val weekStart = sampleDate.with(TemporalAdjusters.previousOrSame(DayOfWeek.SUNDAY))
                val weekEnd = weekStart.plusDays(6)
                result.add(
                    HistoryAggregationItem.WeekItem(
                        year = sampleDate.year,
                        month = sampleDate.monthValue,
                        weekOfMonth = sampleDate.get(weekFields.weekOfMonth()),
                        count = groupRecords.size,
                        weekStart = weekStart,
                        weekEnd = weekEnd
                    )
                )
            }

        // This year, before this month: grouped by month
        val thisYearBeforeThisMonthRecords = records.filter { entity ->
            val date = entity.toLocalDate()
            date.year == currentYear && date.monthValue < currentMonth
        }
        thisYearBeforeThisMonthRecords
            .groupBy { it.toLocalDate().monthValue }
            .entries
            .sortedByDescending { it.key }
            .forEach { (month, groupRecords) ->
                result.add(
                    HistoryAggregationItem.MonthItem(
                        year = currentYear,
                        month = month,
                        count = groupRecords.size
                    )
                )
            }

        // Before this year: grouped by year
        val beforeThisYearRecords = records.filter { entity ->
            entity.toLocalDate().year < currentYear
        }
        beforeThisYearRecords
            .groupBy { it.toLocalDate().year }
            .entries
            .sortedByDescending { it.key }
            .forEach { (year, groupRecords) ->
                result.add(
                    HistoryAggregationItem.YearItem(
                        year = year,
                        count = groupRecords.size
                    )
                )
            }

        return result
    }

    /** Returns months aggregated for a given year drilldown. */
    fun aggregateByMonth(
        records: List<AchievementEntity>,
        year: Int
    ): List<HistoryAggregationItem.MonthItem> {
        return records
            .filter { it.toLocalDate().year == year }
            .groupBy { it.toLocalDate().monthValue }
            .entries
            .sortedByDescending { it.key }
            .map { (month, groupRecords) ->
                HistoryAggregationItem.MonthItem(
                    year = year,
                    month = month,
                    count = groupRecords.size
                )
            }
    }

    /** Returns weeks aggregated for a given year/month drilldown. */
    fun aggregateByWeek(
        records: List<AchievementEntity>,
        year: Int,
        month: Int
    ): List<HistoryAggregationItem.WeekItem> {
        return records
            .filter { entity ->
                val date = entity.toLocalDate()
                date.year == year && date.monthValue == month
            }
            .groupBy { weekOfMonthKey(it.toLocalDate()) }
            .entries
            .sortedByDescending { it.key }
            .map { (_, groupRecords) ->
                val sampleDate = groupRecords.first().toLocalDate()
                val weekStart = sampleDate.with(TemporalAdjusters.previousOrSame(DayOfWeek.SUNDAY))
                val weekEnd = weekStart.plusDays(6)
                HistoryAggregationItem.WeekItem(
                    year = year,
                    month = month,
                    weekOfMonth = sampleDate.get(weekFields.weekOfMonth()),
                    count = groupRecords.size,
                    weekStart = weekStart,
                    weekEnd = weekEnd
                )
            }
    }

    /** Returns individual records for a given year/month/week drilldown. */
    fun getWeekRecords(
        records: List<AchievementEntity>,
        year: Int,
        month: Int,
        weekOfMonth: Int
    ): List<HistoryAggregationItem.DetailItem> {
        return records
            .filter { entity ->
                val date = entity.toLocalDate()
                date.year == year &&
                        date.monthValue == month &&
                        date.get(weekFields.weekOfMonth()) == weekOfMonth
            }
            .sortedByDescending { it.achievedAt }
            .map { HistoryAggregationItem.DetailItem(it) }
    }

    /** Produces a week label like "3月1週" */
    fun weekLabel(month: Int, weekOfMonth: Int): String = "${month}月${weekOfMonth}週"

    /** Produces a month label like "2026年2月（8）" */
    fun monthLabel(year: Int, month: Int, count: Int): String = "${year}年${month}月（${count}）"

    /** Produces a year label like "2025年（42）" */
    fun yearLabel(year: Int, count: Int): String = "${year}年（${count}）"

    private fun weekOfMonthKey(date: LocalDate): Int =
        date.year * 10000 + date.monthValue * 100 + date.get(weekFields.weekOfMonth())

    private fun AchievementEntity.toLocalDate(): LocalDate =
        Instant.ofEpochMilli(achievedAt).atZone(ZoneId.systemDefault()).toLocalDate()
}
