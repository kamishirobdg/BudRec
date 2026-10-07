import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import { getMeals, MealRow } from '../services/MealService';
import { DEFAULT_VISIBLE, nutrientDef, sumNutrients } from '../services/Nutrients';
import { getCurrentUser } from '../services/UserService';
import { getUniqueUsers } from '../services/SheetsService';
import * as OcrWorker from '../services/OcrWorker';
import * as ReceiptQueue from '../services/ReceiptQueueService';
import MealEditModal, { MealTarget } from './MealEditModal';
import InventoryView from './InventoryView';

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function monthOf(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
}

function shiftMonth(ym: string, delta: number): string {
  const [y, m] = ym.split('-').map(Number);
  return monthOf(new Date(y, m - 1 + delta, 1));
}

interface MealGroup {
  mealId:    string;
  sheetName: string;
  eatenAt:   string;
  store:     string;
  rows:      MealRow[];
}

/** 食事の一覧。日ごとに、選んだ人の栄養の合計を出す */
export default function MealsScreen() {
  const [month, setMonth]       = useState(monthOf(new Date()));
  const [rows, setRows]         = useState<MealRow[]>([]);
  const [loading, setLoading]   = useState(false);
  const [person, setPerson]     = useState('');
  const [people, setPeople]     = useState<string[]>([]);
  const [target, setTarget]     = useState<MealTarget | null>(null);
  const [deferred, setDeferred] = useState(0);
  const [view, setView]         = useState<'meals' | 'stock'>('meals');
  // 「食べきりましたか？」の数（在庫タブの見出しに出す）
  const [confirmCount, setConfirmCount] = useState(0);

  // 月を素早く切り替えたとき、前の月の遅れて返った結果で上書きしない
  const requestSeq = useRef(0);
  const load = useCallback(async () => {
    const seq = ++requestSeq.current;
    setLoading(true);
    try {
      const [me, users, meals] = await Promise.all([getCurrentUser(), getUniqueUsers(), getMeals(month)]);
      if (seq !== requestSeq.current) return;
      setPeople([me, ...users.filter((u) => u !== me)]);
      setPerson((p) => p || me);
      setRows(meals);
    } catch (e) {
      Alert.alert('読み込み失敗', e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [month]);

  useEffect(() => { load(); }, [load]);

  // 推定待ちの食事の数（無料枠切れで後から処理されるもの）。食事が記録されたら読み直す
  useEffect(() => {
    const refresh = () =>
      setDeferred(ReceiptQueue.listItems().filter((i) => i.kind === 'meal' && i.status === 'deferred').length);
    refresh();
    return OcrWorker.subscribe((e) => {
      refresh();
      if (e.type === 'saved') load();
    });
  }, [load]);

  const sections = useMemo(() => {
    const groups = new Map<string, MealGroup>();
    for (const r of rows) {
      const g = groups.get(r.mealId) ?? { mealId: r.mealId, sheetName: r.sheetName ?? '', eatenAt: r.eatenAt, store: r.store, rows: [] };
      g.rows.push(r);
      groups.set(r.mealId, g);
    }
    const byDay = new Map<string, MealGroup[]>();
    for (const g of groups.values()) {
      const day = g.eatenAt.slice(0, 10);
      byDay.set(day, [...(byDay.get(day) ?? []), g]);
    }
    return [...byDay.entries()]
      .sort((a, b) => (a[0] < b[0] ? 1 : -1))
      .map(([day, meals]) => ({
        day,
        data: meals.sort((a, b) => (a.eatenAt < b.eatenAt ? 1 : -1)),
        totals: sumNutrients(meals.flatMap((m) => m.rows.filter((r) => r.user === person).map((r) => r.nutrients))),
        hasPerson: meals.some((m) => m.rows.some((r) => r.user === person)),
      }));
  }, [rows, person]);

  const reviewCount = new Set(rows.filter((r) => r.status === 'needs_review').map((r) => r.mealId)).size;

  const segment = (
    <View style={styles.segment}>
      {(['meals', 'stock'] as const).map((v) => (
        <TouchableOpacity key={v} style={[styles.segBtn, view === v && styles.segBtnActive]} onPress={() => setView(v)}>
          <Text style={[styles.segText, view === v && styles.segTextActive]}>
            {v === 'meals' ? `食事${reviewCount > 0 ? `（要確認 ${reviewCount}）` : ''}` : `在庫${confirmCount > 0 ? `（確認 ${confirmCount}）` : ''}`}
          </Text>
        </TouchableOpacity>
      ))}
    </View>
  );

  if (view === 'stock') {
    return (
      <View style={styles.container}>
        {segment}
        <InventoryView onConfirmCount={setConfirmCount} />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {segment}
      <View style={styles.toolbar}>
        <TouchableOpacity onPress={() => setMonth((m) => shiftMonth(m, -1))}>
          <Text style={styles.arrow}>‹</Text>
        </TouchableOpacity>
        <Text style={styles.month}>{month.replace('-', '年')}月</Text>
        <TouchableOpacity onPress={() => setMonth((m) => shiftMonth(m, 1))}>
          <Text style={styles.arrow}>›</Text>
        </TouchableOpacity>
        <View style={styles.people}>
          {people.map((p) => (
            <TouchableOpacity key={p} style={[styles.chip, person === p && styles.chipActive]} onPress={() => setPerson(p)}>
              <Text style={[styles.chipText, person === p && styles.chipTextActive]}>{p}</Text>
            </TouchableOpacity>
          ))}
        </View>
      </View>

      {deferred > 0 && (
        <Text style={styles.deferred}>推定待ち {deferred} 件（無料枠が戻ったら自動で処理）</Text>
      )}

      <SectionList
        sections={sections}
        keyExtractor={(g) => g.mealId}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={load} />}
        contentContainerStyle={styles.list}
        ListEmptyComponent={loading ? <ActivityIndicator style={{ marginTop: 24 }} /> : <Text style={styles.empty}>記録がありません</Text>}
        renderSectionHeader={({ section }) => (
          <View style={styles.dayHeader}>
            <Text style={styles.dayTitle}>{section.day}</Text>
            {section.hasPerson && (
              <Text style={styles.dayTotals}>
                {DEFAULT_VISIBLE.map((k) => {
                  const t = section.totals[k];
                  const def = nutrientDef(k);
                  if (!t || !def) return null;
                  return `${def.label} ${Math.round(t.value * 10) / 10}${def.unit}${t.partial ? '+' : ''}`;
                }).filter(Boolean).join('　')}
              </Text>
            )}
          </View>
        )}
        renderItem={({ item }) => {
          const mine = item.rows.filter((r) => r.user === person);
          const kcal = mine.reduce((s, r) => s + (r.nutrients['ENERC_KCAL'] ?? 0), 0);
          const review = item.rows.some((r) => r.status === 'needs_review');
          const dishes = [...new Map(item.rows.map((r) => [r.dishId, r])).values()];
          return (
            <TouchableOpacity
              style={styles.card}
              onPress={() => setTarget({ mode: 'edit', sheetName: item.sheetName, mealId: item.mealId })}
            >
              <View style={styles.cardTop}>
                <Text style={styles.time}>{item.eatenAt.slice(11, 16)}</Text>
                <Text style={styles.store} numberOfLines={1}>{item.store || (item.rows[0].kind === 'home' ? '自炊' : '')}</Text>
                {review && <Text style={styles.badge}>要確認</Text>}
                {mine.length > 0 && <Text style={styles.kcal}>{Math.round(kcal)} kcal</Text>}
              </View>
              {dishes.map((d) => {
                const eaters = item.rows.filter((r) => r.dishId === d.dishId);
                const who = eaters.length > 1
                  ? eaters.map((e) => `${e.user}${Math.round(e.portion * 10)}`).join(':')
                  : eaters[0].user;
                return (
                  <Text key={d.dishId} style={styles.dish} numberOfLines={1}>
                    {d.dish}<Text style={styles.who}>　{who}</Text>
                  </Text>
                );
              })}
            </TouchableOpacity>
          );
        }}
      />

      <MealEditModal
        target={target}
        onClose={() => setTarget(null)}
        onSaved={() => { setTarget(null); load(); }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f2f4f7' },
  segment:   { flexDirection: 'row', gap: 8, paddingHorizontal: 16, paddingTop: 10, paddingBottom: 6, backgroundColor: '#fff' },
  segBtn: {
    flex: 1, alignItems: 'center', paddingVertical: 8, borderRadius: 10,
    borderWidth: 1, borderColor: '#d1d5db', backgroundColor: '#fff',
  },
  segBtnActive:  { backgroundColor: '#2e7d32', borderColor: '#2e7d32' },
  segText:       { fontSize: 14, fontWeight: '600', color: '#374151' },
  segTextActive: { color: '#fff' },
  toolbar: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    paddingHorizontal: 16, paddingVertical: 10, backgroundColor: '#fff',
    borderBottomWidth: 1, borderBottomColor: '#eee',
  },
  arrow:  { fontSize: 24, color: '#2e7d32', paddingHorizontal: 4 },
  month:  { fontSize: 16, fontWeight: 'bold', color: '#222' },
  people: { flexDirection: 'row', gap: 6, marginLeft: 'auto' },
  chip: {
    paddingHorizontal: 12, paddingVertical: 4, borderRadius: 14,
    borderWidth: 1, borderColor: '#d1d5db', backgroundColor: '#fff',
  },
  chipActive:     { backgroundColor: '#2e7d32', borderColor: '#2e7d32' },
  chipText:       { fontSize: 12, color: '#374151', fontWeight: '600' },
  chipTextActive: { color: '#fff' },
  deferred: { fontSize: 12, color: '#6b7280', paddingHorizontal: 16, paddingTop: 8 },
  list:     { padding: 16, paddingBottom: 40, gap: 10 },
  empty:    { textAlign: 'center', color: '#888', marginTop: 24 },
  dayHeader: { paddingTop: 8, paddingBottom: 4 },
  dayTitle:  { fontSize: 14, fontWeight: 'bold', color: '#374151' },
  dayTotals: { fontSize: 12, color: '#2e7d32', marginTop: 2 },
  card:      { backgroundColor: '#fff', borderRadius: 16, padding: 14, gap: 4, marginBottom: 8 },
  cardTop:   { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 2 },
  time:      { fontSize: 13, color: '#6b7280', fontWeight: '600' },
  store:     { flex: 1, fontSize: 14, color: '#111', fontWeight: '600' },
  badge: {
    fontSize: 11, color: '#b45309', backgroundColor: '#fef3c7', fontWeight: '700',
    paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6, overflow: 'hidden',
  },
  kcal:      { fontSize: 13, color: '#2e7d32', fontWeight: '700' },
  dish:      { fontSize: 14, color: '#1f2937' },
  who:       { fontSize: 12, color: '#6b7280' },
});
