package com.example.squatcounter.ui.history

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import com.example.squatcounter.data.HistoryEntity
import com.example.squatcounter.ui.theme.HistoryAchievedBg
import com.example.squatcounter.ui.theme.HistoryUnachievedBg
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun HistoryDetailScreen(
    year: Int,
    month: Int,
    week: Int,
    onBack: () -> Unit,
    vm: HistoryViewModel = viewModel()
) {
    val groups by vm.groups.collectAsStateWithLifecycle()
    val group = groups.find { it.year == year && it.month == month && it.weekOfMonth == week }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("${month}月${week}週") },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, "戻る")
                    }
                }
            )
        }
    ) { padding ->
        if (group == null) {
            Box(Modifier.fillMaxSize().padding(padding), contentAlignment = Alignment.Center) {
                Text("データがありません")
            }
            return@Scaffold
        }
        LazyColumn(
            modifier = Modifier.fillMaxSize().padding(padding),
            contentPadding = PaddingValues(16.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp)
        ) {
            items(group.records, key = { it.id }) { record ->
                HistoryRecordCard(record = record, onDelete = { vm.deleteRecord(record.id) })
            }
        }
    }
}

@Composable
private fun HistoryRecordCard(record: HistoryEntity, onDelete: () -> Unit) {
    val fmt = remember { SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.getDefault()) }
    val bgColor = if (record.isAchieved) HistoryAchievedBg else HistoryUnachievedBg

    Card(modifier = Modifier.fillMaxWidth()) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .background(bgColor)
                .padding(16.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            Column(modifier = Modifier.weight(1f)) {
                Text(
                    fmt.format(Date(record.createdAt)),
                    style = MaterialTheme.typography.bodyMedium
                )
                Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    Text("目標: ${record.goal}", style = MaterialTheme.typography.bodySmall)
                    Text("カウント: ${record.finalCount}", style = MaterialTheme.typography.bodySmall)
                }
                if (!record.memo.isNullOrBlank()) {
                    Text(
                        record.memo,
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
                if (!record.isAchieved) {
                    Text(
                        "未達",
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
            }
            IconButton(onClick = onDelete) {
                Icon(
                    Icons.Default.Delete,
                    contentDescription = "削除",
                    tint = MaterialTheme.colorScheme.error
                )
            }
        }
    }
}
