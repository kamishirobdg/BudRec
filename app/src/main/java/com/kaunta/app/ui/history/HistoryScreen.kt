package com.kaunta.app.ui.history

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.DeleteForever
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Divider
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import com.kaunta.app.data.local.entity.AchievementEntity
import com.kaunta.app.domain.aggregation.HistoryAggregator
import com.kaunta.app.domain.model.HistoryAggregationItem

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun HistoryScreen(
    onNavigateBack: () -> Unit,
    viewModel: HistoryViewModel = viewModel()
) {
    val uiState by viewModel.uiState.collectAsStateWithLifecycle()

    BackHandler(enabled = uiState.navState != HistoryNavState.TopLevel) {
        viewModel.navigateBack()
    }

    val title = when (val nav = uiState.navState) {
        HistoryNavState.TopLevel -> "履歴"
        is HistoryNavState.YearDetail -> "${nav.year}年"
        is HistoryNavState.MonthDetail -> "${nav.year}年${nav.month}月"
        is HistoryNavState.WeekDetail -> "${nav.month}月${nav.weekOfMonth}週"
        is HistoryNavState.RecordDetail -> "詳細"
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(title) },
                navigationIcon = {
                    IconButton(onClick = {
                        if (!viewModel.navigateBack()) onNavigateBack()
                    }) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "戻る")
                    }
                },
                actions = {
                    if (uiState.navState == HistoryNavState.TopLevel && uiState.allRecords.isNotEmpty()) {
                        IconButton(
                            onClick = viewModel::requestDeleteAll,
                            modifier = Modifier.testTag("btn_delete_all")
                        ) {
                            Icon(Icons.Default.DeleteForever, contentDescription = "全件削除")
                        }
                    }
                }
            )
        }
    ) { innerPadding ->
        Box(
            modifier = Modifier
                .fillMaxSize()
                .padding(innerPadding)
        ) {
            when (val nav = uiState.navState) {
                is HistoryNavState.RecordDetail -> {
                    uiState.selectedRecord?.let { record ->
                        RecordDetailView(
                            record = record,
                            onDelete = { viewModel.deleteRecord(record.id) },
                            onEditMemo = { viewModel.requestEditMemo() }
                        )
                    }
                }
                else -> {
                    if (uiState.displayItems.isEmpty() && uiState.allRecords.isEmpty()) {
                        EmptyHistoryView()
                    } else {
                        AggregationListView(
                            items = uiState.displayItems,
                            onItemClick = { item ->
                                when (item) {
                                    is HistoryAggregationItem.YearItem ->
                                        viewModel.navigateTo(HistoryNavState.YearDetail(item.year))
                                    is HistoryAggregationItem.MonthItem ->
                                        viewModel.navigateTo(HistoryNavState.MonthDetail(item.year, item.month))
                                    is HistoryAggregationItem.WeekItem ->
                                        viewModel.navigateTo(
                                            HistoryNavState.WeekDetail(item.year, item.month, item.weekOfMonth)
                                        )
                                    is HistoryAggregationItem.DetailItem ->
                                        viewModel.navigateTo(HistoryNavState.RecordDetail(item.entity.id))
                                }
                            },
                            onDeleteDetail = { viewModel.deleteRecord(it.entity.id) }
                        )
                    }
                }
            }
        }
    }

    if (uiState.showDeleteAllDialog) {
        AlertDialog(
            onDismissRequest = viewModel::cancelDeleteAll,
            title = { Text("全件削除") },
            text = { Text("すべての履歴を削除しますか？この操作は元に戻せません。") },
            confirmButton = {
                TextButton(
                    onClick = viewModel::confirmDeleteAll,
                    modifier = Modifier.testTag("btn_confirm_delete_all")
                ) { Text("削除", color = MaterialTheme.colorScheme.error) }
            },
            dismissButton = {
                TextButton(onClick = viewModel::cancelDeleteAll) { Text("キャンセル") }
            }
        )
    }

    if (uiState.showEditMemoDialog) {
        EditMemoDialog(
            initialMemo = uiState.editingMemo,
            onConfirm = viewModel::confirmEditMemo,
            onDismiss = viewModel::cancelEditMemo
        )
    }
}

@Composable
private fun EditMemoDialog(
    initialMemo: String,
    onConfirm: (String) -> Unit,
    onDismiss: () -> Unit
) {
    var memo by remember(initialMemo) { mutableStateOf(initialMemo) }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("メモを編集") },
        text = {
            OutlinedTextField(
                value = memo,
                onValueChange = { memo = it },
                placeholder = { Text("メモ") },
                modifier = Modifier
                    .fillMaxWidth()
                    .testTag("input_edit_memo"),
                singleLine = false,
                maxLines = 4
            )
        },
        confirmButton = {
            TextButton(onClick = { onConfirm(memo) }) { Text("保存") }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) { Text("キャンセル") }
        }
    )
}

@Composable
private fun EmptyHistoryView() {
    Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        Text(
            text = "履歴がありません",
            style = MaterialTheme.typography.bodyLarge,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.testTag("txt_empty_history")
        )
    }
}

