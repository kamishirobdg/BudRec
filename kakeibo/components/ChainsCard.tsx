/** 設定画面の「チェーン店」。押すと一覧（ON/OFF・候補探し）を開く */

import { useState } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import ChainsModal from '../screens/ChainsModal';

export default function ChainsCard() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Text style={styles.sectionLabel}>外食のメニュー</Text>
      <View style={styles.card}>
        <TouchableOpacity style={styles.row} onPress={() => setOpen(true)}>
          <Text style={styles.label}>チェーン店</Text>
          <Text style={styles.arrow}>›</Text>
        </TouchableOpacity>
      </View>
      <ChainsModal visible={open} onClose={() => setOpen(false)} />
    </>
  );
}

const styles = StyleSheet.create({
  sectionLabel: { fontSize: 12, fontWeight: '600', color: '#888', letterSpacing: 0.5, marginBottom: 8, marginTop: 4, paddingHorizontal: 4 },
  card:  { backgroundColor: '#fff', borderRadius: 16, overflow: 'hidden', marginBottom: 16, paddingHorizontal: 16 },
  row:   { flexDirection: 'row', alignItems: 'center', paddingVertical: 14 },
  label: { flex: 1, fontSize: 14, color: '#1f2937' },
  arrow: { fontSize: 20, color: '#9ca3af' },
});
