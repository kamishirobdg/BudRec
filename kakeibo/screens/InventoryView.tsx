import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  RefreshControl,
  SectionList,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import {
  InventoryItem, keepInStock, listInventory, markUsedUp, remainLabel,
} from '../services/InventoryService';
import { researchNow } from '../services/FoodService';

const STORAGE_LABEL: Record<string, string> = { chilled: '冷蔵', frozen: '冷凍', ambient: '常温', '': 'その他' };
const DAY = 24 * 60 * 60 * 1000;

/**
 * 家にある食材・商品。日持ちの目安を過ぎたもの・食べきったものは出ない。
 * 残りがほぼ無くなったものは「食べきりましたか？」として先頭に出す。
 */
export default function InventoryView({ onConfirmCount }: { onConfirmCount?: (n: number) => void }) {
  const [items, setItems]     = useState<InventoryItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy]       = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const list = await listInventory(true);
      setItems(list);
      onConfirmCount?.(list.filter((i) => i.status === 'confirm').length);
    } catch (e) {
      Alert.alert('読み込み失敗', e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [onConfirmCount]);

  useEffect(() => { load(); }, [load]);

  const sections = useMemo(() => {
    const confirm = items.filter((i) => i.status === 'confirm');
    const rest = items.filter((i) => i.status !== 'confirm');
    const out: { title: string; data: InventoryItem[]; confirm: boolean }[] = [];
    if (confirm.length > 0) out.push({ title: '食べきりましたか？', data: confirm, confirm: true });
    for (const key of ['chilled', 'frozen', 'ambient', '']) {
      const data = rest.filter((i) => i.storage === key);
      if (data.length > 0) out.push({ title: STORAGE_LABEL[key], data, confirm: false });
    }
    return out;
  }, [items]);

  const run = async (item: InventoryItem, fn: () => Promise<unknown>) => {
    setBusy(item.itemId);
    try {
      await fn();
      await load();
    } catch (e) {
      Alert.alert('更新失敗', e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const reresearch = (item: InventoryItem) => run(item, async () => {
    const food = await researchNow({
      name: item.name, chain: '', kind: item.kind === 'ingredient' ? 'ingredient' : 'packaged', content: item.quantity,
    });
    Alert.alert(food && Object.values(food.nutrients).some((v) => v !== null) ? '栄養を更新しました' : '見つかりませんでした');
  });

  return (
    <SectionList
      sections={sections}
      keyExtractor={(i) => i.itemId}
      refreshControl={<RefreshControl refreshing={loading} onRefresh={load} />}
      contentContainerStyle={styles.list}
      ListEmptyComponent={loading ? <ActivityIndicator style={{ marginTop: 24 }} /> : <Text style={styles.empty}>在庫はありません</Text>}
      renderSectionHeader={({ section }) => (
        <Text style={[styles.section, section.confirm && styles.sectionConfirm]}>{section.title}</Text>
      )}
      renderItem={({ item, section }) => {
        const daysLeft = Math.ceil((item.expiresMs - Date.now()) / DAY);
        const bought = new Date(item.purchasedMs);
        return (
          <View style={styles.card}>
            <View style={styles.cardTop}>
              <Text style={styles.name} numberOfLines={1}>{item.name}</Text>
              <Text style={styles.remain}>{remainLabel(item)}</Text>
            </View>
            <Text style={styles.sub}>
              {item.store}　{bought.getMonth() + 1}/{bought.getDate()} 購入　あと {daysLeft} 日
            </Text>
            <View style={styles.actions}>
              {busy === item.itemId ? (
                <ActivityIndicator />
              ) : section.confirm ? (
                <>
                  <Btn label="食べきった" primary onPress={() => run(item, () => markUsedUp(item))} />
                  <Btn label="まだある" onPress={() => run(item, () => keepInStock(item))} />
                </>
              ) : (
                <>
                  <Btn label="食べきった" onPress={() => run(item, () => markUsedUp(item))} />
                  <Btn label="栄養を調べ直す" onPress={() => reresearch(item)} />
                </>
              )}
            </View>
          </View>
        );
      }}
    />
  );
}

function Btn({ label, onPress, primary }: { label: string; onPress: () => void; primary?: boolean }) {
  return (
    <TouchableOpacity style={[styles.btn, primary && styles.btnPrimary]} onPress={onPress}>
      <Text style={[styles.btnText, primary && styles.btnTextPrimary]}>{label}</Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  list:    { padding: 16, paddingBottom: 40 },
  empty:   { textAlign: 'center', color: '#888', marginTop: 24 },
  section: { fontSize: 14, fontWeight: 'bold', color: '#374151', paddingTop: 8, paddingBottom: 6 },
  sectionConfirm: { color: '#b45309' },
  card:    { backgroundColor: '#fff', borderRadius: 16, padding: 14, gap: 4, marginBottom: 8 },
  cardTop: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  name:    { flex: 1, fontSize: 15, fontWeight: '600', color: '#111' },
  remain:  { fontSize: 13, color: '#2e7d32', fontWeight: '700' },
  sub:     { fontSize: 12, color: '#6b7280' },
  actions: { flexDirection: 'row', gap: 8, marginTop: 6 },
  btn: {
    borderWidth: 1, borderColor: '#d1d5db', borderRadius: 8,
    paddingHorizontal: 12, paddingVertical: 6, backgroundColor: '#fff',
  },
  btnPrimary:     { backgroundColor: '#2e7d32', borderColor: '#2e7d32' },
  btnText:        { fontSize: 13, fontWeight: '600', color: '#1f2937' },
  btnTextPrimary: { color: '#fff' },
});
