import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert, RefreshControl, ScrollView, StyleSheet, Text, TouchableOpacity, View, useWindowDimensions,
} from 'react-native';
import LineChart from '../components/LineChart';
import {
  DayActivity, HealthStatus, SLEEP_GOAL_MIN, connectHealth, healthStatus, loadActivity, openHealthSettings, stepGoal,
  syncActivity,
} from '../services/ActivityService';
import { getMeals, MealRow } from '../services/MealService';
import { DEFAULT_PREFS, NutritionPrefs, loadPrefs } from '../services/NutritionPrefsService';
import { ageOf, dayOf, shiftDay, today } from '../services/NutritionJudge';
import { getCurrentUser } from '../services/UserService';
import { cachedLoad } from '../services/LocalCache';

type Metric = 'steps' | 'sleep' | 'active' | 'weight';
const METRIC_LABEL: Record<Metric, string> = { steps: '歩数', sleep: '睡眠', active: '活動カロリー', weight: '体重' };
const WEEKDAY = ['日', '月', '火', '水', '木', '金', '土'];

function dayLabel(day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  return `${m}/${d}（${WEEKDAY[new Date(y, m - 1, d).getDay()]}）`;
}

function hm(min: number): string {
  return `${Math.floor(min / 60)}時間${String(Math.round(min % 60)).padStart(2, '0')}分`;
}

/**
 * 「からだ」タブ。ヘルスコネクト（b.ring・スマホの歩数・体重計のアプリなど）から歩数・睡眠・活動・体重を読み、
 * 目安と比べる。食事の記録と合わせて「寝不足の日に食べ過ぎていないか」も見る。仕様は docs/meal-nutrition-spec.md §12。
 */
