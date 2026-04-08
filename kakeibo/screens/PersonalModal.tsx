import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Button,
  FlatList,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
  ExpenseRow,
  RangeSpec,
  getRowsForRange,
  getSheetNameFromDate,
  listAvailableYears,
  listMonthSheetNames,
} from '../services/SheetsService';
import { getCurrentUser } from '../services/UserService';
import MemoText from './MemoText';

interface RangeOption {
  key:   string;
  label: string;
  spec:  RangeSpec;
}

interface Props {
  visible: boolean;
  onClose: () => void;
}

export default function PersonalModal({ visible, onClose }: Props) {
  const [rows, setRows]                 = useState<ExpenseRow[]>([]);
  const [loading, setLoading]           = useState(false);
  const [currentUser, setCurrentUserState] = useState<string>('');

  const [rangeOptions, setRangeOptions] = useState<RangeOption[]>([]);
  const [rangeKey, setRangeKey]         = useState<string>(() => `month:${getSheetNameFromDate()}`);
  const [pickerOpen, setPickerOpen]     = useState(false);

  const currentRange = useMemo<RangeSpec>(() => {
    const opt = rangeOptions.find((o) => o.key === rangeKey);
    if (opt) return opt.spec;
    return { type: 'month', yearMonth: getSheetNameFromDate() };
  }, [rangeOptions, rangeKey]);

  const currentRangeLabel = useMemo(() => {
    return rangeOptions.find((o) => o.key === rangeKey)?.label ?? '当月';
  }, [rangeOptions, rangeKey]);

  const buildRangeOptions = useCallback(async () => {
    const [months, years] = await Promise.all([
      listMonthSheetNames(),
      listAvailableYears(),
    ]);
    const current = getSheetNameFromDate();
    const monthList = months.includes(current) ? months : [current, ...months];
    const opts: RangeOption[] = [];
    for (const m of monthList) {
      opts.push({ key: `month:${m}`, label: m, spec: { type: 'month', yearMonth: m } });
    }
    for (const y of years) {
      opts.push({ key: `year:${y}`, label: `${y}年`, spec: { type: 'year', year: y } });
    }
    opts.push({ key: 'all', label: '全て', spec: { type: 'all' } });
    setRangeOptions(opts);
  }, []);

  const loadRows = useCallback(async (range: RangeSpec) => {
    setLoading(true);
    try {
      const [list, user] = await Promise.all([
        getRowsForRange(range),
        getCurrentUser(),
      ]);
      list.sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1));
      setRows(list);
      setCurrentUserState(user);
    } catch (e) {
      Alert.alert('読み込み失敗', e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  // モーダルを開いたタイミングでロード
  useEffect(() => {
    if (!visible) return;
    buildRangeOptions();
  }, [visible, buildRangeOptions]);

  useEffect(() => {
    if (!visible) return;
    loadRows(currentRange);
  }, [visible, loadRows, currentRange]);

  // 自分の除外行のみ
  const personalRows = useMemo(
    () => rows.filter((r) => r.user === currentUser && r.excluded),
    [rows, currentUser],
  );

  const summary = useMemo(() => {
    const byCategory = new Map<string, number>();
    let total = 0;
    for (const r of personalRows) {
      // 除外行は counted_amount ではなく amount を使う
      // （個人消費としての本来の金額を見たいので）
      total += r.amount;
      byCategory.set(r.category, (byCategory.get(r.category) ?? 0) + r.amount);
    }
    return {
      total,
      categories: [...byCategory.entries()].sort((a, b) => b[1] - a[1]),
    };
  }, [personalRows]);

  const renderHeader = () => (
    <View style={styles.summaryBox}>
      <View style={styles.rangeRow}>
        <Text style={styles.rangeLabel}>範囲</Text>
        <TouchableOpacity
          style={styles.rangeButton}
          onPress={() => setPickerOpen(true)}
        >
          <Text style={styles.rangeButtonText}>{currentRangeLabel} ▾</Text>
        </TouchableOpacity>
      </View>

      <Text style={styles.summaryTotal}>個人消費合計 ¥{summary.total.toLocaleString()}</Text>

      <Text style={styles.summarySection}>カテゴリ別</Text>
      {summary.categories.length === 0 ? (
        <Text style={styles.summaryEmpty}>データ無し</Text>
      ) : (
        summary.categories.map(([c, v]) => (
          <View key={c} style={styles.summaryRow}>
            <Text style={styles.summaryLabel}>{c || '(未設定)'}</Text>
            <Text style={styles.summaryValue}>¥{v.toLocaleString()}</Text>
          </View>
        ))
      )}

      <Text style={[styles.summarySection, { marginTop: 16 }]}>明細</Text>
    </View>
  );

  const renderItem = ({ item }: { item: ExpenseRow }) => (
    <View style={styles.entry}>
      <View style={styles.entryHeader}>
        <Text style={styles.entryDate}>{item.timestamp}</Text>
        <Text style={styles.entryAmount}>¥{item.amount.toLocaleString()}</Text>
      </View>
      <Text style={styles.entryStore}>
        {item.store || '(店舗無し)'} / {item.category}
      </Text>
      {!!item.memo && (
        <MemoText memo={item.memo} style={styles.entryMemo} />
      )}
    </View>
  );

  return (
    <Modal
      visible={visible}
      animationType="slide"
      onRequestClose={onClose}
    >
      <SafeAreaView style={{ flex: 1, backgroundColor: '#fff' }}>
        <View style={styles.modalHeader}>
          <Text style={styles.modalHeaderTitle}>個人消費</Text>
          <Button title="閉じる" onPress={onClose} />
        </View>
        {loading && rows.length === 0 ? (
          <View style={styles.center}>
            <ActivityIndicator />
          </View>
        ) : (
          <FlatList
            data={personalRows}
            keyExtractor={(r) => `${r.sheetName ?? ''}:${r.rowIndex ?? r.timestamp}`}
            renderItem={renderItem}
            ListHeaderComponent={renderHeader}
            ListEmptyComponent={
              <Text style={styles.empty}>除外マークの付いた行がありません</Text>
            }
          />
        )}

        <Modal
          visible={pickerOpen}
          transparent
          animationType="fade"
          onRequestClose={() => setPickerOpen(false)}
        >
          <Pressable style={styles.modalBackdrop} onPress={() => setPickerOpen(false)}>
            <Pressable style={styles.modalSheet} onPress={(e) => e.stopPropagation()}>
              <Text style={styles.pickerTitle}>範囲を選択</Text>
              <FlatList
                data={rangeOptions}
                keyExtractor={(o) => o.key}
                renderItem={({ item }) => (
                  <TouchableOpacity
                    style={[
                      styles.pickerItem,
                      item.key === rangeKey && styles.pickerItemSelected,
                    ]}
                    onPress={() => {
                      setRangeKey(item.key);
                      setPickerOpen(false);
                    }}
                  >
                    <Text
                      style={[
                        styles.pickerItemText,
                        item.key === rangeKey && styles.pickerItemTextSelected,
                      ]}
                    >
                      {item.label}
                    </Text>
                  </TouchableOpacity>
                )}
              />
            </Pressable>
          </Pressable>
        </Modal>
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  empty:  { textAlign: 'center', color: '#888', marginTop: 24 },

  modalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#eee',
  },
  modalHeaderTitle: { fontSize: 18, fontWeight: 'bold' },

  summaryBox: {
    padding: 16,
    backgroundColor: '#f7f7f9',
    borderBottomWidth: 1,
    borderBottomColor: '#eee',
  },
  rangeRow: {
    flexDirection: 'row',
    alignItems:    'center',
    gap:           8,
    marginBottom:  8,
  },
  rangeLabel:      { fontSize: 13, color: '#444' },
  rangeButton: {
    paddingHorizontal: 12,
    paddingVertical:   6,
    backgroundColor:   '#fff',
    borderWidth:       1,
    borderColor:       '#ccc',
    borderRadius:      6,
  },
  rangeButtonText: { fontSize: 14, color: '#222' },
  summaryTotal:   { fontSize: 22, fontWeight: 'bold', color: '#dc2626', marginBottom: 12 },
  summarySection: { fontSize: 14, fontWeight: 'bold', color: '#444', marginTop: 8, marginBottom: 4 },
  summaryEmpty:   { fontSize: 13, color: '#888' },
  summaryRow:     { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 2 },
  summaryLabel:   { fontSize: 14, color: '#222' },
  summaryValue:   { fontSize: 14, color: '#222' },

  entry: {
    paddingHorizontal: 16,
    paddingVertical:   12,
    borderBottomWidth: 1,
    borderBottomColor: '#eee',
  },
  entryHeader:   { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  entryDate:     { fontSize: 12, color: '#666' },
  entryAmount:   { fontSize: 16, fontWeight: 'bold' },
  entryStore:    { fontSize: 15, marginTop: 2 },
  entryMemo:     { fontSize: 12, color: '#666', marginTop: 2 },

  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.4)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  modalSheet: {
    backgroundColor: '#fff',
    borderRadius: 12,
    width: '80%',
    maxHeight: '70%',
    paddingVertical: 12,
  },
  pickerTitle: {
    fontSize: 16,
    fontWeight: 'bold',
    paddingHorizontal: 16,
    paddingBottom: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#eee',
  },
  pickerItem: {
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  pickerItemSelected: { backgroundColor: '#eaf2ff' },
  pickerItemText: { fontSize: 15, color: '#222' },
  pickerItemTextSelected: { color: '#2563eb', fontWeight: 'bold' },
});
