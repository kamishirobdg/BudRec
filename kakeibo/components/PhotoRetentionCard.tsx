/**
 * 設定画面の「写真の保存期間」。端末に残したレシート・食事の写真を、決めた日数を過ぎたら消す（既定は無期限）。
 * 仕様は docs/meal-nutrition-spec.md §3.5。
 */

import { useEffect, useState } from 'react';
import { Alert, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { PHOTO_RETENTION_OPTIONS, getPhotoRetentionDays, setPhotoRetentionDays } from '../services/PreferencesService';
import { cleanupOldPhotos } from '../services/PhotoStore';

function label(days: number): string {
  return days === 0 ? '無期限' : days === 365 ? '1 年' : `${days} 日`;
}

export default function PhotoRetentionCard() {
  const [days, setDays] = useState<number | null>(null);

  useEffect(() => {
    getPhotoRetentionDays().then(setDays).catch(() => setDays(0));
  }, []);

  const apply = async (next: number) => {
    try {
      await setPhotoRetentionDays(next);
      setDays(next);
      cleanupOldPhotos(next);
    } catch (e) {
      Alert.alert('保存失敗', e instanceof Error ? e.message : String(e));
    }
  };

  const handlePick = (next: number) => {
    if (next === days) return;
    // 短くすると古い写真がすぐ消えるので確かめる
    if (next !== 0 && (days === 0 || (days !== null && next < days))) {
      Alert.alert('写真の保存期間', `${label(next)}より前の写真を消します`, [
        { text: 'キャンセル', style: 'cancel' },
        { text: '消す', style: 'destructive', onPress: () => apply(next) },
      ]);
      return;
    }
    apply(next);
  };

  return (
    <>
      <Text style={styles.sectionLabel}>写真の保存期間</Text>
      <View style={styles.card}>
        <View style={styles.chips}>
          {PHOTO_RETENTION_OPTIONS.map((d) => (
            <TouchableOpacity
              key={d}
              style={[styles.chip, days === d && styles.chipActive]}
              onPress={() => handlePick(d)}
              disabled={days === null}
            >
              <Text style={[styles.chipText, days === d && styles.chipTextActive]}>{label(d)}</Text>
            </TouchableOpacity>
          ))}
        </View>
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  sectionLabel: { fontSize: 12, fontWeight: '600', color: '#888', letterSpacing: 0.5, marginBottom: 8, marginTop: 4, paddingHorizontal: 4 },
  card: { backgroundColor: '#fff', borderRadius: 16, overflow: 'hidden', marginBottom: 16, paddingHorizontal: 16, paddingVertical: 12 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { paddingHorizontal: 14, paddingVertical: 6, borderRadius: 16, borderWidth: 1, borderColor: '#d1d5db', backgroundColor: '#fff' },
  chipActive: { backgroundColor: '#2e7d32', borderColor: '#2e7d32' },
  chipText: { fontSize: 13, color: '#374151', fontWeight: '600' },
  chipTextActive: { color: '#fff' },
});
