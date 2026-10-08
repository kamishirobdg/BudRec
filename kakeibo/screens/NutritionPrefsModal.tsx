import { useEffect, useState } from 'react';
import {
  ActivityIndicator, Alert, FlatList, KeyboardAvoidingView, Modal, StyleSheet, Switch, Text, TextInput,
  TouchableOpacity, View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { NUTRIENTS } from '../services/Nutrients';
import { Activity, NutritionPrefs, Sex, normalizeBirthDate, savePrefs } from '../services/NutritionPrefsService';

const ACTIVITY_LABEL: Record<Activity, string> = { I: '低い', II: 'ふつう', III: '高い' };

interface Props {
  /** 設定する人（null なら閉じている） */
  user:    string | null;
  prefs:   NutritionPrefs;
  onClose: () => void;
  onSaved: (prefs: NutritionPrefs) => void;
}

/** 食事の一覧に出す栄養素と、1 日の目標値を選ぶ（人ごと。両方の端末で同じ設定になる） */
export default function NutritionPrefsModal({ user, prefs, onClose, onSaved }: Props) {
  const [visible, setVisible] = useState<string[]>(prefs.visible);
  const [targets, setTargets] = useState<Record<string, string>>({});
  const [birthDate, setBirthDate] = useState('');
  const [sex, setSex]             = useState<Sex | null>(null);
  const [activity, setActivity]   = useState<Activity>('II');
  const [saving, setSaving]   = useState(false);

  // 開いたときだけ読み込む（開いている間に一覧が読み直されても入力中の値を戻さない）
  useEffect(() => {
    if (!user) return;
    setVisible(prefs.visible);
    setTargets(Object.fromEntries(Object.entries(prefs.targets).map(([k, v]) => [k, String(v)])));
    setBirthDate(prefs.profile.birthDate ? prefs.profile.birthDate.replace(/-/g, '/') : '');
    setSex(prefs.profile.sex);
    setActivity(prefs.profile.activity);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  const toggle = (key: string) =>
    setVisible((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]));

  const handleSave = async () => {
    if (!user) return;
    if (visible.length === 0) {
      Alert.alert('表示する栄養素を 1 つ以上選んでください');
      return;
    }
    const parsed: Record<string, number> = {};
    for (const [k, v] of Object.entries(targets)) {
      const n = Number(v.trim());
      if (v.trim() !== '' && Number.isFinite(n) && n > 0) parsed[k] = n;
    }
    // 表示の順番は栄養素の定義順にそろえる
    const date = normalizeBirthDate(birthDate);
    if (birthDate.trim() !== '' && date === null) {
      Alert.alert('生年月日を「1990/4/15」の形で入れてください');
      return;
    }
    const next: NutritionPrefs = {
      visible: NUTRIENTS.map((n) => n.key).filter((k) => visible.includes(k)),
      targets: parsed,
      profile: { birthDate: date, sex, activity },
    };
    setSaving(true);
    try {
      await savePrefs(user, next);
      onSaved(next);
    } catch (e) {
      Alert.alert('保存失敗', e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal visible={user !== null} animationType="slide" onRequestClose={onClose}>
      <SafeAreaView style={styles.container}>
        {/* Android のモーダルは adjustResize が効かないので、キーボードぶん縮める */}
        <KeyboardAvoidingView style={styles.fill} behavior="height">
          <View style={styles.header}>
            <Text style={styles.title}>{user} の表示</Text>
            <TouchableOpacity onPress={onClose}>
              <Text style={styles.close}>✕</Text>
            </TouchableOpacity>
          </View>
          <FlatList
            ListHeaderComponent={
              <>
                {/* 食事摂取基準の値を選ぶのに使う */}
                <View style={styles.profile}>
                  <View style={styles.profileRow}>
                    <Text style={styles.profileLabel}>生年月日</Text>
                    <TextInput
                      style={styles.yearInput}
                      value={birthDate}
                      onChangeText={setBirthDate}
                      keyboardType="numbers-and-punctuation"
                      placeholder="1990/4/15"
                      maxLength={10}
                    />
                  </View>
                  <View style={styles.profileRow}>
                    <Text style={styles.profileLabel}>性別</Text>
                    {(['male', 'female'] as const).map((v) => (
                      <TouchableOpacity key={v} style={[styles.chip, sex === v && styles.chipActive]} onPress={() => setSex(v)}>
                        <Text style={[styles.chipText, sex === v && styles.chipTextActive]}>{v === 'male' ? '男性' : '女性'}</Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                  <View style={styles.profileRow}>
                    <Text style={styles.profileLabel}>活動量</Text>
                    {(['I', 'II', 'III'] as const).map((v) => (
                      <TouchableOpacity key={v} style={[styles.chip, activity === v && styles.chipActive]} onPress={() => setActivity(v)}>
                        <Text style={[styles.chipText, activity === v && styles.chipTextActive]}>{ACTIVITY_LABEL[v]}</Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                </View>
                <View style={styles.colHead}>
                  <Text style={styles.colHeadText}>表示する栄養素</Text>
                  <Text style={[styles.colHeadText, styles.targetHead]}>自分の目標</Text>
                </View>
              </>
            }
            data={NUTRIENTS}
            keyExtractor={(n) => n.key}
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={styles.list}
            renderItem={({ item }) => (
              <View style={styles.row}>
                <Switch
                  value={visible.includes(item.key)}
                  onValueChange={() => toggle(item.key)}
                  trackColor={{ false: '#ccc', true: '#a5d6a7' }}
                  thumbColor={visible.includes(item.key) ? '#2e7d32' : '#f4f3f4'}
                />
                <Text style={styles.label}>{item.label}</Text>
                <TextInput
                  style={styles.target}
                  value={targets[item.key] ?? ''}
                  onChangeText={(t) => setTargets((prev) => ({ ...prev, [item.key]: t }))}
                  keyboardType="decimal-pad"
                  placeholder="—"
                />
                <Text style={styles.unit}>{item.unit}</Text>
              </View>
            )}
          />
          <TouchableOpacity style={[styles.saveBtn, saving && styles.disabled]} onPress={handleSave} disabled={saving}>
            {saving ? <ActivityIndicator color="#fff" /> : <Text style={styles.saveText}>保存</Text>}
          </TouchableOpacity>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f2f4f7' },
  fill:      { flex: 1 },
  header: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingHorizontal: 16, paddingVertical: 12, backgroundColor: '#fff',
  },
  title:  { fontSize: 16, fontWeight: 'bold', color: '#1a1a1a' },
  close:  { fontSize: 20, color: '#666', paddingHorizontal: 8 },
  colHead: { flexDirection: 'row', paddingTop: 10, paddingBottom: 4 },
  profile:      { backgroundColor: '#fff', borderRadius: 12, padding: 12, gap: 10 },
  profileRow:   { flexDirection: 'row', alignItems: 'center', gap: 8 },
  profileLabel: { width: 80, fontSize: 13, color: '#374151' },
  yearInput: {
    width: 120, fontSize: 14, borderWidth: 1, borderColor: '#e5e7eb', borderRadius: 8,
    paddingHorizontal: 8, paddingVertical: 4, color: '#1f2937',
  },
  chip:           { paddingHorizontal: 12, paddingVertical: 4, borderRadius: 14, borderWidth: 1, borderColor: '#d1d5db', backgroundColor: '#fff' },
  chipActive:     { backgroundColor: '#2e7d32', borderColor: '#2e7d32' },
  chipText:       { fontSize: 13, color: '#374151', fontWeight: '600' },
  chipTextActive: { color: '#fff' },
  colHeadText: { fontSize: 12, color: '#888', fontWeight: '600' },
  targetHead: { marginLeft: 'auto', marginRight: 40 },
  list:   { padding: 16, paddingTop: 6, gap: 6 },
  row:    { flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: '#fff', borderRadius: 12, paddingHorizontal: 12, paddingVertical: 6 },
  label:  { flex: 1, fontSize: 14, color: '#1f2937' },
  target: {
    width: 80, textAlign: 'right', fontSize: 14, borderWidth: 1, borderColor: '#e5e7eb', borderRadius: 8,
    paddingHorizontal: 8, paddingVertical: 4, color: '#1f2937',
  },
  unit:   { width: 32, fontSize: 12, color: '#6b7280' },
  saveBtn:  { backgroundColor: '#2e7d32', borderRadius: 12, paddingVertical: 14, alignItems: 'center', margin: 16 },
  saveText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  disabled: { opacity: 0.6 },
});