@Composable
private fun AggregationListView(
    items: List<HistoryAggregationItem>,
    onItemClick: (HistoryAggregationItem) -> Unit,
    onDeleteDetail: (HistoryAggregationItem.DetailItem) -> Unit
) {
    LazyColumn(modifier = Modifier.fillMaxSize()) {
        items(items, key = { itemKey(it) }) { item ->
            when (item) {
                is HistoryAggregationItem.YearItem -> AggregateRow(
                    label = HistoryAggregator.yearLabel(item.year, item.count),
                    onClick = { onItemClick(item) }
                )
                is HistoryAggregationItem.MonthItem -> AggregateRow(
                    label = HistoryAggregator.monthLabel(item.year, item.month, item.count),
                    onClick = { onItemClick(item) }
                )
                is HistoryAggregationItem.WeekItem -> AggregateRow(
                    label = "${HistoryAggregator.weekLabel(item.month, item.weekOfMonth)}（${item.count}）",
                    onClick = { onItemClick(item) }
                )
                is HistoryAggregationItem.DetailItem -> DetailRow(
                    entity = item.entity,
                    onClick = { onItemClick(item) },
                    onDelete = { onDeleteDetail(item) }
                )
            }
            Divider(color = MaterialTheme.colorScheme.outlineVariant)
        }
    }
}

@Composable
private fun AggregateRow(label: String, onClick: () -> Unit) {
    Card(
        onClick = onClick,
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 12.dp, vertical = 4.dp),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
        elevation = CardDefaults.cardElevation(defaultElevation = 1.dp)
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 16.dp, vertical = 14.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.SpaceBetween
        ) {
            Text(text = label, style = MaterialTheme.typography.bodyLarge)
            Icon(
                Icons.AutoMirrored.Filled.KeyboardArrowRight,
                contentDescription = null,
                tint = MaterialTheme.colorScheme.onSurfaceVariant
            )
        }
    }
}

@Composable
private fun DetailRow(
    entity: AchievementEntity,
    onClick: () -> Unit,
    onDelete: () -> Unit
) {
    Card(
        onClick = onClick,
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 12.dp, vertical = 4.dp)
            .testTag("row_detail_${entity.id}"),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant),
        elevation = CardDefaults.cardElevation(defaultElevation = 0.dp)
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(start = 16.dp, end = 4.dp, top = 10.dp, bottom = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.SpaceBetween
        ) {
            Column(modifier = Modifier.weight(1f)) {
                Text(
                    text = "${entity.achievedDate} ${entity.achievedTime}",
                    style = MaterialTheme.typography.bodyMedium,
                    fontWeight = FontWeight.Medium
                )
                Text(
                    text = "目標: ${entity.targetCount}  カウント: ${entity.countAtAchievement}",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
                if (entity.memo.isNotEmpty()) {
                    Text(
                        text = entity.memo,
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        maxLines = 1
                    )
                }
            }
            IconButton(
                onClick = onDelete,
                modifier = Modifier.testTag("btn_delete_${entity.id}")
            ) {
                Icon(
                    Icons.Default.Delete,
                    contentDescription = "削除",
                    tint = MaterialTheme.colorScheme.error
                )
            }
        }
    }
}

@Composable
private fun RecordDetailView(
    record: AchievementEntity,
    onDelete: () -> Unit,
    onEditMemo: () -> Unit
) {
    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(24.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp)
    ) {
        DetailField("日時", "${record.achievedDate} ${record.achievedTime}")
        DetailField("目標", "${record.targetCount}回")
        DetailField("カウント", "${record.countAtAchievement}回")
        // Memo row with edit button
        Column {
            Text(
                text = "メモ",
                style = MaterialTheme.typography.labelLarge,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
            Row(
                verticalAlignment = Alignment.CenterVertically,
                modifier = Modifier.fillMaxWidth()
            ) {
                Text(
                    text = record.memo.ifEmpty { "（なし）" },
                    style = MaterialTheme.typography.bodyLarge,
                    modifier = Modifier.weight(1f)
                )
                IconButton(
                    onClick = onEditMemo,
                    modifier = Modifier.testTag("btn_edit_memo")
                ) {
                    Icon(
                        Icons.Default.Edit,
                        contentDescription = "メモを編集",
                        tint = MaterialTheme.colorScheme.primary
                    )
                }
            }
            Divider(color = MaterialTheme.colorScheme.outlineVariant)
        }
        Spacer(modifier = Modifier.weight(1f))
        TextButton(
            onClick = onDelete,
            modifier = Modifier
                .align(Alignment.End)
                .testTag("btn_delete_record")
        ) {
            Icon(Icons.Default.Delete, contentDescription = null, tint = MaterialTheme.colorScheme.error)
            Text("  この記録を削除", color = MaterialTheme.colorScheme.error)
        }
    }
}

@Composable
private fun DetailField(label: String, value: String) {
    Column {
        Text(
            text = label,
            style = MaterialTheme.typography.labelLarge,
            color = MaterialTheme.colorScheme.onSurfaceVariant
        )
        Text(text = value, style = MaterialTheme.typography.bodyLarge)
        Spacer(modifier = Modifier.height(4.dp))
        Divider(color = MaterialTheme.colorScheme.outlineVariant)
    }
}

private fun itemKey(item: HistoryAggregationItem): String = when (item) {
    is HistoryAggregationItem.YearItem -> "year_${item.year}"
    is HistoryAggregationItem.MonthItem -> "month_${item.year}_${item.month}"
    is HistoryAggregationItem.WeekItem -> "week_${item.year}_${item.month}_${item.weekOfMonth}"
    is HistoryAggregationItem.DetailItem -> "detail_${item.entity.id}"
}