export default function BodyScreen() {
  const { width } = useWindowDimensions();
  const [me, setMe]             = useState('');
  const [status, setStatus]     = useState<HealthStatus | null>(null);
  const [activity, setActivity] = useState<DayActivity[]>([]);
  const [prefs, setPrefs]       = useState<NutritionPrefs>(DEFAULT_PREFS);
  const [meals, setMeals]       = useState<MealRow[]>([]);
  const [day, setDay]           = useState(today());
  const [metric, setMetric]     = useState<Metric>('steps');
  const [span, setSpan]         = useState<7 | 30>(7);
  const [loading, setLoading]   = useState(false);

  const load = useCallback(async (sync: boolean) => {
    setLoading(true);
    try {
      const user = await getCurrentUser();
      setMe(user);
      const st = await healthStatus();
      setStatus(st);
      // 食事は直近 30 日ぶん（寝不足の日の食べ方を見る）
      const months = [...new Set([0, 31].map((back) => shiftDay(today(), -back).slice(0, 7)))];
      await Promise.all([
        cachedLoad('nutrition_prefs', async () => [...(await loadPrefs()).entries()], (e) => setPrefs(new Map(e).get(user) ?? DEFAULT_PREFS))
          .then((e) => setPrefs(new Map(e).get(user) ?? DEFAULT_PREFS)).catch(() => {}),
        Promise.all(months.map((m) => cachedLoad(`meals_${m}`, () => getMeals(m)).catch(() => [] as MealRow[])))
          .then((list) => setMeals(list.flat())),
        (async () => {
          // 先に控えを出し、ヘルスコネクトから写したら読み直す
          await cachedLoad('activity', loadActivity, setActivity).then(setActivity).catch(() => {});
          if (sync && st === 'connected' && (await syncActivity(user))) {
            const fresh = await loadActivity();
            setActivity(fresh);
          }
        })(),
      ]);
    } catch (e) {
      Alert.alert('読み込み失敗', e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(true); }, [load]);

  const handleConnect = async () => {
    try {
      if (await connectHealth()) await load(true);
      else Alert.alert('許可されませんでした', 'ヘルスコネクトの設定から Bud-Rec に読み取りを許可してください');
    } catch (e) {
      Alert.alert('連携できませんでした', e instanceof Error ? e.message : String(e));
    }
  };

  const mine = useMemo(() => activity.filter((a) => a.user === me), [activity, me]);
  const byDay = useMemo(() => new Map(mine.map((a) => [a.date, a])), [mine]);
  const age = prefs.profile.birthDate ? ageOf(prefs.profile.birthDate) : null;
  const goal = stepGoal(age);
  const today_ = byDay.get(day);

  // 日ごとの摂取カロリー（自分の分）
  const kcalByDay = useMemo(() => {
    const map = new Map<string, number>();
    for (const r of meals) {
      if (r.user !== me || r.deleted) continue;
      const v = r.nutrients['ENERC_KCAL'];
      if (v === null || v === undefined) continue;
      const d = dayOf(r.eatenAt);
      map.set(d, (map.get(d) ?? 0) + v);
    }
    return map;
  }, [meals, me]);

  // 寝不足の日と、そうでない日の摂取カロリーの平均（直近 30 日。どちらも 3 日以上あるとき）
  const insight = useMemo(() => {
    const short: number[] = [];
    const enough: number[] = [];
    for (let i = 1; i <= 30; i++) {
      const d = shiftDay(today(), -i);
      const a = byDay.get(d);
      const kcal = kcalByDay.get(d);
      if (!a?.sleepMin || kcal === undefined) continue;
      (a.sleepMin < SLEEP_GOAL_MIN ? short : enough).push(kcal);
    }
    if (short.length < 3 || enough.length < 3) return null;
    const avg = (l: number[]) => Math.round(l.reduce((x, y) => x + y, 0) / l.length);
    return { short: avg(short), enough: avg(enough), shortDays: short.length, enoughDays: enough.length };
  }, [byDay, kcalByDay]);

  const series = useMemo(() => {
    const days: string[] = [];
    for (let i = span - 1; i >= 0; i--) days.push(shiftDay(day, -i));
    const value = (a: DayActivity | undefined): number | null => {
      if (!a) return null;
      if (metric === 'steps') return a.steps;
      if (metric === 'sleep') return a.sleepMin === null ? null : Math.round((a.sleepMin / 60) * 10) / 10;
      if (metric === 'active') return a.activeKcal;
      return a.weightKg;
    };
    return { days, values: days.map((d) => value(byDay.get(d))) };
  }, [span, day, metric, byDay]);
  const band = metric === 'steps' ? { bandLow: goal } : metric === 'sleep' ? { bandLow: SLEEP_GOAL_MIN / 60 } : {};
  const present = series.values.filter((v): v is number => v !== null);
  const average = present.length > 0 ? present.reduce((a, b) => a + b, 0) / present.length : null;
  const unit = metric === 'steps' ? '歩' : metric === 'sleep' ? '時間' : metric === 'active' ? 'kcal' : 'kg';

  return (
    <View style={styles.container}>
      <View style={styles.toolbar}>
        <TouchableOpacity onPress={() => setDay((d) => shiftDay(d, -1))}>
          <Text style={styles.arrow}>‹</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={() => setDay(today())}>
          <Text style={styles.date}>{dayLabel(day)}</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={() => setDay((d) => (d < today() ? shiftDay(d, 1) : d))}>
          <Text style={[styles.arrow, day >= today() && styles.arrowDisabled]}>›</Text>
        </TouchableOpacity>
      </View>

      <ScrollView contentContainerStyle={styles.body} refreshControl={<RefreshControl refreshing={loading} onRefresh={() => load(true)} />}>
        {status !== null && status !== 'connected' && (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>ヘルスコネクト</Text>
            {status === 'not_connected' && (
              <>
                <Text style={styles.note}>スマートリングやスマホの歩数・睡眠・体重を読み取ります</Text>
                <TouchableOpacity style={styles.primary} onPress={handleConnect}>
                  <Text style={styles.primaryText}>連携する</Text>
                </TouchableOpacity>
              </>
            )}
            {status === 'needs_update' && (
              <>
                <Text style={styles.note}>ヘルスコネクトの更新が必要です</Text>
                <TouchableOpacity style={styles.primary} onPress={openHealthSettings}>
                  <Text style={styles.primaryText}>ヘルスコネクトを開く</Text>
                </TouchableOpacity>
              </>
            )}
            {status === 'unavailable' && <Text style={styles.note}>この端末ではヘルスコネクトを使えません</Text>}
          </View>
        )}

        <View style={styles.grid}>
          <Tile
            label="歩数"
            value={today_?.steps != null ? `${today_.steps.toLocaleString('ja-JP')} 歩` : '—'}
            sub={`目安 ${goal.toLocaleString('ja-JP')} 歩`}
            ratio={today_?.steps != null ? today_.steps / goal : null}
          />
          <Tile
            label="睡眠"
            value={today_?.sleepMin != null ? hm(today_.sleepMin) : '—'}
            sub="目安 6 時間以上"
            ratio={today_?.sleepMin != null ? today_.sleepMin / SLEEP_GOAL_MIN : null}
          />
          <Tile
            label="活動カロリー"
            value={today_?.activeKcal != null ? `${today_.activeKcal.toLocaleString('ja-JP')} kcal` : '—'}
            sub={today_?.exerciseMin ? `運動 ${today_.exerciseMin} 分` : ''}
            ratio={null}
          />
          <Tile
            label="摂取カロリー"
            value={kcalByDay.has(day) ? `${Math.round(kcalByDay.get(day)!).toLocaleString('ja-JP')} kcal` : '—'}
            sub={today_?.weightKg != null ? `体重 ${today_.weightKg} kg` : ''}
            ratio={null}
          />
        </View>

        {insight && (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>睡眠と食事（直近 30 日）</Text>
            <Text style={styles.insight}>
              6 時間未満の日は平均 {insight.short.toLocaleString('ja-JP')} kcal（{insight.shortDays} 日）、
              6 時間以上の日は平均 {insight.enough.toLocaleString('ja-JP')} kcal（{insight.enoughDays} 日）
            </Text>
            {insight.short > insight.enough * 1.1 && (
              <Text style={[styles.insight, styles.warn]}>寝不足の日は食べる量が多くなっています</Text>
            )}
          </View>
        )}

        <View style={styles.card}>
          <View style={styles.row}>
            {(Object.keys(METRIC_LABEL) as Metric[]).map((m) => (
              <TouchableOpacity key={m} style={[styles.chip, metric === m && styles.chipActive]} onPress={() => setMetric(m)}>
                <Text style={[styles.chipText, metric === m && styles.chipTextActive]}>{METRIC_LABEL[m]}</Text>
              </TouchableOpacity>
            ))}
          </View>
          <View style={styles.row}>
            {([7, 30] as const).map((s) => (
              <TouchableOpacity key={s} style={[styles.chip, span === s && styles.chipActive]} onPress={() => setSpan(s)}>
                <Text style={[styles.chipText, span === s && styles.chipTextActive]}>{s} 日</Text>
              </TouchableOpacity>
            ))}
          </View>
          <LineChart
            width={width - 32 - 28}
            values={series.values}
            firstLabel={series.days[0].slice(5).replace('-', '/')}
            lastLabel={series.days[series.days.length - 1].slice(5).replace('-', '/')}
            {...band}
          />
          <Text style={styles.note}>
            {average === null ? '記録がありません' : `平均 ${Math.round(average * 10) / 10} ${unit}（${present.length} 日）`}
          </Text>
        </View>
      </ScrollView>
    </View>
  );
}

function Tile({ label, value, sub, ratio }: { label: string; value: string; sub: string; ratio: number | null }) {
  const color = ratio === null ? '#9ca3af' : ratio >= 1 ? '#2e7d32' : '#d97706';
  return (
    <View style={styles.tile}>
      <Text style={styles.tileLabel}>{label}</Text>
      <Text style={styles.tileValue}>{value}</Text>
      {ratio !== null && (
        <View style={styles.barTrack}>
          <View style={[styles.bar, { width: `${Math.max(2, Math.min(100, ratio * 100))}%`, backgroundColor: color }]} />
        </View>
      )}
      {!!sub && <Text style={styles.tileSub}>{sub}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f2f4f7' },
  toolbar: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    paddingHorizontal: 16, paddingVertical: 8, backgroundColor: '#fff',
    borderBottomWidth: 1, borderBottomColor: '#eee',
  },
  arrow:         { fontSize: 24, color: '#2e7d32', paddingHorizontal: 4 },
  arrowDisabled: { color: '#d1d5db' },
  date:          { fontSize: 15, fontWeight: 'bold', color: '#222' },
  body:      { padding: 16, paddingBottom: 40, gap: 10 },
  card:      { backgroundColor: '#fff', borderRadius: 16, padding: 14, gap: 8 },
  cardTitle: { fontSize: 14, fontWeight: 'bold', color: '#374151' },
  note:      { fontSize: 12, color: '#6b7280' },
  primary:     { backgroundColor: '#2e7d32', borderRadius: 12, paddingVertical: 12, alignItems: 'center' },
  primaryText: { color: '#fff', fontSize: 14, fontWeight: 'bold' },
  grid:      { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  tile:      { backgroundColor: '#fff', borderRadius: 16, padding: 12, gap: 4, width: '48%', flexGrow: 1 },
  tileLabel: { fontSize: 12, color: '#6b7280', fontWeight: '600' },
  tileValue: { fontSize: 18, color: '#111', fontWeight: 'bold' },
  tileSub:   { fontSize: 11, color: '#9ca3af' },
  barTrack:  { height: 4, borderRadius: 2, backgroundColor: '#f3f4f6', overflow: 'hidden' },
  bar:       { height: 4, borderRadius: 2 },
  insight:   { fontSize: 13, color: '#1f2937', lineHeight: 19 },
  warn:      { color: '#b45309', fontWeight: '700' },
  row:       { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  chip:      { paddingHorizontal: 12, paddingVertical: 4, borderRadius: 14, borderWidth: 1, borderColor: '#d1d5db', backgroundColor: '#fff' },
  chipActive:     { backgroundColor: '#2e7d32', borderColor: '#2e7d32' },
  chipText:       { fontSize: 12, color: '#374151', fontWeight: '600' },
  chipTextActive: { color: '#fff' },
});
