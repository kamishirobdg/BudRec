package com.example.squatcounter.data

import androidx.room.Entity
import androidx.room.PrimaryKey

@Entity(tableName = "history")
data class HistoryEntity(
    @PrimaryKey(autoGenerate = true) val id: Long = 0,
    val createdAt: Long,    // 目標到達時 or 未達リセット時のタイムスタンプ（表示用・不変）
    val updatedAt: Long,    // 最終更新日時
    val goal: Int,
    val finalCount: Int,
    val memo: String?,
    val isAchieved: Boolean
)
