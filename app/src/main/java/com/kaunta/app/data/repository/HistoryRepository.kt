package com.kaunta.app.data.repository

import com.kaunta.app.data.local.dao.AchievementDao
import com.kaunta.app.data.local.entity.AchievementEntity
import kotlinx.coroutines.flow.Flow

class HistoryRepository(private val dao: AchievementDao) {

    val allHistoryFlow: Flow<List<AchievementEntity>> = dao.getAllFlow()

    suspend fun getAll(): List<AchievementEntity> = dao.getAll()

    suspend fun getById(id: Long): AchievementEntity? = dao.getById(id)

    suspend fun insert(entity: AchievementEntity): Long = dao.insert(entity)

    suspend fun deleteById(id: Long) = dao.deleteById(id)

    suspend fun deleteAll() = dao.deleteAll()

    suspend fun updateMemo(id: Long, memo: String) = dao.updateMemo(id, memo)
}
