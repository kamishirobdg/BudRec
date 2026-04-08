import { StyleProp, Text, TextStyle } from 'react-native';

/**
 * memo を `name:price, name:price, ...` 形式とみなしてレンダリングする。
 * - カンマで改行
 * - `:` の右側が数値ならその数値部分のみ太字
 */
export default function MemoText({
  memo,
  style,
  numberOfLines,
}: {
  memo:           string;
  style?:         StyleProp<TextStyle>;
  numberOfLines?: number;
}) {
  const lines = memo
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  return (
    <Text style={style} numberOfLines={numberOfLines}>
      {lines.map((line, i) => {
        const prefix = i > 0 ? '\n' : '';
        const idx = line.lastIndexOf(':');
        if (idx < 0) {
          return <Text key={i}>{prefix}{line}</Text>;
        }
        const name  = line.slice(0, idx);
        const price = line.slice(idx + 1);
        if (!/^\d+$/.test(price)) {
          return <Text key={i}>{prefix}{line}</Text>;
        }
        return (
          <Text key={i}>
            {prefix}
            {name}:
            <Text style={{ fontWeight: 'bold' }}>{price}</Text>
          </Text>
        );
      })}
    </Text>
  );
}
