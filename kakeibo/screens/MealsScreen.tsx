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
import { NutrientTotal, nutrientDef, sumNutrients } from '../services/Nutrients';
import { DEFAULT_PREFS, NutritionPrefs, loadPrefs } from '../services/NutritionPrefsService';
import NutritionPrefsModal from './NutritionPrefsModal';
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

type Period = 'day' | 'week' | 'month';
const PERIOD_LABEL: Record<Period, string> = { day: '日', week: '週', month: '月' };

/** 'YYYY/MM/DD …' / 'YYYY-MM-DD …' の日付部分（Hermes では new Date に文字列を渡さない） */
function dayOf(ts: string): Date {
  const m = ts.match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})/);
  return m ? new Date(+m[1], +m[2] - 1, +m[3]) : new Date(0);
}

function md(d: Date): string {
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

/**
 * 期間の見出しと並び順の鍵。週は月曜始まり。一覧は 1 か月ずつ読むので、月をまたぐ週は
 * 表示中の月の分だけになる。見出しもその範囲に合わせる（「10/1〜10/5」）
 */
function periodOf(ts: string, period: Period): { key: string; title: string } {
  const d = dayOf(ts);
  if (period === 'month') return { key: monthOf(d), title: `${d.getFullYear()}年${d.getMonth() + 1}月` };
  if (period === 'week') {
    const mon = new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7));
    const sun = new Date(mon.getFullYear(), mon.getMonth(), mon.getDate() + 6);
    const first = new Date(d.getFullYear(), d.getMonth(), 1);
    const last = new Date(d.getFullYear(), d.getMonth() + 1, 0);
    const from = mon < first ? first : mon;
    const to = sun > last ? last : sun;
    return { key: `${monthOf(from)}-${pad(from.getDate())}`, title: `${md(from)}〜${md(to)}` };
  }
  return { key: `${monthOf(d)}-${pad(d.getDate())}`, title: ts.slice(0, 10) };
}

/** 見出しの栄養の表示。週・月は 1 日あたりの平均にして目標と比べる */
function totalsLabel(totals: Record<string, NutrientTotal>, prefs: NutritionPrefs, days: number, period: Period): string {
  const parts = prefs.visible.map((k) => {
    const t = totals[k];
    const def = nutrientDef(k);
    if (!t || !def) return null;
    const v = Math.round((t.value / (period === 'day' ? 1 : Math.max(1, days))) * 10) / 10;
    const target = prefs.targets[k];
    return `${def.label} ${v}${target ? `/${target}` : ''}${def.unit}${t.partial ? '+' : ''}`;
  }).filter(Boolean);
  return (period === 'day' ? '' : `1日平均（${days}日）　`) + parts.join('　');
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
  const [period, setPeriod]     = useState<Period>('day');
  const [prefsMap, setPrefsMap] = useState<Map<string, NutritionPrefs>>(new Map());
  const [prefsUser, setPrefsUser] = useState<string | null>(null);
  // 一度も読めていないうちに設定を開くと、既定の内容で保存して目標値を消してしまうので開かせない
  const [prefsReady, setPrefsReady] = useState(false);
  const prefs = prefsMap.get(person) ?? DEFAULT_PREFS;

  // 月を素早く切り替えたとき、前の月の遅れて返った結果で上書きしない
  const requestSeq = useRef(0);
  const load = useCallback(async () => {
    const seq = ++requestSeq.current;
    setLoading(true);
    try {
      const [me, users, meals, prefsLoaded] = await Promise.all([
        getCurrentUser(), getUniqueUsers(), getMeals(month),
        // 表示設定が読めなくても一覧は出す（前に読めた設定はそのまま使う）
        loadPrefs().catch(() => null),
      ]);
      if (seq !== requestSeq.current) return;
      if (prefsLoaded) {
        setPrefsMap(prefsLoaded);
        setPrefsReady(true);
      }
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
    const byPeriod = new Map<string, { title: string; meals: MealGroup[] }>();
    for (const g of groups.values()) {
      const { key, title } = periodOf(g.eatenAt, period);
      const entry = byPeriod.get(key) ?? { title, meals: [] };
      entry.meals.push(g);
      byPeriod.set(key, entry);
    }
    return [...byPeriod.entries()]
      .sort((a, b) => (a[0] < b[0] ? 1 : -1))
      .map(([key, { title, meals }]) => {
        const mine = meals.flatMap((m) => m.rows.filter((r) => r.user === person));
        return {
          key,
          title,
          data: meals.sort((a, b) => (a.eatenAt < b.eatenAt ? 1 : -1)),
          totals: sumNutrients(mine.map((r) => r.nutrients)),
          // 平均は、その人の記録がある日の数で割る（記録していない日まで割ると少なく見える）
          days: new Set(mine.map((r) => r.eatenAt.slice(0, 10))).size,
          hasPerson: mine.length > 0,
        };
      });
  }, [rows, person, period]);

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

      <View style={styles.subbar}>
        {(['day', 'week', 'month'] as const).map((p) => (
          <TouchableOpacity key={p} style={[styles.chip, period === p && styles.chipActive]} onPress={() => setPeriod(p)}>
            <Text style={[styles.chipText, period === p && styles.chipTextActive]}>{PERIOD_LABEL[p]}</Text>
          </TouchableOpacity>
        ))}
        <TouchableOpacity
          style={styles.prefsBtn}
          onPress={() => {
            if (!prefsReady) {
              Alert.alert('読み込み失敗', '表示の設定を読み込めませんでした。引き下げて読み直してください');
              return;
            }
            if (person) setPrefsUser(person);
          }}
        >
          <Text style={styles.prefsText}>表示</Text>
        </TouchableOpacity>
      </View>

      {deferred > 0 && (
        <Text style={styles.deferred}>推定待ち {deferred} 件（無料枠が戻ったら自動で処理）</Text>
      )}

      <SectionList
        sections={sections}
        keyExtractor={(g) => g.mealId}
        stickySectionHeadersEnabled={false}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={load} />}
        contentContainerStyle={styles.list}
        ListEmptyComponent={loading ? <ActivityIndicator style={{ marginTop: 24 }} /> : <Text style={styles.empty}>記録がありません</Text>}
        renderSectionHeader={({ section }) => (
          <View style={styles.dayHeader}>
            <Text style={styles.dayTitle}>{section.title}</Text>
            {section.hasPerson && (
              <Text style={styles.dayTotals}>{totalsLabel(section.totals, prefs, section.days, period)}</Text>
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

      <NutritionPrefsModal
        user={prefsUser}
        prefs={prefsMap.get(prefsUser ?? '') ?? DEFAULT_PREFS}
        onClose={() => setPrefsUser(null)}
        onSaved={(next) => {
          if (prefsUser) setPrefsMap((prev) => new Map(prev).set(prefsUser, next));
          setPrefsUser(null);
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
  subbar: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: 16, paddingVertical: 8, backgroundColor: '#fff',
    borderBottomWidth: 1, borderBottomColor: '#eee',
  },
  prefsBtn:  { marginLeft: 'auto', paddingHorizontal: 12, paddingVertical: 4, borderRadius: 14, borderWidth: 1, borderColor: '#2e7d32' },
  prefsText: { fontSize: 12, color: '#2e7d32', fontWeight: '600' },
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
