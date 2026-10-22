/** 設定画面の「タブ」。タブごとに表示・非表示と並び順を選ぶ（この端末だけ） */

import { useEffect, useState } from 'react';
import { Alert, StyleSheet, Switch, Text, TouchableOpacity, View } from 'react-native';
import { TAB_LABELS, TabKey, TabLayout, getTabLayout, setTabLayout } from '../services/PreferencesService';

export default function TabLayoutCard() {
  const [layout, setLayout] = useState<TabLayout | null>(null);

  useEffect(() => {
    getTabLayout().then(setLayout).catch(() => {});
  }, []);

  if (!layout) return null;

  const apply = (next: TabLayout) => {
    setLayout(next);
    setTabLayout(next).catch((e) => Alert.alert('保存失敗', e instanceof Error ? e.message : String(e)));
  };

  const toggle = (key: TabKey) => {
    const hidden = layout.hidden.includes(key) ? layout.hidden.filter((k) => k !== key) : [...layout.hidden, key];
    if (hidden.length >= layout.order.length) {
      Alert.alert('1 つ以上のタブを表示してください');
      return;
    }
    apply({ ...layout, hidden });
  };

  const move = (index: number, delta: number) => {
    const to = index + delta;
    if (to < 0 || to >= layout.order.length) return;
    const order = [...layout.order];
    [order[index], order[to]] = [order[to], order[index]];
    apply({ ...layout, order });
  };

  return (
    <>
      <Text style={styles.sectionLabel}>タブ</Text>
      <View style={styles.card}>
        {layout.order.map((key, i) => (
          <View key={key} style={[styles.row, i > 0 && styles.rowBorder]}>
            <Switch
              value={!layout.hidden.includes(key)}
              onValueChange={() => toggle(key)}
              trackColor={{ false: '#ccc', true: '#a5d6a7' }}
              thumbColor={!layout.hidden.includes(key) ? '#2e7d32' : '#f4f3f4'}
            />
            <Text style={[styles.label, layout.hidden.includes(key) && styles.labelHidden]}>{TAB_LABELS[key]}</Text>
            <TouchableOpacity style={styles.arrow} onPress={() => move(i, -1)} disabled={i === 0}>
              <Text style={[styles.arrowText, i === 0 && styles.arrowDisabled]}>↑</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.arrow} onPress={() => move(i, 1)} disabled={i === layout.order.length - 1}>
              <Text style={[styles.arrowText, i === layout.order.length - 1 && styles.arrowDisabled]}>↓</Text>
            </TouchableOpacity>
          </View>
        ))}
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  sectionLabel: { fontSize: 12, fontWeight: '600', color: '#888', letterSpacing: 0.5, marginBottom: 8, marginTop: 4, paddingHorizontal: 4 },
  card: { backgroundColor: '#fff', borderRadius: 16, overflow: 'hidden', marginBottom: 16, paddingHorizontal: 16 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 8 },
  rowBorder: { borderTopWidth: 1, borderTopColor: '#f0f0f0' },
  label: { flex: 1, fontSize: 14, color: '#1f2937' },
  labelHidden: { color: '#9ca3af' },
  arrow: { paddingHorizontal: 10, paddingVertical: 4 },
  arrowText: { fontSize: 18, color: '#2e7d32', fontWeight: '700' },
  arrowDisabled: { color: '#d1d5db' },
});
