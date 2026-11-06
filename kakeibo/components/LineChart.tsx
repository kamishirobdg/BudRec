import Svg, { Circle, Line, Polyline, Rect, Text as SvgText } from 'react-native-svg';

interface Props {
  width:   number;
  height?: number;
  /** 古い順。記録の無い日は null（線を切る） */
  values:  (number | null)[];
  /** 両端に出す日付ラベル */
  firstLabel: string;
  lastLabel:  string;
  /** 目安の帯（下限〜上限。上限が無ければ上まで） */
  bandLow?:  number;
  bandHigh?: number;
  /** 点の色（無ければ線と同じ） */
  colors?: (string | null)[];
}

const PAD = { left: 40, right: 12, top: 12, bottom: 22 };

function fmt(v: number): string {
  return v >= 100 ? Math.round(v).toLocaleString('ja-JP') : String(Math.round(v * 10) / 10);
}

/** 日ごとの値の折れ線（目安の帯付き） */
export default function LineChart({ width, height = 180, values, firstLabel, lastLabel, bandLow, bandHigh, colors }: Props) {
  const present = values.filter((v): v is number => v !== null);
  const max = Math.max(1, ...present, bandHigh ?? 0, bandLow ?? 0) * 1.1;
  const x = (i: number) => PAD.left + (values.length <= 1 ? 0 : (i / (values.length - 1)) * (width - PAD.left - PAD.right));
  const y = (v: number) => PAD.top + (1 - v / max) * (height - PAD.top - PAD.bottom);

  const segments: string[] = [];
  let current: string[] = [];
  values.forEach((v, i) => {
    if (v === null) {
      if (current.length > 1) segments.push(current.join(' '));
      current = [];
    } else {
      current.push(`${x(i)},${y(v)}`);
    }
  });
  if (current.length > 1) segments.push(current.join(' '));

  const hasBand = bandLow !== undefined || bandHigh !== undefined;
  const bandTop = y(Math.min(bandHigh ?? max, max));
  const bandBottom = y(bandLow ?? 0);

  return (
    <Svg width={width} height={height}>
      {hasBand && (
        <Rect x={PAD.left} y={bandTop} width={width - PAD.left - PAD.right} height={Math.max(0, bandBottom - bandTop)} fill="#dcfce7" />
      )}
      <Line x1={PAD.left} y1={y(0)} x2={width - PAD.right} y2={y(0)} stroke="#e5e7eb" />
      <SvgText x={PAD.left - 4} y={y(max / 1.1) + 4} fontSize={10} fill="#9ca3af" textAnchor="end">{fmt(max / 1.1)}</SvgText>
      <SvgText x={PAD.left - 4} y={y(0)} fontSize={10} fill="#9ca3af" textAnchor="end">0</SvgText>
      {segments.map((pts, i) => <Polyline key={i} points={pts} fill="none" stroke="#2563eb" strokeWidth={2} />)}
      {values.map((v, i) => (v === null ? null : <Circle key={i} cx={x(i)} cy={y(v)} r={3} fill={colors?.[i] ?? '#2563eb'} />))}
      <SvgText x={x(0)} y={height - 6} fontSize={10} fill="#9ca3af" textAnchor="start">{firstLabel}</SvgText>
      <SvgText x={x(values.length - 1)} y={height - 6} fontSize={10} fill="#9ca3af" textAnchor="end">{lastLabel}</SvgText>
    </Svg>
  );
}
