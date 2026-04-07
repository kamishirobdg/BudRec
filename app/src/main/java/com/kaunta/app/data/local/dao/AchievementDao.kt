package com.kaunta.app.data.local.dao

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.Query
import com.kaunta.app.data.local.entity.AchievementEntity
import kotlinx.coroutines.flow.Flow

@Dao
interface AchievementDao {
    @Query("SELECT * FROM achievement_history ORDER BY achievedAt DESC")
    fun getAllFlow(): Flow<List<AchievementEntity>>

    @Query("SELECT * FROM achievement_history ORDER BY achievedAt DESC")
    suspend fun getAll(): List<AchievementEntity>

    @Query("SELECT * FROM achievement_history WHERE id = :id")
    suspend fun getById(id: Long): AchievementEntity?

    @Insert
    suspend fun insert(entity: AchievementEntity): Long

    @Query("DELETE FROM achievement_history WHERE id = :id")
    suspend fun deleteById(id: Long)

    @Query("DELETE FROM achievement_history")
    suspend fun deleteAll()

    @Query("UPDATE achievement_history SET memo = :memo WHERE id = :id")
    suspend fun updateMemo(id: Long, memo: String)

    @Query("SELECT COUNT(*) FROM achievement_history")
    suspend fun count(): Int
}
