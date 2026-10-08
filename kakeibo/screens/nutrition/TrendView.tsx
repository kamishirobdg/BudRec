import { useMemo, useState } from 'react';
import { RefreshControl, ScrollView, StyleSheet, Text, TouchableOpacity, View, useWindowDimensions } from 'react-native';
import Svg, { Circle, Line, Polyline, Rect, Text as SvgText } from 'react-native-svg';
import { NUTRIENTS, nutrientDef } from '../../services/Nutrients';
import type { NutritionPrefs } from '../../services/NutritionPrefsService';
import { Judgement, NutrientStatus } from '../../services/NutritionJudge';

interface Props {
  /** 古い順の日付と、その日の判定（記録の無い日は null） */
  days:      { day: string; statuses: NutrientStatus[] | null }[];
  prefs:     NutritionPrefs;
  span:      7 | 30;
  onSpan:    (span: 7 | 30) => void;
  loading:   boolean;
  onRefresh: () => void;
}

const COLOR: Record<Judgement, string> = { low: '#d97706', ok: '#2e7d32', high: '#dc2626', none: '#9ca3af' };
const HEIGHT = 200;
const PAD = { left: 40, right: 12, top: 12, bottom: 22 };

function fmt(v: number): string {
  return v >= 100 ? Math.round(v).toLocaleString('ja-JP') : String(Math.round(v * 10) / 10);
}

