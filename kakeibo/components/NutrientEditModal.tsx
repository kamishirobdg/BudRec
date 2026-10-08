import { useEffect, useMemo, useState } from 'react';
import {
  KeyboardAvoidingView, Modal, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { NUTRIENTS, Nutrients, sanitizeNutrients, scaleNutrients } from '../services/Nutrients';
import type { NutritionLabel } from '../services/LabelReader';

interface Props {
  visible: boolean;
  title:   string;
  /** 今の値（1 品全体） */
  initial: Nutrients;
  /** パッケージの表示から読んだとき。表示の単位あたりの値に、食べた量を掛けて入れる */
  label?:  NutritionLabel | null;
  onClose: () => void;
  onSave:  (nutrients: Nutrients) => void;
}

/** 食べた量の入れ方 */
type Mode = 'ratio' | 'count' | 'grams' | 'units';

function toText(n: Nutrients): Record<string, string> {
  return Object.fromEntries(Object.entries(n).filter(([, v]) => v !== null).map(([k, v]) => [k, String(Math.round(v! * 100) / 100)]));
}

function num(s: string): number | null {
  const n = Number(s.trim());
  return s.trim() !== '' && Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * 1 品の栄養を手で直す。パッケージの表示を読んだときは、食べた量を
 * 「袋の何割」「何粒（袋に何粒入りのうち）」「何 g」「表示の単位の何倍」のどれかで入れると、重さの割合で掛けた値が入る。
 */
export default function NutrientEditModal({ visible, title, initial, label, onClose, onSave }: Props) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [mode, setMode]     = useState<Mode>('units');
  const [ratio, setRatio]   = useState('100');
  const [count, setCount]   = useState('');
  const [total, setTotal]   = useState('');
  const [grams, setGrams]   = useState('');
  const [units, setUnits]   = useState('1');
  const [pkgGrams, setPkgGrams] = useState('');

  useEffect(() => {
    if (!visible) return;
    setValues(toText(label ? label.nutrients : initial));
    if (!label) return;
    setPkgGrams(label.packageGrams ? String(label.packageGrams) : '');
    setTotal(label.piecesPerPackage ? String(label.piecesPerPackage) : '');
    setCount('');
    setRatio('100');
    setUnits('1');
    setGrams(label.basis === 'per100g' ? String(label.packageGrams ?? 100) : '');
    // 袋全部の表示なら「何割」、100g あたりなら「何 g」、1 つ分の表示なら「表示の何倍（何個分）」から始める
    setMode(label.basis === 'package' ? 'ratio' : label.basis === 'per100g' ? 'grams' : 'units');
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, label]);

  /** 表示の単位の重さ（袋全部の表示なら内容量） */
  const unitGrams = label
    ? label.unitGrams ?? (label.basis === 'package' ? num(pkgGrams) : null)
    : null;

  /** 入れた量から「表示の単位の何倍か」と「何 g か」を出す。出せなければ null */
  const amount = useMemo((): { factor: number; grams: number | null } | null => {
    if (!label) return null;
    const pkg = num(pkgGrams);
    const eaten = (g: number | null) => (g !== null && unitGrams ? { factor: g / unitGrams, grams: g } : null);
    if (mode === 'units') {
      const u = num(units);
      return u === null ? null : { factor: u, grams: unitGrams ? u * unitGrams : null };
    }
    if (mode === 'grams') return eaten(num(grams));
    if (mode === 'ratio') {
      const r = num(ratio);
      if (r === null) return null;
      // 袋全部の表示なら、重さが分からなくても割合をそのまま掛けられる
      if (label.basis === 'package' && !label.unitGrams) return { factor: r / 100, grams: pkg ? (pkg * r) / 100 : null };
      return eaten(pkg !== null ? (pkg * r) / 100 : null);
    }
    // 個数: 表示が「1 粒あたり」で重さが分からなければ、粒数をそのまま掛ける
    const n = num(count);
    const t = num(total);
    if (n === null) return null;
    // 表示が「1 粒・1 食あたり」なら、食べた数をそのまま掛ける
    if (label.basis === 'piece') return { factor: n, grams: unitGrams ? n * unitGrams : null };
    if (label.basis === 'package' && !label.unitGrams && t) return { factor: n / t, grams: pkg ? (pkg * n) / t : null };
    return eaten(pkg !== null && t ? (pkg * n) / t : null);
  }, [label, mode, units, grams, ratio, count, total, pkgGrams, unitGrams]);

  // 量が決まったら、表示の値に掛け直す
  useEffect(() => {
    if (label && amount) setValues(toText(scaleNutrients(label.nutrients, amount.factor)));
  }, [label, amount]);

  const modes: { key: Mode; label: string }[] = label
    ? [
      { key: 'ratio', label: '何割' },
      { key: 'count', label: '何個・何粒' },
      { key: 'grams', label: '何 g' },
      { key: 'units', label: `表示の何倍` },
    ]
    : [];

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <SafeAreaView style={styles.container}>
        <KeyboardAvoidingView style={styles.fill} behavior="height">
          <View style={styles.header}>
            <Text style={styles.title} numberOfLines={1}>{title}</Text>
            <TouchableOpacity onPress={onClose}>
              <Text style={styles.close}>✕</Text>
            </TouchableOpacity>
          </View>
          <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
            {label && (
              <View style={styles.labelBox}>
                <Text style={styles.labelText}>表示: {label.unitLabel}</Text>
                <View style={styles.amountRow}>
                  <Text style={styles.amountLabel}>内容量</Text>
                  <TextInput style={styles.amountInput} value={pkgGrams} onChangeText={setPkgGrams} keyboardType="decimal-pad" placeholder="—" />
                  <Text style={styles.amountUnit}>g</Text>
                </View>
                <View style={styles.chips}>
                  {modes.map((m) => (
                    <TouchableOpacity key={m.key} style={[styles.chip, mode === m.key && styles.chipActive]} onPress={() => setMode(m.key)}>
                      <Text style={[styles.chipText, mode === m.key && styles.chipTextActive]}>{m.label}</Text>
                    </TouchableOpacity>
                  ))}
                </View>

                {mode === 'ratio' && (
                  <>
                    <View style={styles.amountRow}>
                      <Text style={styles.amountLabel}>袋の</Text>
                      <TextInput style={styles.amountInput} value={ratio} onChangeText={setRatio} keyboardType="decimal-pad" />
                      <Text style={styles.amountUnit}>% を食べた</Text>
                    </View>
                    <View style={styles.chips}>
                      {[25, 33, 50, 75, 100].map((p) => (
                        <TouchableOpacity key={p} style={[styles.chip, ratio === String(p) && styles.chipActive]} onPress={() => setRatio(String(p))}>
                          <Text style={[styles.chipText, ratio === String(p) && styles.chipTextActive]}>{p === 33 ? '1/3' : `${p / 10}割`}</Text>
                        </TouchableOpacity>
                      ))}
                    </View>
                  </>
                )}
                {mode === 'count' && (
                  <>
                    <View style={styles.amountRow}>
                      <TextInput style={styles.amountInput} value={count} onChangeText={setCount} keyboardType="decimal-pad" placeholder="5" />
                      <Text style={styles.amountUnit}>個（粒・枚）を食べた</Text>
                    </View>
                    {label.basis !== 'piece' && (
                      <View style={styles.amountRow}>
                        <Text style={styles.amountLabel}>1 袋に</Text>
                        <TextInput style={styles.amountInput} value={total} onChangeText={setTotal} keyboardType="decimal-pad" placeholder="20" />
                        <Text style={styles.amountUnit}>個入り（だいたいで良い）</Text>
                      </View>
                    )}
                  </>
                )}
                {mode === 'grams' && (
                  <View style={styles.amountRow}>
                    <TextInput style={styles.amountInput} value={grams} onChangeText={setGrams} keyboardType="decimal-pad" />
                    <Text style={styles.amountUnit}>g を食べた</Text>
                  </View>
                )}
                {mode === 'units' && (
                  <View style={styles.amountRow}>
                    <TextInput style={styles.amountInput} value={units} onChangeText={setUnits} keyboardType="decimal-pad" />
                    <Text style={styles.amountUnit}>× {label.unitLabel.replace(/あたり$/, '')}</Text>
                  </View>
                )}
                <Text style={amount ? styles.result : styles.resultMissing}>
                  {amount
                    ? `${amount.grams !== null ? `約 ${Math.round(amount.grams)}g・` : ''}表示の ${Math.round(amount.factor * 100) / 100} 倍`
                    : '内容量か入り数が分からないので計算できません（入れてください）'}
                </Text>
              </View>
            )}
            <Text style={styles.hint}>1 品全体の値（二人で分けた料理は、割合で分けて記録します）</Text>
            {NUTRIENTS.map((n) => (
              <View key={n.key} style={styles.row}>
                <Text style={styles.label}>{n.label}</Text>
                <TextInput
                  style={styles.input}
                  value={values[n.key] ?? ''}
                  onChangeText={(t) => setValues((prev) => ({ ...prev, [n.key]: t }))}
                  keyboardType="decimal-pad"
                  placeholder="—"
                />
                <Text style={styles.unit}>{n.unit}</Text>
              </View>
            ))}
            <TouchableOpacity style={styles.save} onPress={() => onSave(sanitizeNutrients(values))}>
              <Text style={styles.saveText}>この値にする</Text>
            </TouchableOpacity>
          </ScrollView>
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
  title:  { flex: 1, fontSize: 16, fontWeight: 'bold', color: '#1a1a1a' },
  close:  { fontSize: 20, color: '#666', paddingHorizontal: 8 },
  body:   { padding: 16, gap: 6, paddingBottom: 40 },
  labelBox:    { backgroundColor: '#fff', borderRadius: 12, padding: 12, gap: 8 },
  labelText:   { fontSize: 13, color: '#374151' },
  amountRow:   { flexDirection: 'row', alignItems: 'center', gap: 8 },
  amountLabel: { fontSize: 13, color: '#374151', fontWeight: '600' },
  amountInput: {
    width: 80, textAlign: 'right', fontSize: 15, borderWidth: 1, borderColor: '#e5e7eb', borderRadius: 8,
    paddingHorizontal: 8, paddingVertical: 4, color: '#1f2937',
  },
  amountUnit:  { flex: 1, fontSize: 13, color: '#6b7280' },
  chips:       { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  chip:        { paddingHorizontal: 12, paddingVertical: 4, borderRadius: 14, borderWidth: 1, borderColor: '#d1d5db', backgroundColor: '#fff' },
  chipActive:     { backgroundColor: '#2e7d32', borderColor: '#2e7d32' },
  chipText:       { fontSize: 12, color: '#374151', fontWeight: '600' },
  chipTextActive: { color: '#fff' },
  result:        { fontSize: 13, color: '#2e7d32', fontWeight: '700' },
  resultMissing: { fontSize: 12, color: '#b45309' },
  hint:   { fontSize: 12, color: '#6b7280', marginTop: 4 },
  row:    { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: '#fff', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 4 },
  label:  { flex: 1, fontSize: 13, color: '#1f2937' },
  input: {
    width: 90, textAlign: 'right', fontSize: 13, borderWidth: 1, borderColor: '#e5e7eb', borderRadius: 6,
    paddingHorizontal: 6, paddingVertical: 3, color: '#1f2937',
  },
  unit:   { width: 32, fontSize: 11, color: '#6b7280' },
  save:     { backgroundColor: '#2e7d32', borderRadius: 12, paddingVertical: 13, alignItems: 'center', marginTop: 12 },
  saveText: { color: '#fff', fontSize: 14, fontWeight: 'bold' },
});
