package com.example.squatcounter.ui.main

import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.History
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.activity.ComponentActivity
import androidx.compose.ui.platform.LocalContext
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import com.example.squatcounter.ui.theme.BackgroundAchieved
import com.example.squatcounter.ui.theme.BackgroundNormal
import com.example.squatcounter.ui.theme.Blue40
import com.example.squatcounter.ui.theme.CounterCircleAchieved
import com.example.squatcounter.ui.theme.CounterCircleNormal
import com.example.squatcounter.ui.theme.ResetButtonColor

@Composable
fun MainScreen(
    onNavigateToHistory: () -> Unit,
    onNavigateToSettings: () -> Unit,
    vm: MainViewModel = viewModel(LocalContext.current as ComponentActivity)
) {
    val state by vm.uiState.collectAsStateWithLifecycle()

    val bgColor by animateColorAsState(
        targetValue = if (state.isGoalAchieved) BackgroundAchieved else BackgroundNormal,
        animationSpec = tween(500),
        label = "bg"
    )
    val circleColor by animateColorAsState(
        targetValue = if (state.isGoalAchieved) CounterCircleAchieved else CounterCircleNormal,
        animationSpec = tween(500),
        label = "circle"
    )

    // Memo dialog
    if (state.showMemoDialog) {
        MemoDialog(
            onConfirm = { memo -> vm.dismissMemoDialog(memo) },
            onDismiss = { vm.dismissMemoDialog(null) }
        )
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(bgColor)
            .statusBarsPadding()
            .navigationBarsPadding()
    ) {
        // Header
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 16.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            Text(
                text = "カウンタ",
                fontSize = 24.sp,
                fontWeight = FontWeight.Bold,
                modifier = Modifier.weight(1f)
            )
            IconButton(onClick = onNavigateToHistory) {
                Icon(Icons.Default.History, contentDescription = "履歴")
            }
            IconButton(onClick = onNavigateToSettings) {
                Icon(Icons.Default.Settings, contentDescription = "設定")
            }
        }

        // Reset button — below header, full width
        Button(
            onClick = { vm.reset() },
            enabled = !state.isSequencePlaying,
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 16.dp, vertical = 4.dp)
                .height(56.dp),
            shape = RoundedCornerShape(28.dp),
            colors = ButtonDefaults.buttonColors(
                containerColor = ResetButtonColor,
                contentColor = Blue40
            )
        ) {
            Icon(Icons.Default.Refresh, contentDescription = null)
            Spacer(Modifier.width(8.dp))
            Text("リセット", fontSize = 18.sp, fontWeight = FontWeight.Medium)
        }

        // Goal label
        Text(
            text = "目標: ${state.settings.goalCount}",
            modifier = Modifier
                .fillMaxWidth()
                .padding(top = 16.dp),
            textAlign = androidx.compose.ui.text.style.TextAlign.Center,
            fontSize = 18.sp
        )

        // Counter circle
        Box(
            modifier = Modifier
                .weight(1f)
                .fillMaxWidth(),
            contentAlignment = Alignment.Center
        ) {
            Box(
                modifier = Modifier
                    .size(240.dp)
                    .clip(CircleShape)
                    .background(circleColor),
                contentAlignment = Alignment.Center
            ) {
                Text(
                    text = state.count.toString(),
                    fontSize = 80.sp,
                    fontWeight = FontWeight.Bold,
                    color = Color(0xFF0D1B5E)
                )
            }
        }

        // +/- buttons
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 16.dp, vertical = 8.dp),
            horizontalArrangement = Arrangement.spacedBy(16.dp)
        ) {
            Button(
                onClick = { vm.decrement() },
                enabled = !state.isSequencePlaying && state.count > 0,
                modifier = Modifier
                    .weight(1f)
                    .height(120.dp),
                shape = RoundedCornerShape(20.dp),
                colors = ButtonDefaults.buttonColors(containerColor = Blue40)
            ) {
                Text("−", fontSize = 48.sp, fontWeight = FontWeight.Bold)
            }
            Button(
                onClick = { vm.increment() },
                enabled = !state.isSequencePlaying,
                modifier = Modifier
                    .weight(1f)
                    .height(120.dp),
                shape = RoundedCornerShape(20.dp),
                colors = ButtonDefaults.buttonColors(containerColor = Blue40)
            ) {
                Text("+", fontSize = 48.sp, fontWeight = FontWeight.Bold)
            }
        }

        Spacer(Modifier.height(24.dp))
    }
}

@Composable
private fun MemoDialog(onConfirm: (String?) -> Unit, onDismiss: () -> Unit) {
    var text by remember { mutableStateOf("") }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("目標達成！メモを入力") },
        text = {
            OutlinedTextField(
                value = text,
                onValueChange = { text = it },
                label = { Text("メモ（任意）") },
                modifier = Modifier.fillMaxWidth()
            )
        },
        confirmButton = {
            TextButton(onClick = { onConfirm(text.ifBlank { null }) }) { Text("保存") }
        },
        dismissButton = {
            TextButton(onClick = { onDismiss() }) { Text("スキップ") }
        }
    )
}
