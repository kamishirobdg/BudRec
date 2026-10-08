import { useMemo, useState } from 'react';
import { RefreshControl, ScrollView, StyleSheet, Switch, Text, TouchableOpacity, View } from 'react-native';
import type { MealRow } from '../../services/MealService';
import { Nutrients, sumNutrients } from '../../services/Nutrients';
import type { NutritionPrefs } from '../../services/NutritionPrefsService';
import { Judgement, NutrientStatus, hasProfile, judgeDay } from '../../services/NutritionJudge';
import { Supplement } from '../../services/SupplementService';

export interface MealGroup {
  mealId:    string;
  sheetName: string;
  eatenAt:   string;
  store:     string;
  rows:      MealRow[];
  /** 自分は食べていない、相手と共有された食事 */
  partnerOnly: boolean;
}

interface Props {
  me:          string;
  day:         string;
  meals:       MealGroup[];
  prefs:       NutritionPrefs;
  supplements: { supplement: Supplement; skipped: boolean }[];
  supplementNutrients: Nutrients[];
  loading:     boolean;
  onRefresh:   () => void;
  onOpenMeal:  (g: MealGroup) => void;
  onToggleSupplement: (s: Supplement, taken: boolean) => void;
  /** サプリの切り替えを保存中（終わるまで切り替えられない） */
  supplementSaving?:  boolean;
}

const JUDGE_LABEL: Record<Judgement, string> = { low: '不足', ok: '適正', high: '過剰', none: '—' };
const JUDGE_COLOR: Record<Judgement, string> = { low: '#d97706', ok: '#2e7d32', high: '#dc2626', none: '#9ca3af' };

function fmt(v: number | null, unit: string): string {
  if (v === null) return '—';
  const n = v >= 100 ? Math.round(v) : Math.round(v * 10) / 10;
  return `${n.toLocaleString('ja-JP')}${unit}`;
}

/** その日の栄養の表・サプリ・食事の一覧 */
export default function DayView(props: Props) {
  const {
    me, meals, prefs, supplements, supplementNutrients, loading, onRefresh, onOpenMeal, onToggleSupplement, supplementSaving,
  } = props;
  const [showAll, setShowAll] = useState(false);

  const statuses = useMemo(() => {
    const mine = meals.flatMap((g) => g.rows.filter((r) => r.user === me).map((r) => r.nutrients));
    const list = [...mine, ...supplementNutrients];
    const sums = sumNutrients(list);
    const totals: Record<string, number | null> = {};
    for (const [k, t] of Object.entries(sums)) totals[k] = list.length > 0 && !(t.partial && t.value === 0) ? t.value : null;
    return judgeDay(totals, prefs);
  }, [meals, me, prefs, supplementNutrients]);

  const shown = showAll ? statuses : statuses.filter((s) => prefs.visible.includes(s.key));
  const counts = statuses.reduce((c, s) => ({ ...c, [s.judgement]: (c[s.judgement] ?? 0) + 1 }), {} as Record<string, number>);

  return (
    <ScrollView contentContainerStyle={styles.body} refreshControl={<RefreshControl refreshing={loading} onRefresh={onRefresh} />}>
      {!hasProfile(prefs) && (
        <Text style={styles.notice}>「表示」で生年月日と性別を入れると、食事摂取基準で過不足を判定します</Text>
      )}

      <View style={styles.card}>
        <View style={styles.tableHead}>
          <Text style={styles.cardTitle}>栄養</Text>
          <Text style={styles.counts}>
            {(counts.low ?? 0) > 0 && <Text style={{ color: JUDGE_COLOR.low }}>不足 {counts.low}　</Text>}
            {(counts.high ?? 0) > 0 && <Text style={{ color: JUDGE_COLOR.high }}>過剰 {counts.high}</Text>}
          </Text>
        </View>
        {shown.map((s) => <StatusRow key={s.key} s={s} />)}
        <TouchableOpacity onPress={() => setShowAll((v) => !v)}>
          <Text style={styles.more}>{showAll ? '表示する栄養素だけにする' : 'すべての栄養素を見る'}</Text>
        </TouchableOpacity>
      </View>

      {supplements.length > 0 && (
        <View style={styles.card}>
          <Text style={styles.cardTitle}>サプリ</Text>
          {supplements.map(({ supplement, skipped }) => (
            <View key={supplement.supplementId} style={styles.supRow}>
              <Text style={styles.supName}>{supplement.name}</Text>
              <Text style={styles.supMeta}>{supplement.perDay} {supplement.unit}</Text>
              <Switch
                value={!skipped}
                onValueChange={(v) => onToggleSupplement(supplement, v)}
                disabled={supplementSaving}
                trackColor={{ false: '#ccc', true: '#a5d6a7' }}
                thumbColor={!skipped ? '#2e7d32' : '#f4f3f4'}
              />
            </View>
          ))}
        </View>
      )}

      {meals.length === 0 && !loading && <Text style={styles.empty}>この日の食事の記録はありません</Text>}
      {meals.map((g) => <MealCard key={g.mealId} g={g} me={me} onPress={() => onOpenMeal(g)} />)}
    </ScrollView>
  );
}

