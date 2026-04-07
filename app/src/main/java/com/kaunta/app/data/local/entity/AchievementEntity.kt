package com.kaunta.app.data.local.entity

import androidx.room.Entity
import androidx.room.PrimaryKey

@Entity(tableName = "achievement_history")
data class AchievementEntity(
    @PrimaryKey(autoGenerate = true) val id: Long = 0,
    val achievedAt: Long,
    val achievedDate: String,
    val achievedTime: String,
    val targetCount: Int,
    val countAtAchievement: Int,
    val memo: String,
    val createdAt: Long
)
