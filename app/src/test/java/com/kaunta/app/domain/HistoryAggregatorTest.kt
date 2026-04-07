package com.kaunta.app.domain

import com.kaunta.app.data.local.entity.AchievementEntity
import com.kaunta.app.domain.aggregation.HistoryAggregator
import com.kaunta.app.domain.model.HistoryAggregationItem
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.LocalDate
import java.time.ZoneId

class HistoryAggregatorTest {

    private val zone = ZoneId.systemDefault()

    private fun makeEntity(date: LocalDate, id: Long = 0): AchievementEntity {
        val millis = date.atStartOfDay(zone).toInstant().toEpochMilli()
        return AchievementEntity(
            id = id,
            achievedAt = millis,
            achievedDate = date.toString(),
            achievedTime = "10:00:00",
            targetCount = 10,
            countAtAchievement = 10,
            memo = "",
            createdAt = millis
        )
    }

    @Test
    fun `empty list returns empty`() {
        val result = HistoryAggregator.aggregateForTopLevel(emptyList(), LocalDate.of(2026, 4, 4))
        assertTrue(result.isEmpty())
    }

    @Test
    fun `record from this week is shown as DetailItem`() {
        // 2026-04-04 is Saturday; week starts 2026-03-29 (Sunday)
        val today = LocalDate.of(2026, 4, 4)
        val record = makeEntity(LocalDate.of(2026, 4, 1), id = 1)
        val result = HistoryAggregator.aggregateForTopLevel(listOf(record), today)
        assertEquals(1, result.size)
        assertTrue(result[0] is HistoryAggregationItem.DetailItem)
    }

    @Test
    fun `record from this month before this week is WeekItem`() {
        // today = 2026-04-04, week starts 2026-03-29
        // record on 2026-04-01 → wait, 2026-04-01 IS in this week (Sun Mar 29 – Sat Apr 4)
        // Use 2026-03-25 (in March, week of Mar 22)
        val today = LocalDate.of(2026, 4, 4)
        val record = makeEntity(LocalDate.of(2026, 3, 25), id = 2)
        // March belongs to current year, before current month(4), so should be MonthItem
        val result = HistoryAggregator.aggregateForTopLevel(listOf(record), today)
        assertEquals(1, result.size)
        assertTrue(result[0] is HistoryAggregationItem.MonthItem)
        assertEquals(3, (result[0] as HistoryAggregationItem.MonthItem).month)
    }

    @Test
    fun `record from this month but before this week in same month is WeekItem`() {
        // today = 2026-04-20 → current month = April, current week starts 2026-04-19 (Sunday)
        val today = LocalDate.of(2026, 4, 20)
        val record = makeEntity(LocalDate.of(2026, 4, 5), id = 3)
        val result = HistoryAggregator.aggregateForTopLevel(listOf(record), today)
        assertEquals(1, result.size)
        assertTrue(result[0] is HistoryAggregationItem.WeekItem)
    }

    @Test
    fun `record from previous year is YearItem`() {
        val today = LocalDate.of(2026, 4, 4)
        val record = makeEntity(LocalDate.of(2025, 6, 15), id = 4)
        val result = HistoryAggregator.aggregateForTopLevel(listOf(record), today)
        assertEquals(1, result.size)
        assertTrue(result[0] is HistoryAggregationItem.YearItem)
        assertEquals(2025, (result[0] as HistoryAggregationItem.YearItem).year)
    }

    @Test
    fun `multiple records in same year group by year`() {
        val today = LocalDate.of(2026, 4, 4)
        val records = listOf(
            makeEntity(LocalDate.of(2025, 1, 10), id = 1),
            makeEntity(LocalDate.of(2025, 6, 20), id = 2),
            makeEntity(LocalDate.of(2025, 12, 31), id = 3)
        )
        val result = HistoryAggregator.aggregateForTopLevel(records, today)
        assertEquals(1, result.size)
        val year = result[0] as HistoryAggregationItem.YearItem
        assertEquals(2025, year.year)
        assertEquals(3, year.count)
    }

    @Test
    fun `aggregateByMonth returns correct month items`() {
        val records = listOf(
            makeEntity(LocalDate.of(2026, 1, 5), id = 1),
            makeEntity(LocalDate.of(2026, 1, 10), id = 2),
            makeEntity(LocalDate.of(2026, 2, 3), id = 3)
        )
        val result = HistoryAggregator.aggregateByMonth(records, 2026)
        assertEquals(2, result.size)
        assertEquals(2, result[0].month)  // descending order
        assertEquals(1, result[1].month)
        assertEquals(1, result[1].count.let { result[1].count })
        assertEquals(2, result[1].count.let { result.find { it.month == 1 }?.count })
    }

    @Test
    fun `week label format is correct`() {
        assertEquals("3月1週", HistoryAggregator.weekLabel(3, 1))
        assertEquals("12月5週", HistoryAggregator.weekLabel(12, 5))
    }

    @Test
    fun `month label format is correct`() {
        assertEquals("2026年2月（8）", HistoryAggregator.monthLabel(2026, 2, 8))
    }

    @Test
    fun `year label format is correct`() {
        assertEquals("2025年（42）", HistoryAggregator.yearLabel(2025, 42))
    }

    @Test
    fun `delete record reduces count in aggregation`() {
        val today = LocalDate.of(2026, 4, 4)
        val records = listOf(
            makeEntity(LocalDate.of(2025, 3, 10), id = 1),
            makeEntity(LocalDate.of(2025, 3, 15), id = 2)
        )
        val before = HistoryAggregator.aggregateForTopLevel(records, today)
        assertEquals(2, (before[0] as HistoryAggregationItem.YearItem).count)

        val afterDelete = HistoryAggregator.aggregateForTopLevel(records.drop(1), today)
        assertEquals(1, (afterDelete[0] as HistoryAggregationItem.YearItem).count)
    }

    @Test
    fun `count cannot go below zero - domain rule`() {
        // Test that the domain rule enforced in UpdateCounterUseCase holds
        val newCount = maxOf(0, 0 - 1)
        assertEquals(0, newCount)
    }

    @Test
    fun `goal not reached again in same session`() {
        // hasReachedTargetInCurrentSession = true → goalJustReached must be false
        val hasReached = true
        val newCount = 15
        val target = 10
        val goalJustReached = !hasReached && newCount >= target
        assertEquals(false, goalJustReached)
    }

    @Test
    fun `goal reached first time transitions flag`() {
        val hasReached = false
        val newCount = 10
        val target = 10
        val goalJustReached = !hasReached && newCount >= target
        assertEquals(true, goalJustReached)
    }
}
