package com.kaunta.app.domain.usecase

import com.kaunta.app.data.local.entity.AchievementEntity
import com.kaunta.app.data.repository.HistoryRepository
import java.time.Instant
import java.time.LocalDateTime
import java.time.ZoneId
import java.time.format.DateTimeFormatter

class SaveAchievementUseCase(private val historyRepository: HistoryRepository) {

    private val dateFormatter = DateTimeFormatter.ofPattern("yyyy-MM-dd")
    private val timeFormatter = DateTimeFormatter.ofPattern("HH:mm:ss")

    suspend fun execute(targetCount: Int, countAtAchievement: Int, memo: String): Long {
        val now = System.currentTimeMillis()
        val localDateTime = LocalDateTime.ofInstant(Instant.ofEpochMilli(now), ZoneId.systemDefault())
        val entity = AchievementEntity(
            achievedAt = now,
            achievedDate = localDateTime.format(dateFormatter),
            achievedTime = localDateTime.format(timeFormatter),
            targetCount = targetCount,
            countAtAchievement = countAtAchievement,
            memo = memo,
            createdAt = now
        )
        return historyRepository.insert(entity)
    }
}
