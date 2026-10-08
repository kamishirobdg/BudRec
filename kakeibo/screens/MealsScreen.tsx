import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { getMeals, isMealShared, MealRow } from '../services/MealService';
import { sumNutrients } from '../services/Nutrients';
import { getCurrentUser } from '../services/UserService';
import * as OcrWorker from '../services/OcrWorker';
import * as ReceiptQueue from '../services/ReceiptQueueService';
import { DEFAULT_PREFS, NutritionPrefs, loadPrefs } from '../services/NutritionPrefsService';
import { NutrientStatus, dayOf, judgeDay, shiftDay, today } from '../services/NutritionJudge';
import {
  Supplement, SupplementSkip, loadSupplements, setSkipped, supplementNutrients, supplementsOn,
} from '../services/SupplementService';
import { cachedLoad, writeCache } from '../services/LocalCache';
import MealEditModal, { MealTarget } from './MealEditModal';
import NutritionPrefsModal from './NutritionPrefsModal';
import SupplementsModal from './SupplementsModal';
import InventoryView from './InventoryView';
import DayView, { MealGroup } from './nutrition/DayView';
import TrendView from './nutrition/TrendView';

type View_ = 'day' | 'trend' | 'stock';

const WEEKDAY = ['日', '月', '火', '水', '木', '金', '土'];

function monthOfDay(day: string): string {
  return day.slice(0, 7);
}

function dayLabel(day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  return `${m}/${d}（${WEEKDAY[new Date(y, m - 1, d).getDay()]}）`;
}

/**
 * 「食事」タブ。1 日ごとに自分の栄養を見る（食事摂取基準での過不足・サプリを含む）。
 * 出すのは自分が食べた食事と、相手と共有された食事だけ。仕様は docs/meal-nutrition-spec.md §11。
 *
 * 表示を待たせないよう、前に読めた内容（端末の控え）をすぐ出し、通信が終わったら差し替える。
 */
