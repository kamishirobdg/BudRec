package com.example.squatcounter.ui.settings

import android.app.Activity
import android.content.Intent
import android.media.RingtoneManager
import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.MusicNote
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import com.example.squatcounter.data.*
import java.util.Locale

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingsScreen(
    onBack: () -> Unit,
    vm: SettingsViewModel = viewModel()
) {
    val settings by vm.settings.collectAsStateWithLifecycle()

    val ringtoneLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result ->
        if (result.resultCode == Activity.RESULT_OK) {
            val uri = result.data?.getParcelableExtra<Uri>(RingtoneManager.EXTRA_RINGTONE_PICKED_URI)
            vm.setNotificationSoundUri(uri?.toString() ?: "")
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("設定") },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, "戻る")
                    }
                }
            )
        }
    ) { padding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
                .verticalScroll(rememberScrollState())
                .padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp)
        ) {
            // カウント設定
            SettingSection("カウント設定") {
                GoalCountField(settings.goalCount, vm::setGoalCount)
                RowSwitch("達成時にメモ入力を求める", settings.requireMemoOnAchieve, vm::setRequireMemo)
            }

            // アプリ音量
            SettingSection("アプリ音量") {
                Column {
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        Text("音量", modifier = Modifier.weight(1f))
                        Text("${(settings.appVolume * 100).toInt()}%", fontSize = 14.sp)
                    }
                    Slider(
                        value = settings.appVolume,
                        onValueChange = vm::setAppVolume,
                        valueRange = 0f..1f,
                        modifier = Modifier.fillMaxWidth()
                    )
                }
            }

            // 物理キー設定
            SettingSection("物理キー設定") {
                LabeledRadioButton(
                    selected = !settings.invertVolumeKeys,
                    onClick = { vm.setInvertVolumeKeys(false) },
                    label = "通常（音量↑ = +1）"
                )
                LabeledRadioButton(
                    selected = settings.invertVolumeKeys,
                    onClick = { vm.setInvertVolumeKeys(true) },
                    label = "反転（音量↑ = −1）"
                )
            }

            // 目標到達通知
            SettingSection("目標到達通知") {
                NotificationMode.entries.forEach { mode ->
                    LabeledRadioButton(
                        selected = settings.notificationMode == mode,
                        onClick = { vm.setNotificationMode(mode) },
                        label = mode.label()
                    )
                }
                TextButton(
                    onClick = {
                        val currentUri = settings.notificationSoundUri
                            .let { if (it.isEmpty()) null else Uri.parse(it) }
                        val intent = Intent(RingtoneManager.ACTION_RINGTONE_PICKER).apply {
                            putExtra(RingtoneManager.EXTRA_RINGTONE_TYPE, RingtoneManager.TYPE_NOTIFICATION)
                            putExtra(RingtoneManager.EXTRA_RINGTONE_TITLE, "通知音を選択")
                            putExtra(RingtoneManager.EXTRA_RINGTONE_SHOW_SILENT, false)
                            putExtra(RingtoneManager.EXTRA_RINGTONE_EXISTING_URI, currentUri)
                        }
                        ringtoneLauncher.launch(intent)
                    }
                ) {
                    Icon(Icons.Default.MusicNote, null)
                    Spacer(Modifier.width(4.dp))
                    Text("通知音を選択")
                }
                if (settings.notificationSoundUri.isNotEmpty()) {
                    Text(
                        "選択中: ${ringtoneLabel(settings.notificationSoundUri)}",
                        fontSize = 12.sp,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
            }

            // 読み上げ設定
            SettingSection("読み上げ設定") {
                ReadAloudMode.entries.forEach { mode ->
                    LabeledRadioButton(
                        selected = settings.readAloudMode == mode,
                        onClick = { vm.setReadAloudMode(mode) },
                        label = mode.label()
                    )
                }
                // 言語選択
                val locales = remember { vm.getAvailableLocales() }
                if (locales.isNotEmpty()) {
                    var expanded by remember { mutableStateOf(false) }
                    val currentLabel = if (settings.readAloudLanguageBcp47.isEmpty()) "端末設定に従う"
                    else locales.find { it.toLanguageTag() == settings.readAloudLanguageBcp47 }?.displayName
                        ?: settings.readAloudLanguageBcp47

                    ExposedDropdownMenuBox(expanded = expanded, onExpandedChange = { expanded = it }) {
                        OutlinedTextField(
                            value = currentLabel,
                            onValueChange = {},
                            readOnly = true,
                            label = { Text("読み上げ言語") },
                            trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(expanded) },
                            modifier = Modifier
                                .menuAnchor()
                                .fillMaxWidth()
                        )
                        ExposedDropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }) {
                            DropdownMenuItem(
                                text = { Text("端末設定に従う") },
                                onClick = { vm.setReadAloudLanguage(""); expanded = false }
                            )
                            locales.forEach { locale ->
                                DropdownMenuItem(
                                    text = { Text(locale.displayName) },
                                    onClick = { vm.setReadAloudLanguage(locale.toLanguageTag()); expanded = false }
                                )
                            }
                        }
                    }
                }
            }

            // スクワット補助
            SettingSection("スクワット補助") {
                RowSwitch("スクワット補助モード", settings.squatAssistEnabled, vm::setSquatAssistEnabled)

                SoundTypeSelector(
                    label = "腰を下ろす（2秒）",
                    selected = settings.squatSoundDown,
                    onSelect = vm::setSquatSoundDown,
                    onPreview = { vm.previewSound(settings.squatSoundDown) }
                )
                SoundTypeSelector(
                    label = "止める（1秒）",
                    selected = settings.squatSoundHold,
                    onSelect = vm::setSquatSoundHold,
                    onPreview = { vm.previewSound(settings.squatSoundHold) }
                )
                SoundTypeSelector(
                    label = "腰を上げる（2秒）",
                    selected = settings.squatSoundUp,
                    onSelect = vm::setSquatSoundUp,
                    onPreview = { vm.previewSound(settings.squatSoundUp) }
                )
            }

            Spacer(Modifier.height(16.dp))
        }
    }
}

