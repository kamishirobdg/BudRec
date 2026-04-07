package com.kaunta.app.ui.settings

import android.media.RingtoneManager
import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.MusicNote
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Switch
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Switch
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
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import com.kaunta.app.domain.model.GoalNotificationMode
import com.kaunta.app.domain.model.SpeechInterval
import com.kaunta.app.domain.model.VolumeKeyMode

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingsScreen(
    onNavigateBack: () -> Unit,
    viewModel: SettingsViewModel = viewModel()
) {
    val settings by viewModel.settings.collectAsStateWithLifecycle()
    val context = LocalContext.current

    val ringtoneLauncher = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.StartActivityForResult()
    ) { result ->
        val uri = result.data?.getParcelableExtra<Uri>(RingtoneManager.EXTRA_RINGTONE_PICKED_URI)
        viewModel.updateNotificationSoundUri(uri?.toString() ?: "")
    }

    fun launchRingtonePicker() {
        val intent = android.content.Intent(RingtoneManager.ACTION_RINGTONE_PICKER).apply {
            putExtra(RingtoneManager.EXTRA_RINGTONE_TYPE, RingtoneManager.TYPE_NOTIFICATION)
            putExtra(RingtoneManager.EXTRA_RINGTONE_SHOW_SILENT, false)
            putExtra(RingtoneManager.EXTRA_RINGTONE_SHOW_DEFAULT, true)
            if (settings.notificationSoundUri.isNotEmpty()) {
                putExtra(
                    RingtoneManager.EXTRA_RINGTONE_EXISTING_URI,
                    Uri.parse(settings.notificationSoundUri)
                )
            }
        }
        ringtoneLauncher.launch(intent)
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("設定") },
                navigationIcon = {
                    IconButton(onClick = onNavigateBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "戻る")
                    }
                }
            )
        }
    ) { innerPadding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(innerPadding)
                .padding(horizontal = 16.dp)
                .verticalScroll(rememberScrollState()),
            verticalArrangement = Arrangement.spacedBy(12.dp)
        ) {
            Spacer(modifier = Modifier.height(4.dp))

            // Counter Settings
            SettingsCard(title = "カウント設定") {
                TargetCountRow(
                    targetCount = settings.targetCount,
                    onValueChange = viewModel::updateTargetCount
                )
                Spacer(modifier = Modifier.height(8.dp))
                SwitchRow(
                    label = "達成時にメモ入力を求める",
                    checked = settings.showMemoDialogOnAchievement,
                    onCheckedChange = viewModel::updateShowMemoDialog,
                    testTag = "switch_memo_dialog"
                )
            }

            // Volume key
            SettingsCard(title = "物理キー設定") {
                RadioRow(
                    label = "通常（音量↑ = +1）",
                    selected = settings.volumeKeyMode == VolumeKeyMode.NORMAL,
                    onClick = { viewModel.updateVolumeKeyMode(VolumeKeyMode.NORMAL) },
                    testTag = "radio_key_normal"
                )
                RadioRow(
                    label = "反転（音量↑ = −1）",
                    selected = settings.volumeKeyMode == VolumeKeyMode.REVERSED,
                    onClick = { viewModel.updateVolumeKeyMode(VolumeKeyMode.REVERSED) },
                    testTag = "radio_key_reversed"
                )
            }

            // Notification
            SettingsCard(title = "目標到達通知") {
                GoalNotificationMode.entries.forEach { mode ->
                    RadioRow(
                        label = mode.label(),
                        selected = settings.goalNotificationMode == mode,
                        onClick = { viewModel.updateGoalNotificationMode(mode) },
                        testTag = "radio_notif_${mode.name}"
                    )
                }
                Spacer(modifier = Modifier.height(8.dp))
                TextButton(
                    onClick = ::launchRingtonePicker,
                    modifier = Modifier.testTag("btn_sound_picker")
                ) {
                    Icon(Icons.Default.MusicNote, contentDescription = null)
                    Text("  通知音を選択")
                }
                if (settings.notificationSoundUri.isNotEmpty()) {
                    val ringtoneName = runCatching {
                        RingtoneManager.getRingtone(context, Uri.parse(settings.notificationSoundUri))
                            ?.getTitle(context) ?: "カスタム"
                    }.getOrElse { "カスタム" }
                    Text(
                        text = "選択中: $ringtoneName",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.padding(start = 8.dp)
                    )
                }
            }

            // TTS
            SettingsCard(title = "読み上げ設定") {
                SpeechInterval.entries.forEach { interval ->
                    RadioRow(
                        label = interval.label(),
                        selected = settings.speechInterval == interval,
                        onClick = { viewModel.updateSpeechInterval(interval) },
                        testTag = "radio_speech_${interval.name}"
                    )
                }
            }

            Spacer(modifier = Modifier.height(16.dp))
        }
    }
}

@Composable
private fun SettingsCard(title: String, content: @Composable () -> Unit) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
        elevation = CardDefaults.cardElevation(defaultElevation = 2.dp)
    ) {
        Column(modifier = Modifier.padding(16.dp)) {
            Text(
                text = title,
                style = MaterialTheme.typography.titleMedium,
                color = MaterialTheme.colorScheme.primary,
                modifier = Modifier.padding(bottom = 8.dp)
            )
            content()
        }
    }
}

@Composable
private fun SwitchRow(
    label: String,
    checked: Boolean,
    onCheckedChange: (Boolean) -> Unit,
    testTag: String = ""
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = 4.dp)
            .then(if (testTag.isNotEmpty()) Modifier.testTag(testTag) else Modifier),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.SpaceBetween
    ) {
        Text(text = label, style = MaterialTheme.typography.bodyLarge, modifier = Modifier.weight(1f))
        Switch(checked = checked, onCheckedChange = onCheckedChange)
    }
}

@Composable
private fun RadioRow(
    label: String,
    selected: Boolean,
    onClick: () -> Unit,
    testTag: String = ""
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = 2.dp)
            .then(if (testTag.isNotEmpty()) Modifier.testTag(testTag) else Modifier),
        verticalAlignment = Alignment.CenterVertically
    ) {
        RadioButton(selected = selected, onClick = onClick)
        Text(text = label, style = MaterialTheme.typography.bodyLarge)
    }
}

@Composable
private fun TargetCountRow(targetCount: Int, onValueChange: (Int) -> Unit) {
    var text by remember(targetCount) { mutableStateOf(targetCount.toString()) }

    Row(
        modifier = Modifier.fillMaxWidth(),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.SpaceBetween
    ) {
        Text("目標回数", style = MaterialTheme.typography.bodyLarge)
        OutlinedTextField(
            value = text,
            onValueChange = { v ->
                text = v.filter { it.isDigit() }
                text.toIntOrNull()?.let { if (it >= 1) onValueChange(it) }
            },
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
            singleLine = true,
            modifier = Modifier
                .width(120.dp)
                .testTag("input_target_count"),
            suffix = { Text("回") }
        )
    }
}

private fun GoalNotificationMode.label() = when (this) {
    GoalNotificationMode.OFF -> "OFF"
    GoalNotificationMode.SOUND_ONLY -> "音のみ"
    GoalNotificationMode.VIBRATION_ONLY -> "バイブのみ"
    GoalNotificationMode.SOUND_AND_VIBRATION -> "音＋バイブ"
}

private fun SpeechInterval.label() = when (this) {
    SpeechInterval.OFF -> "OFF"
    SpeechInterval.EVERY_1 -> "1ごと"
    SpeechInterval.EVERY_5 -> "5ごと"
    SpeechInterval.EVERY_10 -> "10ごと"
}
