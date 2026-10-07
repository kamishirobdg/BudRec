import { useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import ZoomableImage from './ZoomableImage';
import { localUri, receiptPhotoUri } from '../services/PhotoStore';
import { cachedUri, fetchShared, listShared } from '../services/SharedPhotos';

interface Props {
  mealId:    string;
  photoRefs: string[];
  entryIds:  string[];
  height:    number;
  /** 共有前の手入力など、まだ食事に付いていない画像 */
  extraUri?: string | null;
}

interface Shot {
  key:   string;
  label: string;
  uri:   string;
}

/**
 * 食事の写真とレシートの写真を切り替えて見せる。
 * 撮った本人の端末では端末に残っている元の写真を使い、無ければ（相手の端末では）
 * 共有用シートの縮小版を読む。
 */
export default function MealPhotos({ mealId, photoRefs, entryIds, height, extraUri }: Props) {
  const [shots, setShots]     = useState<Shot[]>([]);
  const [index, setIndex]     = useState(0);
  const [loading, setLoading] = useState(true);

  const refsKey = photoRefs.join(',');
  const entriesKey = entryIds.join(',');

  useEffect(() => {
    let alive = true;
    (async () => {
      setLoading(true);
      const out: Shot[] = [];
      if (extraUri) out.push({ key: 'extra', label: '料理', uri: extraUri });
      for (const ref of photoRefs) {
        const uri = localUri(ref);
        if (uri) out.push({ key: ref, label: '料理', uri });
      }
      for (const entryId of entryIds) {
        const uri = receiptPhotoUri(entryId);
        if (uri) out.push({ key: `r:${entryId}`, label: 'レシート', uri });
      }
      // この端末に無いものは相手が共有した縮小版を読む
      try {
        const shared = (await listShared()).filter((s) => s.mealId === mealId);
        const haveMeal = out.some((s) => s.label === '料理');
        const haveReceipt = out.some((s) => s.label === 'レシート');
        for (const s of shared) {
          if (s.kind === 'meal' && haveMeal) continue;
          if (s.kind === 'receipt' && haveReceipt) continue;
          const uri = cachedUri(s.photoId) ?? await fetchShared(s);
          if (uri) out.push({ key: s.photoId, label: s.kind === 'receipt' ? 'レシート' : '料理', uri });
        }
      } catch {
        // 共有写真が読めなくても、端末の写真だけで表示する
      }
      if (!alive) return;
      setShots(out);
      setIndex(0);
      setLoading(false);
    })();
    return () => { alive = false; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mealId, refsKey, entriesKey, extraUri]);

  if (loading) {
    return (
      <View style={[styles.placeholder, { height }]}>
        <ActivityIndicator />
      </View>
    );
  }
  if (shots.length === 0) {
    return (
      <View style={[styles.placeholder, { height: 48 }]}>
        <Text style={styles.none}>写真なし</Text>
      </View>
    );
  }

  const current = shots[Math.min(index, shots.length - 1)];
  return (
    <View>
      <ZoomableImage uri={current.uri} height={height} />
      {shots.length > 1 && (
        <View style={styles.tabs}>
          {shots.map((s, i) => (
            <TouchableOpacity
              key={s.key}
              style={[styles.tab, i === index && styles.tabActive]}
              onPress={() => setIndex(i)}
            >
              <Text style={[styles.tabText, i === index && styles.tabTextActive]}>
                {s.label}{shots.filter((x) => x.label === s.label).length > 1 ? ` ${shots.filter((x) => x.label === s.label).indexOf(s) + 1}` : ''}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  placeholder: {
    backgroundColor: '#f3f4f6',
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  none: { color: '#9ca3af', fontSize: 13 },
  tabs: { flexDirection: 'row', gap: 8, marginTop: 8 },
  tab: {
    paddingHorizontal: 12,
    paddingVertical: 4,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: '#d1d5db',
    backgroundColor: '#fff',
  },
  tabActive:     { backgroundColor: '#2e7d32', borderColor: '#2e7d32' },
  tabText:       { fontSize: 12, color: '#374151', fontWeight: '600' },
  tabTextActive: { color: '#fff' },
});