@Composable
private fun SettingSection(title: String, content: @Composable ColumnScope.() -> Unit) {
    Card(modifier = Modifier.fillMaxWidth()) {
        Column(modifier = Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(title, fontSize = 16.sp, fontWeight = FontWeight.Bold, color = MaterialTheme.colorScheme.primary)
            content()
        }
    }
}

@Composable
private fun GoalCountField(value: Int, onSet: (Int) -> Unit) {
    var text by remember(value) { mutableStateOf(value.toString()) }
    Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth()) {
        Text("目標回数", modifier = Modifier.weight(1f))
        OutlinedTextField(
            value = text,
            onValueChange = { s ->
                text = s
                s.toIntOrNull()?.let { if (it > 0) onSet(it) }
            },
            suffix = { Text("回") },
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
            modifier = Modifier.width(120.dp),
            singleLine = true
        )
    }
}

@Composable
private fun RowSwitch(label: String, checked: Boolean, onChecked: (Boolean) -> Unit) {
    Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth()) {
        Text(label, modifier = Modifier.weight(1f))
        Switch(checked = checked, onCheckedChange = onChecked)
    }
}

@Composable
private fun LabeledRadioButton(selected: Boolean, onClick: () -> Unit, label: String) {
    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier.fillMaxWidth()
    ) {
        RadioButton(selected = selected, onClick = onClick)
        Text(label, modifier = Modifier.padding(start = 8.dp))
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun SoundTypeSelector(
    label: String,
    selected: SoundType,
    onSelect: (SoundType) -> Unit,
    onPreview: () -> Unit
) {
    var expanded by remember { mutableStateOf(false) }
    Column(modifier = Modifier.fillMaxWidth()) {
        Text(label, fontSize = 13.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Row(verticalAlignment = Alignment.CenterVertically) {
            ExposedDropdownMenuBox(
                expanded = expanded,
                onExpandedChange = { expanded = it },
                modifier = Modifier.weight(1f)
            ) {
                OutlinedTextField(
                    value = selected.label(),
                    onValueChange = {},
                    readOnly = true,
                    trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(expanded) },
                    modifier = Modifier
                        .menuAnchor()
                        .fillMaxWidth(),
                    singleLine = true
                )
                ExposedDropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }) {
                    SoundType.entries.forEach { type ->
                        DropdownMenuItem(
                            text = { Text(type.label()) },
                            onClick = { onSelect(type); expanded = false }
                        )
                    }
                }
            }
            IconButton(onClick = onPreview) {
                Icon(Icons.Default.PlayArrow, "プレビュー")
            }
        }
    }
}

private fun NotificationMode.label() = when (this) {
    NotificationMode.OFF -> "OFF"
    NotificationMode.SOUND_ONLY -> "音のみ"
    NotificationMode.VIBRATION_ONLY -> "バイブのみ"
    NotificationMode.SOUND_AND_VIBRATION -> "音+バイブ"
}

private fun ReadAloudMode.label() = when (this) {
    ReadAloudMode.OFF -> "OFF"
    ReadAloudMode.EVERY_1 -> "1ごと"
    ReadAloudMode.EVERY_5 -> "5ごと"
    ReadAloudMode.EVERY_10 -> "10ごと"
}

private fun SoundType.label() = when (this) {
    SoundType.BEEP_LOW        -> "ビープ（低）"
    SoundType.BEEP_HIGH       -> "ビープ（高）"
    SoundType.CLICK           -> "クリック"
    SoundType.BEEP_LOW_SOFT   -> "ビープ（低・ソフト）"
    SoundType.BEEP_HIGH_SOFT  -> "ビープ（高・ソフト）"
    SoundType.METRONOME_4BEAT -> "メトロノーム（4拍）"
    SoundType.METRONOME_NOISE -> "メトロノーム（ノイズ）"
    SoundType.SWEEP_UP        -> "スイープ（上昇）"
    SoundType.SWEEP_DOWN      -> "スイープ（下降）"
    SoundType.SILENT          -> "無音"
}

@Composable
private fun ringtoneLabel(uriString: String): String {
    // RingtoneManager.getRingtone はここでは呼べないので URI末尾を表示
    return uriString.substringAfterLast("/")
}