/** 栄養素ごとの推移（折れ線と適正の帯）と、期間の平均 */
export default function TrendView({ days, prefs, span, onSpan, loading, onRefresh }: Props) {
  const { width: screenWidth } = useWindowDimensions();
  const [key, setKey] = useState(prefs.visible[0] ?? 'ENERC_KCAL');
  const keys = [...prefs.visible, ...NUTRIENTS.map((n) => n.key).filter((k) => !prefs.visible.includes(k))]
    .filter((k) => k !== 'NA');
  const [showAllKeys, setShowAllKeys] = useState(false);

  const points = useMemo(() => days.map((d) => ({
    day: d.day,
    status: d.statuses?.find((s) => s.key === key) ?? null,
  })), [days, key]);

  const width = screenWidth - 32 - 28;
  const recorded = points.filter((p) => p.status?.plot !== null && p.status?.plot !== undefined);
  const values = recorded.map((p) => p.status!.plot!);
  const band = recorded.find((p) => p.status?.bandLow !== undefined)?.status;
  const unit = recorded[0]?.status?.plotUnit ?? nutrientDef(key)?.unit ?? '';
  const max = Math.max(1, ...values, band?.bandHigh ?? 0, band?.bandLow ?? 0) * 1.1;
  const x = (i: number) => PAD.left + (points.length <= 1 ? 0 : (i / (points.length - 1)) * (width - PAD.left - PAD.right));
  const y = (v: number) => PAD.top + (1 - v / max) * (HEIGHT - PAD.top - PAD.bottom);

  // 記録の無い日で線を切る
  const segments: { x: number; y: number }[][] = [];
  let current: { x: number; y: number }[] = [];
  points.forEach((p, i) => {
    const v = p.status?.plot;
    if (v === null || v === undefined) {
      if (current.length > 0) segments.push(current);
      current = [];
    } else {
      current.push({ x: x(i), y: y(v) });
    }
  });
  if (current.length > 0) segments.push(current);

  const average = values.length > 0 ? values.reduce((a, b) => a + b, 0) / values.length : null;
  const okDays = recorded.filter((p) => p.status?.judgement === 'ok').length;
  const label = nutrientDef(key)?.label ?? key;

  return (
    <ScrollView contentContainerStyle={styles.body} refreshControl={<RefreshControl refreshing={loading} onRefresh={onRefresh} />}>
      <View style={styles.row}>
        {([7, 30] as const).map((s) => (
          <TouchableOpacity key={s} style={[styles.chip, span === s && styles.chipActive]} onPress={() => onSpan(s)}>
            <Text style={[styles.chipText, span === s && styles.chipTextActive]}>{s} 日</Text>
          </TouchableOpacity>
        ))}
      </View>
      <View style={styles.keys}>
        {(showAllKeys ? keys : keys.filter((k) => prefs.visible.includes(k))).map((k) => (
          <TouchableOpacity key={k} style={[styles.chip, key === k && styles.chipActive]} onPress={() => setKey(k)}>
            <Text style={[styles.chipText, key === k && styles.chipTextActive]}>{nutrientDef(k)?.label ?? k}</Text>
          </TouchableOpacity>
        ))}
        <TouchableOpacity onPress={() => setShowAllKeys((v) => !v)}>
          <Text style={styles.more}>{showAllKeys ? '少なく' : 'ほかの栄養素'}</Text>
        </TouchableOpacity>
      </View>

      <View style={styles.card}>
        <Text style={styles.title}>{label}{unit === '%' ? '（エネルギー比）' : ''}</Text>
        <Svg width={width} height={HEIGHT}>
          {band && (
            <Rect
              x={PAD.left}
              y={y(Math.min(band.bandHigh ?? max, max))}
              width={width - PAD.left - PAD.right}
              height={Math.max(0, y(band.bandLow ?? 0) - y(Math.min(band.bandHigh ?? max, max)))}
              fill="#dcfce7"
            />
          )}
          <Line x1={PAD.left} y1={y(0)} x2={width - PAD.right} y2={y(0)} stroke="#e5e7eb" />
          <SvgText x={PAD.left - 4} y={y(max / 1.1) + 4} fontSize={10} fill="#9ca3af" textAnchor="end">{fmt(max / 1.1)}</SvgText>
          <SvgText x={PAD.left - 4} y={y(0)} fontSize={10} fill="#9ca3af" textAnchor="end">0</SvgText>
          {segments.map((seg, i) => (
            seg.length > 1
              ? <Polyline key={i} points={seg.map((p) => `${p.x},${p.y}`).join(' ')} fill="none" stroke="#2563eb" strokeWidth={2} />
              : null
          ))}
          {points.map((p, i) => (p.status?.plot !== null && p.status?.plot !== undefined
            ? <Circle key={p.day} cx={x(i)} cy={y(p.status.plot)} r={3} fill={COLOR[p.status.judgement]} />
            : null))}
          {points.length > 0 && (
            <>
              <SvgText x={x(0)} y={HEIGHT - 6} fontSize={10} fill="#9ca3af" textAnchor="start">{points[0].day.slice(5).replace('-', '/')}</SvgText>
              <SvgText x={x(points.length - 1)} y={HEIGHT - 6} fontSize={10} fill="#9ca3af" textAnchor="end">
                {points[points.length - 1].day.slice(5).replace('-', '/')}
              </SvgText>
            </>
          )}
        </Svg>
        <Text style={styles.summary}>
          {average === null
            ? '記録がありません'
            : `平均 ${fmt(average)}${unit}　適正 ${okDays} / ${recorded.length} 日${band?.standard ? `　基準 ${band.standard}` : ''}`}
        </Text>
      </View>

      <View style={styles.card}>
        <Text style={styles.title}>期間の平均</Text>
        {keys.filter((k) => prefs.visible.includes(k)).map((k) => {
          const vals = days.map((d) => d.statuses?.find((s) => s.key === k)).filter((s): s is NutrientStatus => !!s && s.value !== null);
          if (vals.length === 0) return null;
          const avg = vals.reduce((a, s) => a + (s.value ?? 0), 0) / vals.length;
          const ok = vals.filter((s) => s.judgement === 'ok').length;
          return (
            <View key={k} style={styles.avgRow}>
              <Text style={styles.avgLabel}>{nutrientDef(k)?.label}</Text>
              <Text style={styles.avgValue}>{fmt(avg)}{nutrientDef(k)?.unit}</Text>
              <Text style={styles.avgOk}>適正 {ok}/{vals.length} 日</Text>
            </View>
          );
        })}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  body:    { padding: 16, paddingBottom: 40, gap: 10 },
  row:     { flexDirection: 'row', gap: 6 },
  keys:    { flexDirection: 'row', flexWrap: 'wrap', gap: 6, alignItems: 'center' },
  chip:    { paddingHorizontal: 12, paddingVertical: 4, borderRadius: 14, borderWidth: 1, borderColor: '#d1d5db', backgroundColor: '#fff' },
  chipActive:     { backgroundColor: '#2e7d32', borderColor: '#2e7d32' },
  chipText:       { fontSize: 12, color: '#374151', fontWeight: '600' },
  chipTextActive: { color: '#fff' },
  more:    { fontSize: 12, color: '#2563eb', fontWeight: '600', paddingHorizontal: 4 },
  card:    { backgroundColor: '#fff', borderRadius: 16, padding: 14, gap: 6 },
  title:   { fontSize: 14, fontWeight: 'bold', color: '#374151' },
  summary: { fontSize: 12, color: '#6b7280' },
  avgRow:  { flexDirection: 'row', alignItems: 'center', gap: 8, borderTopWidth: 1, borderTopColor: '#f3f4f6', paddingVertical: 4 },
  avgLabel: { flex: 1, fontSize: 13, color: '#1f2937' },
  avgValue: { fontSize: 13, fontWeight: '600', color: '#1f2937' },
  avgOk:    { fontSize: 12, color: '#6b7280', width: 90, textAlign: 'right' },
});
