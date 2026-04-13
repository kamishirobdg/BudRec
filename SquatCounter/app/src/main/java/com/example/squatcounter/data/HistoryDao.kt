package com.example.squatcounter.data

import androidx.room.*
import kotlinx.coroutines.flow.Flow

@Dao
interface HistoryDao {

    @Query("SELECT * FROM history ORDER BY createdAt DESC")
    fun getAllFlow(): Flow<List<HistoryEntity>>

    @Query("SELECT * FROM history WHERE id = :id LIMIT 1")
    suspend fun getById(id: Long): HistoryEntity?

    @Insert
    suspend fun insert(entity: HistoryEntity): Long

    @Query("UPDATE history SET finalCount = :finalCount, updatedAt = :updatedAt WHERE id = :id")
    suspend fun updateFinalCount(id: Long, finalCount: Int, updatedAt: Long)

    @Query("UPDATE history SET memo = :memo, updatedAt = :updatedAt WHERE id = :id")
    suspend fun updateMemo(id: Long, memo: String?, updatedAt: Long)

    @Query("DELETE FROM history WHERE id = :id")
    suspend fun deleteById(id: Long)

    @Query("DELETE FROM history")
    suspend fun deleteAll()
}