function StatusRow({ s }: { s: NutrientStatus }) {
  const width = s.ratio === null ? 0 : Math.max(2, Math.min(100, s.ratio * 100));
  return (
    <View style={styles.statusRow}>
      <View style={styles.statusTop}>
        <Text style={styles.statusLabel}>{s.label}</Text>
        <Text style={styles.statusValue}>
          {fmt(s.value, s.unit)}{s.percent !== undefined ? `（${Math.round(s.percent)}%）` : ''}
        </Text>
        <Text style={[styles.judge, { color: JUDGE_COLOR[s.judgement], borderColor: JUDGE_COLOR[s.judgement] }]}>
          {JUDGE_LABEL[s.judgement]}
        </Text>
      </View>
      {!!s.standard && (
        <View style={styles.statusBottom}>
          <View style={styles.barTrack}>
            <View style={[styles.bar, { width: `${width}%`, backgroundColor: JUDGE_COLOR[s.judgement] }]} />
          </View>
          <Text style={styles.standard}>{s.standard}</Text>
        </View>
      )}
    </View>
  );
}

function MealCard({ g, me, onPress }: { g: MealGroup; me: string; onPress: () => void }) {
  const mine = g.rows.filter((r) => r.user === me);
  const kcal = mine.reduce((sum, r) => sum + (r.nutrients['ENERC_KCAL'] ?? 0), 0);
  const review = g.rows.some((r) => r.status === 'needs_review');
  const dishes = [...new Map(g.rows.map((r) => [r.dishId, r])).values()];
  return (
    <TouchableOpacity style={styles.mealCard} onPress={onPress}>
      <View style={styles.mealTop}>
        <Text style={styles.time}>{g.eatenAt.slice(11, 16)}</Text>
        <Text style={styles.store} numberOfLines={1}>{g.store || (g.rows[0].kind === 'home' ? '自炊' : '')}</Text>
        {g.partnerOnly && <Text style={styles.sharedBadge}>共有</Text>}
        {review && <Text style={styles.badge}>要確認</Text>}
        {mine.length > 0 && <Text style={styles.kcal}>{Math.round(kcal)} kcal</Text>}
      </View>
      {dishes.map((d) => {
        const eaters = g.rows.filter((r) => r.dishId === d.dishId);
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
}

const styles = StyleSheet.create({
  body:      { padding: 16, paddingBottom: 40, gap: 10 },
  notice:    { fontSize: 12, color: '#6b7280', backgroundColor: '#fff', borderRadius: 10, padding: 10 },
  card:      { backgroundColor: '#fff', borderRadius: 16, padding: 14, gap: 6 },
  cardTitle: { fontSize: 14, fontWeight: 'bold', color: '#374151' },
  tableHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  counts:    { fontSize: 12, fontWeight: '700' },
  more:      { fontSize: 12, color: '#2563eb', fontWeight: '600', marginTop: 4 },
  statusRow: { paddingVertical: 4, borderTopWidth: 1, borderTopColor: '#f3f4f6' },
  statusTop: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  statusLabel: { flex: 1, fontSize: 13, color: '#1f2937' },
  statusValue: { fontSize: 13, color: '#1f2937', fontWeight: '600' },
  judge: {
    fontSize: 11, fontWeight: '700', borderWidth: 1, borderRadius: 6, paddingHorizontal: 6, paddingVertical: 1,
    minWidth: 38, textAlign: 'center',
  },
  statusBottom: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 3 },
  barTrack:  { flex: 1, height: 4, borderRadius: 2, backgroundColor: '#f3f4f6', overflow: 'hidden' },
  bar:       { height: 4, borderRadius: 2 },
  standard:  { fontSize: 11, color: '#9ca3af' },
  supRow:    { flexDirection: 'row', alignItems: 'center', gap: 8 },
  supName:   { flex: 1, fontSize: 13, color: '#1f2937' },
  supMeta:   { fontSize: 12, color: '#6b7280' },
  empty:     { textAlign: 'center', color: '#888', marginTop: 12 },
  mealCard:  { backgroundColor: '#fff', borderRadius: 16, padding: 14, gap: 4 },
  mealTop:   { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 2 },
  time:      { fontSize: 13, color: '#6b7280', fontWeight: '600' },
  store:     { flex: 1, fontSize: 14, color: '#111', fontWeight: '600' },
  sharedBadge: {
    fontSize: 11, color: '#2563eb', backgroundColor: '#dbeafe', fontWeight: '700',
    paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6, overflow: 'hidden',
  },
  badge: {
    fontSize: 11, color: '#b45309', backgroundColor: '#fef3c7', fontWeight: '700',
    paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6, overflow: 'hidden',
  },
  kcal:      { fontSize: 13, color: '#2e7d32', fontWeight: '700' },
  dish:      { fontSize: 14, color: '#1f2937' },
  who:       { fontSize: 12, color: '#6b7280' },
});
