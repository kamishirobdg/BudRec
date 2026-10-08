import { useEffect, useState } from 'react';
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

function toText(n: Nutrients): Record<string, string> {
  return Object.fromEntries(Object.entries(n).filter(([, v]) => v !== null).map(([k, v]) => [k, String(Math.round(v! * 100) / 100)]));
}

/** 1 品の栄養を手で直す（パッケージの表示を読んだときは、食べた量を入れると掛けた値が入る） */
export default function NutrientEditModal({ visible, title, initial, label, onClose, onSave }: Props) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [amount, setAmount] = useState('1');

  const per100 = label?.basis === 'per100g';

  useEffect(() => {
    if (!visible) return;
    const start = label ? (per100 ? '100' : '1') : '1';
    setAmount(start);
    setValues(toText(label ? label.nutrients : initial));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, label]);

  /** 食べた量を変えたら、表示の値に掛け直す */
  const changeAmount = (t: string) => {
    setAmount(t);
    const n = Number(t);
    if (!label || !(n > 0)) return;
    setValues(toText(scaleNutrients(label.nutrients, per100 ? n / 100 : n)));
  };

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
                <Text style={styles.labelText}>
                  表示: {label.unitLabel}{label.content ? `（内容量 ${label.content}）` : ''}
                </Text>
                <View style={styles.amountRow}>
                  <Text style={styles.amountLabel}>食べた量</Text>
                  <TextInput style={styles.amountInput} value={amount} onChangeText={changeAmount} keyboardType="decimal-pad" />
                  <Text style={styles.amountUnit}>{per100 ? 'g' : `× ${label.unitLabel.replace(/あたり$/, '')}`}</Text>
                </View>
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
