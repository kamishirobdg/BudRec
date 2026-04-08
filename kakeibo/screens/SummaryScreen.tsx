import { useCallback, useEffect, useLayoutEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Button,
  FlatList,
  Modal,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import {
  ExpenseRow,
  RangeSpec,
  getDefaultPartialAmount,
  getRowsForRange,
  getSheetNameFromDate,
  listAvailableYears,
  listMonthSheetNames,
  updateRow,
  updateRowFlags,
} from '../services/SheetsService';
import { getCurrentUser } from '../services/UserService';
import SettingsScreen from './SettingsScreen';

interface Props {
  onSignedOut: () => void;
}

interface RangeOption {
  key:   string;   // 一意キー
  label: string;   // プルダウン表示
  spec:  RangeSpec;
}

export default function SummaryScreen({ onSignedOut }: Props) {
  const navigation = useNavigation();
  const [rows, setRows]                     = useState<ExpenseRow[]>([]);
  const [loading, setLoading]               = useState(false);
  const [refreshing, setRefreshing]         = useState(false);
  const [defaultPartial, setDefaultPartial] = useState(1000);
  const [currentUser, setCurrentUserState]  = useState<string>('');
  const [expanded, setExpanded]             = useState<Set<string>>(new Set());

  const [rangeOptions, setRangeOptions] = useState<RangeOption[]>([]);
  const [rangeKey, setRangeKey]         = useState<string>(() => `month:${getSheetNameFromDate()}`);
  const [pickerOpen, setPickerOpen]     = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [editTarget, setEditTarget]     = useState<ExpenseRow | null>(null);

  // ヘッダー右に設定ボタンを置く
  useLayoutEffect(() => {
    navigation.setOptions({
      headerRight: () => (
        <TouchableOpacity
          onPress={() => setSettingsOpen(true)}
          style={{ paddingHorizontal: 16, paddingVertical: 4 }}
        >
          <Text style={{ fontSize: 20 }}>⚙</Text>
        </TouchableOpacity>
      ),
    });
  }, [navigation]);

  const currentRange = useMemo<RangeSpec>(() => {
    const opt = rangeOptions.find((o) => o.key === rangeKey);
    if (opt) return opt.spec;
    // フォールバック: 当月
    return { type: 'month', yearMonth: getSheetNameFromDate() };
  }, [rangeOptions, rangeKey]);

  const currentRangeLabel = useMemo(() => {
    return rangeOptions.find((o) => o.key === rangeKey)?.label ?? '当月';
  }, [rangeOptions, rangeKey]);

  // 範囲オプションを作る（月一覧と年一覧をシートから取得）
  const buildRangeOptions = useCallback(async () => {
    const [months, years] = await Promise.all([
      listMonthSheetNames(),
      listAvailableYears(),
    ]);
    const current = getSheetNameFromDate();
    // 当月が一覧に無くても先頭に置く
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
      const [list, partial, user] = await Promise.all([
        getRowsForRange(range),
        getDefaultPartialAmount(),
        getCurrentUser(),
      ]);
      list.sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1));
      setRows(list);
      setDefaultPartial(partial);
      setCurrentUserState(user);
    } catch (e) {
      Alert.alert('読み込み失敗', e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    buildRangeOptions();
  }, [buildRangeOptions]);

  useEffect(() => {
    loadRows(currentRange);
  }, [loadRows, currentRange]);

  const handleRefresh = async () => {
    setRefreshing(true);
    await Promise.all([buildRangeOptions(), loadRows(currentRange)]);
    setRefreshing(false);
  };

  /** 行をローカルで更新しつつスプレッドシートにも反映 */
  const persistRow = async (
    row: ExpenseRow,
    next: { countedAmount: number; excluded: boolean },
  ) => {
    if (row.rowIndex === undefined || !row.sheetName) return;
    const key = `${row.sheetName}:${row.rowIndex}`;
    setRows((prev) =>
      prev.map((r) =>
        r.sheetName === row.sheetName && r.rowIndex === row.rowIndex
          ? { ...r, countedAmount: next.countedAmount, excluded: next.excluded }
          : r,
      ),
    );
    try {
      await updateRowFlags(row.sheetName, row.rowIndex, next);
    } catch (e) {
      Alert.alert('更新失敗', e instanceof Error ? e.message : String(e));
      loadRows(currentRange);
    }
    void key;
  };

  const toggleExcluded = (row: ExpenseRow) => {
    persistRow(row, {
      countedAmount: row.countedAmount,
      excluded:      !row.excluded,
    });
  };

  const togglePartial = (row: ExpenseRow) => {
    const isPartial = row.countedAmount !== row.amount;
    persistRow(row, {
      countedAmount: isPartial ? row.amount : defaultPartial,
      excluded:      row.excluded,
    });
  };

  const commitPartialAmount = (row: ExpenseRow, text: string) => {
    const n = Number(text.replace(/[^\d]/g, ''));
    if (!Number.isFinite(n) || n <= 0) return;
    persistRow(row, { countedAmount: n, excluded: row.excluded });
  };

  const toggleExpanded = (key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  // ─── 集計対象（自分の行のみ） ───
  const myRows = useMemo(
    () => rows.filter((r) => r.user === currentUser),
    [rows, currentUser],
  );

  const summary = useMemo(() => {
    const byUser     = new Map<string, number>();
    const byCategory = new Map<string, number>();
    let total = 0;
    // サマリは「当該範囲の全員分」を表示（夫婦比較のため）
    for (const r of rows) {
      if (r.excluded) continue;
      total += r.countedAmount;
      byUser.set(r.user, (byUser.get(r.user) ?? 0) + r.countedAmount);
      byCategory.set(r.category, (byCategory.get(r.category) ?? 0) + r.countedAmount);
    }
    return {
      total,
      users:      [...byUser.entries()].sort((a, b) => b[1] - a[1]),
      categories: [...byCategory.entries()].sort((a, b) => b[1] - a[1]),
    };
  }, [rows]);

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

      <Text style={styles.summaryTotal}>合計 ¥{summary.total.toLocaleString()}</Text>

      <Text style={styles.summarySection}>ユーザー別</Text>
      {summary.users.length === 0 ? (
        <Text style={styles.summaryEmpty}>データ無し</Text>
      ) : (
        summary.users.map(([u, v]) => (
          <View key={u} style={styles.summaryRow}>
            <Text style={styles.summaryLabel}>{u || '(未設定)'}</Text>
            <Text style={styles.summaryValue}>¥{v.toLocaleString()}</Text>
          </View>
        ))
      )}

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

      <Text style={[styles.summarySection, { marginTop: 16 }]}>
        明細（{currentUser || '自分'}）
      </Text>
    </View>
  );

  const renderItem = ({ item }: { item: ExpenseRow }) => {
    const isPartial = item.countedAmount !== item.amount;
    const struck = item.excluded ? styles.struck : undefined;
    const key = `${item.sheetName ?? ''}:${item.rowIndex ?? ''}`;
    const isExpanded = expanded.has(key);

    return (
      <View style={[styles.entry, item.excluded && styles.entryExcluded]}>
        <View style={styles.entryHeader}>
          <Text style={[styles.entryDate, struck]}>{item.timestamp}</Text>
          <Text style={[styles.entryAmount, struck]}>
            ¥{item.amount.toLocaleString()}
          </Text>
        </View>
        <Text style={[styles.entryStore, struck]}>
          {item.store || '(店舗無し)'} / {item.category}
        </Text>
        <Text style={[styles.entryMeta, struck]}>
          {item.user} · {item.source}
        </Text>
        {!!item.memo && (
          <TouchableOpacity onPress={() => toggleExpanded(key)} activeOpacity={0.6}>
            <Text
              style={[styles.entryMemo, struck]}
              numberOfLines={isExpanded ? undefined : 2}
            >
              {item.memo}
            </Text>
          </TouchableOpacity>
        )}

        <View style={styles.controls}>
          <Checkbox
            label="除外"
            checked={item.excluded}
            onPress={() => toggleExcluded(item)}
          />
          <Checkbox
            label="一部計上"
            checked={isPartial}
            onPress={() => togglePartial(item)}
          />
          {isPartial && (
            <PartialAmountInput
              value={item.countedAmount}
              onCommit={(t) => commitPartialAmount(item, t)}
            />
          )}
          <TouchableOpacity
            style={styles.editBtn}
            onPress={() => setEditTarget(item)}
          >
            <Text style={styles.editBtnText}>編集</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  };

  const handleSaveEdit = async (updated: ExpenseRow) => {
    if (!updated.sheetName || updated.rowIndex === undefined) return;
    try {
      await updateRow(updated.sheetName, updated.rowIndex, updated);
      setRows((prev) =>
        prev.map((r) =>
          r.sheetName === updated.sheetName && r.rowIndex === updated.rowIndex
            ? updated
            : r,
        ),
      );
      setEditTarget(null);
    } catch (e) {
      Alert.alert('保存失敗', e instanceof Error ? e.message : String(e));
    }
  };

  if (loading && rows.length === 0) {
    return (
      <SafeAreaView style={styles.center}>
        <ActivityIndicator />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      <FlatList
        data={myRows}
        keyExtractor={(r) => `${r.sheetName ?? ''}:${r.rowIndex ?? r.timestamp}`}
        renderItem={renderItem}
        ListHeaderComponent={renderHeader}
        ListEmptyComponent={
          <Text style={styles.empty}>データがありません</Text>
        }
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={handleRefresh} />
        }
      />

      <RangePickerModal
        visible={pickerOpen}
        options={rangeOptions}
        selected={rangeKey}
        onSelect={(k) => {
          setRangeKey(k);
          setPickerOpen(false);
        }}
        onClose={() => setPickerOpen(false)}
      />

      <Modal
        visible={settingsOpen}
        animationType="slide"
        onRequestClose={() => setSettingsOpen(false)}
      >
        <SafeAreaView style={{ flex: 1, backgroundColor: '#fff' }}>
          <View style={styles.modalHeader}>
            <Text style={styles.modalHeaderTitle}>設定</Text>
            <Button title="閉じる" onPress={() => setSettingsOpen(false)} />
          </View>
          <SettingsScreen
            onSignedOut={() => {
              setSettingsOpen(false);
              onSignedOut();
            }}
          />
        </SafeAreaView>
      </Modal>

      <EditEntryModal
        target={editTarget}
        onClose={() => setEditTarget(null)}
        onSave={handleSaveEdit}
      />
    </SafeAreaView>
  );
}

// ─── 部品 ────────────────────────────────────────────────────────────────────

function Checkbox({
  label,
  checked,
  onPress,
}: {
  label:   string;
  checked: boolean;
  onPress: () => void;
}) {
  return (
    <TouchableOpacity style={styles.checkbox} onPress={onPress}>
      <View style={[styles.box, checked && styles.boxChecked]}>
        {checked && <Text style={styles.boxMark}>✓</Text>}
      </View>
      <Text style={styles.checkboxLabel}>{label}</Text>
    </TouchableOpacity>
  );
}

function PartialAmountInput({
  value,
  onCommit,
}: {
  value:    number;
  onCommit: (text: string) => void;
}) {
  const [text, setText] = useState(String(value));
  useEffect(() => {
    setText(String(value));
  }, [value]);

  return (
    <TextInput
      style={styles.partialInput}
      value={text}
      keyboardType="number-pad"
      onChangeText={setText}
      onBlur={() => onCommit(text)}
    />
  );
}

function EditEntryModal({
  target,
  onClose,
  onSave,
}: {
  target:  ExpenseRow | null;
  onClose: () => void;
  onSave:  (updated: ExpenseRow) => void;
}) {
  const [timestamp, setTimestamp]         = useState('');
  const [source, setSource]               = useState('');
  const [user, setUser]                   = useState('');
  const [store, setStore]                 = useState('');
  const [category, setCategory]           = useState('');
  const [amount, setAmount]               = useState('');
  const [memo, setMemo]                   = useState('');
  const [countedAmount, setCountedAmount] = useState('');
  const [excluded, setExcluded]           = useState(false);

  useEffect(() => {
    if (!target) return;
    setTimestamp(target.timestamp);
    setSource(target.source);
    setUser(target.user);
    setStore(target.store);
    setCategory(target.category);
    setAmount(String(target.amount));
    setMemo(target.memo);
    setCountedAmount(String(target.countedAmount));
    setExcluded(target.excluded);
  }, [target]);

  if (!target) return null;

  const handleSave = () => {
    const amt = Number(amount.replace(/[^\d]/g, ''));
    const cnt = Number(countedAmount.replace(/[^\d]/g, ''));
    if (!Number.isFinite(amt) || amt < 0) {
      Alert.alert('入力エラー', '金額が不正です');
      return;
    }
    onSave({
      ...target,
      timestamp,
      source,
      user,
      store,
      category,
      amount:        amt,
      memo,
      countedAmount: Number.isFinite(cnt) && cnt > 0 ? cnt : amt,
      excluded,
    });
  };

  return (
    <Modal
      visible={target !== null}
      animationType="slide"
      onRequestClose={onClose}
    >
      <SafeAreaView style={{ flex: 1, backgroundColor: '#fff' }}>
        <View style={styles.modalHeader}>
          <Text style={styles.modalHeaderTitle}>明細編集</Text>
          <Button title="閉じる" onPress={onClose} />
        </View>
        <ScrollView contentContainerStyle={styles.editForm}>
          <Field label="日時 (YYYY-MM-DD HH:MM)" value={timestamp} onChangeText={setTimestamp} />
          <Field label="取込元 (source)" value={source} onChangeText={setSource} />
          <Field label="ユーザー" value={user} onChangeText={setUser} />
          <Field label="店舗" value={store} onChangeText={setStore} />
          <Field label="カテゴリ" value={category} onChangeText={setCategory} />
          <Field
            label="金額"
            value={amount}
            onChangeText={setAmount}
            keyboardType="number-pad"
          />
          <Field
            label="計上金額"
            value={countedAmount}
            onChangeText={setCountedAmount}
            keyboardType="number-pad"
          />
          <Field
            label="メモ"
            value={memo}
            onChangeText={setMemo}
            multiline
          />

          <TouchableOpacity
            style={styles.checkbox}
            onPress={() => setExcluded((v) => !v)}
          >
            <View style={[styles.box, excluded && styles.boxChecked]}>
              {excluded && <Text style={styles.boxMark}>✓</Text>}
            </View>
            <Text style={styles.checkboxLabel}>集計から除外</Text>
          </TouchableOpacity>

          <View style={{ height: 16 }} />
          <Button title="保存" onPress={handleSave} />
          <Text style={styles.editNote}>
            ※ 日時の月を変更しても行は元のシート（{target.sheetName}）のまま残ります
          </Text>
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
}

function Field({
  label,
  value,
  onChangeText,
  keyboardType,
  multiline,
}: {
  label:         string;
  value:         string;
  onChangeText:  (t: string) => void;
  keyboardType?: 'default' | 'number-pad';
  multiline?:    boolean;
}) {
  return (
    <View style={styles.fieldBox}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TextInput
        style={[styles.fieldInput, multiline && styles.fieldInputMulti]}
        value={value}
        onChangeText={onChangeText}
        keyboardType={keyboardType ?? 'default'}
        multiline={multiline}
      />
    </View>
  );
}

function RangePickerModal({
  visible,
  options,
  selected,
  onSelect,
  onClose,
}: {
  visible:  boolean;
  options:  RangeOption[];
  selected: string;
  onSelect: (key: string) => void;
  onClose:  () => void;
}) {
  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
    >
      <Pressable style={styles.modalBackdrop} onPress={onClose}>
        <Pressable style={styles.modalSheet} onPress={(e) => e.stopPropagation()}>
          <Text style={styles.modalTitle}>範囲を選択</Text>
          <FlatList
            data={options}
            keyExtractor={(o) => o.key}
            renderItem={({ item }) => (
              <TouchableOpacity
                style={[
                  styles.modalItem,
                  item.key === selected && styles.modalItemSelected,
                ]}
                onPress={() => onSelect(item.key)}
              >
                <Text
                  style={[
                    styles.modalItemText,
                    item.key === selected && styles.modalItemTextSelected,
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
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff' },
  center:    { flex: 1, backgroundColor: '#fff', alignItems: 'center', justifyContent: 'center' },
  empty:     { textAlign: 'center', color: '#888', marginTop: 24 },

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

  summaryTotal:   { fontSize: 22, fontWeight: 'bold', color: '#2563eb', marginBottom: 12 },
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
  entryExcluded: { backgroundColor: '#fafafa' },
  entryHeader:   { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  entryDate:     { fontSize: 12, color: '#666' },
  entryAmount:   { fontSize: 16, fontWeight: 'bold' },
  entryStore:    { fontSize: 15, marginTop: 2 },
  entryMeta:     { fontSize: 12, color: '#888', marginTop: 2 },
  entryMemo:     { fontSize: 12, color: '#666', marginTop: 2 },
  struck:        { textDecorationLine: 'line-through', color: '#999' },

  controls: {
    flexDirection: 'row',
    alignItems:    'center',
    flexWrap:      'wrap',
    gap:           12,
    marginTop:     8,
  },
  checkbox:      { flexDirection: 'row', alignItems: 'center', gap: 6 },
  checkboxLabel: { fontSize: 13 },
  box: {
    width:        18,
    height:       18,
    borderWidth:  1,
    borderColor:  '#888',
    borderRadius: 3,
    alignItems:   'center',
    justifyContent: 'center',
  },
  boxChecked: { backgroundColor: '#2563eb', borderColor: '#2563eb' },
  boxMark:    { color: '#fff', fontSize: 12, lineHeight: 14 },

  partialInput: {
    borderWidth: 1,
    borderColor: '#ccc',
    borderRadius: 4,
    paddingHorizontal: 8,
    paddingVertical: 4,
    fontSize: 14,
    minWidth: 80,
    textAlign: 'right',
  },

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
  modalTitle: {
    fontSize: 16,
    fontWeight: 'bold',
    paddingHorizontal: 16,
    paddingBottom: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#eee',
  },
  modalItem: {
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  modalItemSelected: { backgroundColor: '#eaf2ff' },
  modalItemText: { fontSize: 15, color: '#222' },
  modalItemTextSelected: { color: '#2563eb', fontWeight: 'bold' },

  editBtn: {
    paddingHorizontal: 12,
    paddingVertical:   4,
    borderWidth:       1,
    borderColor:       '#2563eb',
    borderRadius:      4,
  },
  editBtnText: { fontSize: 13, color: '#2563eb' },

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

  editForm: { padding: 16 },
  fieldBox:   { marginBottom: 12 },
  fieldLabel: { fontSize: 12, color: '#666', marginBottom: 4 },
  fieldInput: {
    borderWidth: 1,
    borderColor: '#ccc',
    borderRadius: 6,
    paddingHorizontal: 12,
    paddingVertical: 8,
    fontSize: 15,
  },
  fieldInputMulti: { minHeight: 80, textAlignVertical: 'top' },
  editNote: { fontSize: 11, color: '#888', marginTop: 12 },
});
