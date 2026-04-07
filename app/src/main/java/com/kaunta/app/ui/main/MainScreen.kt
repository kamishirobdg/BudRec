package com.kaunta.app.ui.main

import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectHorizontalDragGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.History
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import com.kaunta.app.MainActivity
import com.kaunta.app.ui.theme.GoalReachedColor
import com.kaunta.app.ui.theme.GoalReachedContainer

@Composable
fun MainScreen(
    onNavigateToSettings: () -> Unit,
    onNavigateToHistory: () -> Unit,
    viewModel: MainViewModel = viewModel()
) {
    val uiState by viewModel.uiState.collectAsStateWithLifecycle()
    val activity = LocalContext.current as? MainActivity
    DisposableEffect(Unit) {
        viewModel.ensureTts()
        activity?.setVolumeKeyListener { isUp -> viewModel.onVolumeKeyEvent(isUp) }
        onDispose {
            activity?.clearVolumeKeyListener()
        }
    }

    val counterState = uiState.counterState
    val settings = uiState.settings
    val goalReached = counterState.hasReachedTargetInCurrentSession

    // Track horizontal drag to navigate to history on right swipe
    var dragAccumX by remember { mutableFloatStateOf(0f) }
    val swipeThresholdPx = with(LocalDensity.current) { 80.dp.toPx() }

    Scaffold(
        modifier = Modifier.pointerInput(Unit) {
            detectHorizontalDragGestures(
                onDragStart = { dragAccumX = 0f },
                onDragCancel = { dragAccumX = 0f },
                onDragEnd = {
                    if (dragAccumX > swipeThresholdPx) onNavigateToHistory()
                    dragAccumX = 0f
                },
                onHorizontalDrag = { _, dragAmount ->
                    dragAccumX += dragAmount
                }
            )
        },
        topBar = {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    // statusBarsPadding pushes content below the status bar
                    // when the system enforces edge-to-edge (targetSdk=35)
                    .statusBarsPadding()
                    .padding(horizontal = 8.dp, vertical = 4.dp),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                Text(
                    text = "カウンタ",
                    style = MaterialTheme.typography.titleLarge,
                    modifier = Modifier.padding(start = 8.dp)
                )
                Row {
                    IconButton(
                        onClick = onNavigateToHistory,
                        modifier = Modifier.testTag("btn_history")
                    ) {
                        Icon(Icons.Default.History, contentDescription = "履歴")
                    }
                    IconButton(
                        onClick = onNavigateToSettings,
                        modifier = Modifier.testTag("btn_settings")
                    ) {
                        Icon(Icons.Default.Settings, contentDescription = "設定")
                    }
                }
            }
        }
    ) { innerPadding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(innerPadding)
                .padding(horizontal = 24.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.SpaceBetween
        ) {
            // Top: target and status
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(top = 16.dp),
                horizontalAlignment = Alignment.CenterHorizontally
            ) {
                Text(
                    text = "目標: ${settings.targetCount}",
                    style = MaterialTheme.typography.titleMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
                if (goalReached) {
                    Spacer(modifier = Modifier.height(8.dp))
                    Surface(
                        shape = RoundedCornerShape(20.dp),
                        color = GoalReachedContainer,
                        modifier = Modifier.padding(4.dp)
                    ) {
                        Text(
                            text = "達成！",
                            color = GoalReachedColor,
                            fontWeight = FontWeight.Bold,
                            modifier = Modifier.padding(horizontal = 16.dp, vertical = 6.dp)
                        )
                    }
                }
            }

            // Center: large count display
            Box(
                contentAlignment = Alignment.Center,
                modifier = Modifier
                    .size(220.dp)
                    .clip(CircleShape)
                    .background(
                        if (goalReached) GoalReachedContainer
                        else MaterialTheme.colorScheme.primaryContainer
                    )
            ) {
                Text(
                    text = counterState.currentCount.toString(),
                    fontSize = if (counterState.currentCount >= 1000) 56.sp else 80.sp,
                    fontWeight = FontWeight.Bold,
                    color = if (goalReached) GoalReachedColor else MaterialTheme.colorScheme.onPrimaryContainer,
                    textAlign = TextAlign.Center,
                    modifier = Modifier.testTag("txt_count")
                )
            }

            // Bottom: controls
            Column(
                horizontalAlignment = Alignment.CenterHorizontally,
                modifier = Modifier.padding(bottom = 40.dp)
            ) {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(16.dp)
                ) {
                    CounterButton(
                        label = "−",
                        modifier = Modifier
                            .weight(1f)
                            .height(80.dp)
                            .testTag("btn_decrement"),
                        onClick = viewModel::decrement
                    )
                    CounterButton(
                        label = "+",
                        modifier = Modifier
                            .weight(1f)
                            .height(80.dp)
                            .testTag("btn_increment"),
                        onClick = viewModel::increment
                    )
                }
                Spacer(modifier = Modifier.height(16.dp))
                FilledTonalButton(
                    onClick = viewModel::reset,
                    modifier = Modifier
                        .fillMaxWidth()
                        .height(52.dp)
                        .testTag("btn_reset")
                ) {
                    Icon(Icons.Default.Refresh, contentDescription = null)
                    Text(text = "  リセット", style = MaterialTheme.typography.labelLarge)
                }
            }
        }
    }

    if (uiState.showMemoDialog) {
        MemoDialog(
            onConfirm = viewModel::saveMemo,
            onDismiss = viewModel::dismissMemoDialog
        )
    }
}

@Composable
private fun CounterButton(
    label: String,
    modifier: Modifier = Modifier,
    onClick: () -> Unit
) {
    Surface(
        onClick = onClick,
        modifier = modifier,
        shape = RoundedCornerShape(20.dp),
        color = MaterialTheme.colorScheme.primary,
        contentColor = MaterialTheme.colorScheme.onPrimary,
        tonalElevation = 4.dp
    ) {
        Box(contentAlignment = Alignment.Center) {
            Text(
                text = label,
                fontSize = 40.sp,
                fontWeight = FontWeight.Bold,
                color = Color.White
            )
        }
    }
}

@Composable
private fun MemoDialog(
    onConfirm: (String) -> Unit,
    onDismiss: () -> Unit
) {
    var memo by remember { mutableStateOf("") }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("目標達成！") },
        text = {
            Column {
                Text("メモを入力してください（任意）")
                Spacer(modifier = Modifier.height(8.dp))
                OutlinedTextField(
                    value = memo,
                    onValueChange = { memo = it },
                    placeholder = { Text("メモ") },
                    modifier = Modifier
                        .fillMaxWidth()
                        .testTag("input_memo"),
                    singleLine = false,
                    maxLines = 3
                )
            }
        },
        confirmButton = {
            TextButton(onClick = { onConfirm(memo) }) {
                Text("保存")
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) {
                Text("スキップ")
            }
        }
    )
}