export default function MealsScreen() {
  const [view, setView]         = useState<View_>('day');
  const [day, setDay]           = useState(today());
  const [span, setSpan]         = useState<7 | 30>(7);
  const [me, setMe]             = useState('');
  const [mealsByMonth, setMealsByMonth] = useState<Record<string, MealRow[]>>({});
  const [prefsMap, setPrefsMap] = useState<Map<string, NutritionPrefs>>(new Map());
  // 一度も読めていないうちに設定を開くと、既定の内容で保存して目標値を消してしまうので開かせない
  const [prefsReady, setPrefsReady] = useState(false);
  const [sups, setSups]         = useState<{ supplements: Supplement[]; skips: SupplementSkip[] }>({ supplements: [], skips: [] });
  const [loading, setLoading]   = useState(false);
  const [target, setTarget]     = useState<MealTarget | null>(null);
  const [prefsOpen, setPrefsOpen] = useState(false);
  const [supsOpen, setSupsOpen]   = useState(false);
  const [deferred, setDeferred] = useState(0);
  const [confirmCount, setConfirmCount] = useState(0);
  // 保存中のサプリ（続けて切り替えると、前の保存と順番が入れ違って最後の操作が残らないので待たせる）
  const [supSaving, setSupSaving] = useState<string | null>(null);
  const prefs = prefsMap.get(me) ?? DEFAULT_PREFS;

  /** 書き換えた後の内容を、画面と端末の控えの両方に入れる（控えが古いと、次に開いたとき元に戻って見える） */
  const applySups = (next: { supplements: Supplement[]; skips: SupplementSkip[] }) => {
    setSups(next);
    writeCache('supplements', next);
  };
  const applyPrefs = (next: Map<string, NutritionPrefs>) => {
    setPrefsMap(next);
    writeCache('nutrition_prefs', [...next.entries()]);
  };

  // 見ている日（と推移の期間）に要る月。朝 4 時区切りなので、翌月 1 日の深夜の食事は前の月の最後の日に入る
  const months = useMemo(() => {
    const from = view === 'trend' ? shiftDay(day, -(span - 1)) : day;
    const set = new Set<string>();
    for (let d = from; d <= shiftDay(day, 1); d = shiftDay(d, 1)) set.add(monthOfDay(d));
    return [...set];
  }, [day, span, view]);

  const loadMonths = useCallback(async (list: string[]) => {
    await Promise.all(list.map((m) => cachedLoad(`meals_${m}`, () => getMeals(m), (cached) => {
      setMealsByMonth((prev) => (prev[m] ? prev : { ...prev, [m]: cached }));
    }).then((fresh) => setMealsByMonth((prev) => ({ ...prev, [m]: fresh })))));
  }, []);

  // 引き下げて読み直すときは、そのとき見ている月を読む
  const monthsRef = useRef(months);
  monthsRef.current = months;
  const requestSeq = useRef(0);
  const loadAll = useCallback(async () => {
    const seq = ++requestSeq.current;
    setLoading(true);
    try {
      const user = await getCurrentUser();
      setMe(user);
      await Promise.all([
        cachedLoad('nutrition_prefs', async () => [...(await loadPrefs()).entries()], (entries) => setPrefsMap(new Map(entries)))
          .then((entries) => { setPrefsMap(new Map(entries)); setPrefsReady(true); }),
        cachedLoad('supplements', loadSupplements, setSups).then(setSups),
        loadMonths(monthsRef.current),
      ]);
    } catch (e) {
      if (seq === requestSeq.current) Alert.alert('読み込み失敗', e instanceof Error ? e.message : String(e));
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  }, [loadMonths]);

  useEffect(() => { loadAll(); }, [loadAll]);
  // 日付・期間を変えたら、足りない月だけ読む
  useEffect(() => {
    const missing = months.filter((m) => !mealsByMonth[m]);
    if (missing.length > 0) loadMonths(missing).catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [months]);

  // 推定待ちの食事の数。食事が記録されたら読み直す
  useEffect(() => {
    const refresh = () =>
      setDeferred(ReceiptQueue.listItems().filter((i) => i.kind === 'meal' && i.status === 'deferred').length);
    refresh();
    return OcrWorker.subscribe((e) => {
      refresh();
      if (e.type === 'saved') loadMonths(months).catch(() => {});
    });
  }, [loadMonths, months]);

  /** 自分が食べた食事と、共有された食事を、食事ごとにまとめる */
  const groups = useMemo(() => {
    const byMeal = new Map<string, MealRow[]>();
    for (const rows of Object.values(mealsByMonth)) {
      for (const r of rows) byMeal.set(r.mealId, [...(byMeal.get(r.mealId) ?? []), r]);
    }
    const out: (MealGroup & { day: string })[] = [];
    for (const rows of byMeal.values()) {
      const mine = rows.some((r) => r.user === me);
      if (!mine && !isMealShared(rows)) continue;
      out.push({
        mealId: rows[0].mealId, sheetName: rows[0].sheetName ?? '', eatenAt: rows[0].eatenAt, store: rows[0].store,
        rows, partnerOnly: !mine, day: dayOf(rows[0].eatenAt),
      });
    }
    return out.sort((a, b) => (a.eatenAt < b.eatenAt ? 1 : -1));
  }, [mealsByMonth, me]);

  const dayMeals = groups.filter((g) => g.day === day);
  const daySups = supplementsOn(me, day, sups.supplements, sups.skips);

  const trendDays = useMemo(() => {
    if (view !== 'trend') return [];
    const out: { day: string; statuses: NutrientStatus[] | null }[] = [];
    for (let i = span - 1; i >= 0; i--) {
      const d = shiftDay(day, -i);
      const mine = groups.filter((g) => g.day === d).flatMap((g) => g.rows.filter((r) => r.user === me).map((r) => r.nutrients));
      const supN = supplementNutrients(supplementsOn(me, d, sups.supplements, sups.skips));
      // 食事の記録が無い日は推移に入れない（サプリだけの日を「食べていない日」として数えない）
      if (mine.length === 0) {
        out.push({ day: d, statuses: null });
        continue;
      }
      const list = [...mine, ...supN];
      const totals: Record<string, number | null> = {};
      for (const [k, t] of Object.entries(sumNutrients(list))) totals[k] = t.partial && t.value === 0 ? null : t.value;
      out.push({ day: d, statuses: judgeDay(totals, prefs) });
    }
    return out;
  }, [view, span, day, groups, me, sups, prefs]);

  const reviewCount = new Set(groups.filter((g) => g.rows.some((r) => r.status === 'needs_review')).map((g) => g.mealId)).size;

  const toggleSupplement = async (s: Supplement, taken: boolean) => {
    if (supSaving) return;
    setSupSaving(s.supplementId);
    // 先に画面へ反映し、書けなかったら読み直す
    setSups((prev) => ({
      ...prev,
      skips: taken
        ? prev.skips.filter((k) => !(k.user === me && k.date === day && k.supplementId === s.supplementId))
        : [...prev.skips, { user: me, date: day, supplementId: s.supplementId, rowIndex: 0 }],
    }));
    try {
      await setSkipped(me, day, s.supplementId, !taken);
      applySups(await loadSupplements());
    } catch (e) {
      Alert.alert('保存失敗', e instanceof Error ? e.message : String(e));
      loadSupplements().then(applySups).catch(() => {});
    } finally {
      setSupSaving(null);
    }
  };

  const segment = (
    <View style={styles.segment}>
      {(['day', 'trend', 'stock'] as const).map((v) => (
        <TouchableOpacity key={v} style={[styles.segBtn, view === v && styles.segBtnActive]} onPress={() => setView(v)}>
          <Text style={[styles.segText, view === v && styles.segTextActive]}>
            {v === 'day' ? `1日${reviewCount > 0 ? `（要確認 ${reviewCount}）` : ''}`
              : v === 'trend' ? '推移'
                : `在庫${confirmCount > 0 ? `（確認 ${confirmCount}）` : ''}`}
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
        <TouchableOpacity onPress={() => setDay((d) => shiftDay(d, -1))}>
          <Text style={styles.arrow}>‹</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={() => setDay(today())}>
          <Text style={styles.date}>{dayLabel(day)}{view === 'trend' ? ` まで ${span} 日` : ''}</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={() => setDay((d) => (d < today() ? shiftDay(d, 1) : d))}>
          <Text style={[styles.arrow, day >= today() && styles.arrowDisabled]}>›</Text>
        </TouchableOpacity>
        <View style={styles.tools}>
          <TouchableOpacity style={styles.toolBtn} onPress={() => setSupsOpen(true)}>
            <Text style={styles.toolText}>サプリ</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.toolBtn}
            onPress={() => {
              if (!prefsReady) {
                Alert.alert('読み込み中', '設定を読み込んでから開いてください');
                return;
              }
              setPrefsOpen(true);
            }}
          >
            <Text style={styles.toolText}>表示</Text>
          </TouchableOpacity>
        </View>
      </View>

      {deferred > 0 && <Text style={styles.deferred}>推定待ち {deferred} 件（無料枠が戻ったら自動で処理）</Text>}

      {view === 'day' ? (
        <DayView
          me={me}
          day={day}
          meals={dayMeals}
          prefs={prefs}
          supplements={daySups}
          supplementNutrients={supplementNutrients(daySups)}
          loading={loading}
          onRefresh={loadAll}
          onOpenMeal={(g) => setTarget({ mode: 'edit', sheetName: g.sheetName, mealId: g.mealId })}
          onToggleSupplement={toggleSupplement}
          supplementSaving={supSaving !== null}
        />
      ) : (
        <TrendView days={trendDays} prefs={prefs} span={span} onSpan={setSpan} loading={loading} onRefresh={loadAll} />
      )}

      <NutritionPrefsModal
        user={prefsOpen ? me : null}
        prefs={prefs}
        onClose={() => setPrefsOpen(false)}
        onSaved={(next) => {
          applyPrefs(new Map(prefsMap).set(me, next));
          setPrefsOpen(false);
        }}
      />

      <SupplementsModal
        visible={supsOpen}
        user={me}
        supplements={sups.supplements}
        onClose={() => setSupsOpen(false)}
        onChanged={() => { loadSupplements().then(applySups).catch(() => {}); }}
      />

      <MealEditModal
        target={target}
        onClose={() => setTarget(null)}
        onSaved={() => { setTarget(null); loadMonths(months).catch(() => {}); }}
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
    flexDirection: 'row', alignItems: 'center', gap: 10,
    paddingHorizontal: 16, paddingVertical: 8, backgroundColor: '#fff',
    borderBottomWidth: 1, borderBottomColor: '#eee',
  },
  arrow:         { fontSize: 24, color: '#2e7d32', paddingHorizontal: 4 },
  arrowDisabled: { color: '#d1d5db' },
  date:          { fontSize: 15, fontWeight: 'bold', color: '#222' },
  tools:         { flexDirection: 'row', gap: 6, marginLeft: 'auto' },
  toolBtn:       { paddingHorizontal: 12, paddingVertical: 4, borderRadius: 14, borderWidth: 1, borderColor: '#2e7d32' },
  toolText:      { fontSize: 12, color: '#2e7d32', fontWeight: '600' },
  deferred:      { fontSize: 12, color: '#6b7280', paddingHorizontal: 16, paddingTop: 8 },
});
