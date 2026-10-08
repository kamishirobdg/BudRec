import { useEffect, useState } from 'react';
import {
  ActivityIndicator, Alert, KeyboardAvoidingView, Modal, ScrollView, StyleSheet, Text, TextInput,
  TouchableOpacity, View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as ImagePicker from 'expo-image-picker';
import { NUTRIENTS, Nutrients, nutrientDef, sanitizeNutrients } from '../services/Nutrients';
import {
  Supplement, readSupplementLabel, saveSupplement, stopSupplement,
} from '../services/SupplementService';
import { today } from '../services/NutritionJudge';

interface Props {
  visible:     boolean;
  user:        string;
  supplements: Supplement[];
  onClose:     () => void;
  /** 登録・変更・やめたあと（一覧を読み直す） */
  onChanged:   () => void;
}

interface Draft {
  base:      Supplement | null;
  name:      string;
  unit:      string;
  perDay:    string;
  nutrients: Record<string, string>;
}

const EMPTY: Draft = { base: null, name: '', unit: '粒', perDay: '1', nutrients: {} };

function toDraft(s: Supplement): Draft {
  return {
    base: s, name: s.name, unit: s.unit, perDay: String(s.perDay),
    nutrients: Object.fromEntries(Object.entries(s.nutrients).filter(([, v]) => v !== null).map(([k, v]) => [k, String(v)])),
  };
}

/** 主な栄養（一覧に出す） */
function summary(n: Nutrients): string {
  return Object.entries(n)
    .filter(([, v]) => v !== null && v > 0)
    .slice(0, 4)
    .map(([k, v]) => `${nutrientDef(k)?.label ?? k} ${Math.round(v! * 100) / 100}${nutrientDef(k)?.unit ?? ''}`)
    .join('・');
}

/** サプリの登録。登録したサプリの 1 日分は毎日の合計に自動で足す（その日の画面で飲まなかった日だけ外せる） */
export default function SupplementsModal({ visible, user, supplements, onClose, onChanged }: Props) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy]   = useState(false);

  useEffect(() => { if (!visible) setDraft(null); }, [visible]);

  const mine = supplements.filter((s) => s.user === user);
  const active = mine.filter((s) => !s.ended || s.ended >= today());

  const readLabel = async (fromCamera: boolean) => {
    try {
      const opts: ImagePicker.ImagePickerOptions = { base64: true, quality: 0.85, mediaTypes: ['images'] };
      if (fromCamera) {
        const perm = await ImagePicker.requestCameraPermissionsAsync();
        if (!perm.granted) return;
      }
      const res = fromCamera ? await ImagePicker.launchCameraAsync(opts) : await ImagePicker.launchImageLibraryAsync(opts);
      const base64 = res.canceled ? null : res.assets[0]?.base64;
      if (!base64) return;
      setBusy(true);
      const label = await readSupplementLabel(base64);
      setDraft((d) => ({
        ...(d ?? EMPTY),
        name: label.name || d?.name || '',
        unit: label.unit,
        perDay: String(label.perDay),
        nutrients: Object.fromEntries(Object.entries(label.nutrients).filter(([, v]) => v !== null).map(([k, v]) => [k, String(v)])),
      }));
    } catch (e) {
      Alert.alert('読み取れませんでした', e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const handleSave = async () => {
    if (!draft) return;
    const name = draft.name.trim();
    const perDay = Number(draft.perDay);
    if (!name) { Alert.alert('名前を入れてください'); return; }
    if (!(perDay > 0)) { Alert.alert('1 日の量を入れてください'); return; }
    setBusy(true);
    try {
      await saveSupplement({
        supplementId: draft.base?.supplementId, rowIndex: draft.base?.rowIndex, user, name,
        unit: draft.unit.trim() || '粒', perDay,
        nutrients: sanitizeNutrients(draft.nutrients),
        started: draft.base?.started || today(), ended: draft.base?.ended ?? '', note: draft.base?.note ?? '',
      });
      setDraft(null);
      onChanged();
    } catch (e) {
      Alert.alert('保存失敗', e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const handleStop = (s: Supplement) => {
    Alert.alert(s.name, '今日でやめますか？（今日までの記録には残ります）', [
      { text: 'キャンセル', style: 'cancel' },
      {
        text: 'やめる', style: 'destructive', onPress: async () => {
          try {
            await stopSupplement(s);
            onChanged();
          } catch (e) {
            Alert.alert('保存失敗', e instanceof Error ? e.message : String(e));
          }
        },
      },
    ]);
  };

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={draft ? () => setDraft(null) : onClose}>
      <SafeAreaView style={styles.container}>
        <KeyboardAvoidingView style={styles.fill} behavior="height">
          <View style={styles.header}>
            <Text style={styles.title}>{draft ? (draft.base ? 'サプリを編集' : 'サプリを登録') : 'サプリ'}</Text>
            <TouchableOpacity onPress={draft ? () => setDraft(null) : onClose}>
              <Text style={styles.close}>{draft ? '戻る' : '✕'}</Text>
            </TouchableOpacity>
          </View>

          {!draft ? (
            <ScrollView contentContainerStyle={styles.body}>
              {active.length === 0 && <Text style={styles.empty}>登録したサプリはありません</Text>}
              {active.map((s) => (
                <View key={s.supplementId} style={styles.card}>
                  <Text style={styles.name}>{s.name}</Text>
                  <Text style={styles.meta}>1 日 {s.perDay} {s.unit}　{summary(s.nutrients)}</Text>
                  <View style={styles.actions}>
                    <TouchableOpacity style={styles.btn} onPress={() => setDraft(toDraft(s))}>
                      <Text style={styles.btnText}>編集</Text>
                    </TouchableOpacity>
                    <TouchableOpacity style={styles.btn} onPress={() => handleStop(s)}>
                      <Text style={[styles.btnText, styles.danger]}>やめる</Text>
                    </TouchableOpacity>
                  </View>
                </View>
              ))}
              <TouchableOpacity style={styles.primary} onPress={() => setDraft({ ...EMPTY })}>
                <Text style={styles.primaryText}>サプリを登録</Text>
              </TouchableOpacity>
            </ScrollView>
          ) : (
            <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
              <View style={styles.row}>
                <TouchableOpacity style={[styles.btn, styles.flex]} onPress={() => readLabel(true)} disabled={busy}>
                  <Text style={styles.btnText}>ラベルを撮って読む</Text>
                </TouchableOpacity>
                <TouchableOpacity style={[styles.btn, styles.flex]} onPress={() => readLabel(false)} disabled={busy}>
                  <Text style={styles.btnText}>写真から読む</Text>
                </TouchableOpacity>
              </View>
              {busy && <ActivityIndicator />}
              <Text style={styles.label}>名前</Text>
              <TextInput style={styles.input} value={draft.name} onChangeText={(t) => setDraft({ ...draft, name: t })} />
              <View style={styles.row}>
                <View style={styles.flex}>
                  <Text style={styles.label}>1 日の量</Text>
                  <TextInput style={styles.input} value={draft.perDay} keyboardType="decimal-pad"
                    onChangeText={(t) => setDraft({ ...draft, perDay: t })} />
                </View>
                <View style={styles.flex}>
                  <Text style={styles.label}>単位</Text>
                  <TextInput style={styles.input} value={draft.unit} onChangeText={(t) => setDraft({ ...draft, unit: t })} />
                </View>
              </View>
              <Text style={styles.label}>1 {draft.unit || '粒'}あたりの栄養（分かるものだけ）</Text>
              {NUTRIENTS.map((n) => (
                <View key={n.key} style={styles.nutRow}>
                  <Text style={styles.nutLabel}>{n.label}</Text>
                  <TextInput
                    style={styles.nutInput}
                    value={draft.nutrients[n.key] ?? ''}
                    keyboardType="decimal-pad"
                    placeholder="—"
                    onChangeText={(t) => setDraft({ ...draft, nutrients: { ...draft.nutrients, [n.key]: t } })}
                  />
                  <Text style={styles.nutUnit}>{n.unit}</Text>
                </View>
              ))}
              <TouchableOpacity style={[styles.primary, busy && styles.disabled]} onPress={handleSave} disabled={busy}>
                <Text style={styles.primaryText}>保存</Text>
              </TouchableOpacity>
            </ScrollView>
          )}
        </KeyboardAvoidingView>
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f2f4f7' },
  fill:      { flex: 1 },
  flex:      { flex: 1 },
  header: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingHorizontal: 16, paddingVertical: 12, backgroundColor: '#fff',
  },
  title:   { fontSize: 16, fontWeight: 'bold', color: '#1a1a1a' },
  close:   { fontSize: 16, color: '#2563eb', paddingHorizontal: 8 },
  body:    { padding: 16, gap: 8, paddingBottom: 40 },
  empty:   { textAlign: 'center', color: '#888', marginVertical: 16 },
  card:    { backgroundColor: '#fff', borderRadius: 12, padding: 12, gap: 4 },
  name:    { fontSize: 15, fontWeight: '600', color: '#111' },
  meta:    { fontSize: 12, color: '#6b7280' },
  actions: { flexDirection: 'row', gap: 8, marginTop: 4 },
  row:     { flexDirection: 'row', gap: 8 },
  btn: {
    borderWidth: 1, borderColor: '#d1d5db', borderRadius: 8, paddingHorizontal: 12, paddingVertical: 8,
    backgroundColor: '#fff', alignItems: 'center',
  },
  btnText: { fontSize: 13, fontWeight: '600', color: '#1f2937' },
  danger:  { color: '#ef4444' },
  label:   { fontSize: 12, color: '#6b7280', marginTop: 6 },
  input: {
    backgroundColor: '#fff', borderRadius: 10, borderWidth: 1, borderColor: '#e5e7eb',
    paddingHorizontal: 12, paddingVertical: 8, fontSize: 14, color: '#1f2937',
  },
  nutRow:   { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: '#fff', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 4 },
  nutLabel: { flex: 1, fontSize: 13, color: '#1f2937' },
  nutInput: {
    width: 90, textAlign: 'right', fontSize: 13, borderWidth: 1, borderColor: '#e5e7eb', borderRadius: 6,
    paddingHorizontal: 6, paddingVertical: 3, color: '#1f2937',
  },
  nutUnit:  { width: 32, fontSize: 11, color: '#6b7280' },
  primary:     { backgroundColor: '#2e7d32', borderRadius: 12, paddingVertical: 13, alignItems: 'center', marginTop: 12 },
  primaryText: { color: '#fff', fontSize: 14, fontWeight: 'bold' },
  disabled:    { opacity: 0.6 },
});
