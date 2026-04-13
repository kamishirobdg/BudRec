import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
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
  markRowDeleted,
  updateRow,
  updateRowFlags,
  updateRecurringFlag,
} from '../services/SheetsService';
import * as CategoryService from '../services/CategoryService';
import { getCurrentUser } from '../services/UserService';
import { detectDuplicateWarnings } from '../services/DuplicateDetector';
import { useGmailProgress } from '../services/GmailProgressService';
import { SortKey, getSortKey, setSortKey } from '../services/PreferencesService';
import SettingsScreen from './SettingsScreen';
import PersonalModal from './PersonalModal';
import MemoText from './MemoText';

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
  const [personalOpen, setPersonalOpen] = useState(false);
  const [editTarget, setEditTarget]     = useState<ExpenseRow | null>(null);
  const [sortKey, setSortKeyState]      = useState<SortKey>('timestamp');
  const [sortPickerOpen, setSortPickerOpen] = useState(false);
  const gmailProgress                    = useGmailProgress();

  // ソートキーを Storage から復元
  useEffect(() => {
    getSortKey().then(setSortKeyState);
  }, []);

  const changeSort = (k: SortKey) => {
    setSortKeyState(k);
    setSortPickerOpen(false);
    setSortKey(k);
  };

  // ヘッダー右に「個人」「設定」ボタンを置く
  useLayoutEffect(() => {
    navigation.setOptions({
      headerRight: () => (
        <View style={{ flexDirection: 'row', alignItems: 'center', paddingRight: 8 }}>
          <TouchableOpacity
            onPress={() => setPersonalOpen(true)}
            style={{ paddingHorizontal: 12, paddingVertical: 4 }}
          >
            <Text style={{ fontSize: 14, color: '#2563eb', fontWeight: 'bold' }}>個人</Text>
          </TouchableOpacity>
          <TouchableOpacity
            onPress={() => setSettingsOpen(true)}
            style={{ paddingHorizontal: 8, paddingVertical: 4 }}
          >
            <Text style={{ fontSize: 20 }}>⚙</Text>
          </TouchableOpacity>
        </View>
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

  // Gmail 取り込みが完了して imported > 0 なら一覧を再取得
  const lastGmailFinishedRef = useRef(false);
  useEffect(() => {
    if (gmailProgress.finished && !lastGmailFinishedRef.current) {
      lastGmailFinishedRef.current = true;
      if ((gmailProgress.result?.imported ?? 0) > 0) {
        loadRows(currentRange);
      }
    } else if (!gmailProgress.finished) {
      lastGmailFinishedRef.current = false;
    }
  }, [gmailProgress.finished, gmailProgress.result, loadRows, currentRange]);

  const handleRefresh = async () => {
    setRefreshing(true);
    await Promise.all([buildRangeOptions(), loadRows(currentRange)]);
    setRefreshing(false);
  };

  /** 行をローカルで更新しつつスプレッドシートにも反映 */
  const persistRow = async (
    row: ExpenseRow,
    next: { countedAmount: number; excluded: boolean; confirmed: boolean },
  ) => {
    if (row.rowIndex === undefined || !row.sheetName) return;
    setRows((prev) =>
      prev.map((r) =>
        r.sheetName === row.sheetName && r.rowIndex === row.rowIndex
          ? { ...r, ...next }
          : r,
      ),
    );
    try {
      await updateRowFlags(row.sheetName, row.rowIndex, next);
    } catch (e) {
      Alert.alert('更新失敗', e instanceof Error ? e.message : String(e));
      loadRows(currentRange);
    }
  };

  const toggleExcluded = (row: ExpenseRow) => {
    persistRow(row, {
      countedAmount: row.countedAmount,
      excluded:      !row.excluded,
      confirmed:     row.confirmed,
    });
  };

  const togglePartial = (row: ExpenseRow) => {
    const isPartial = row.countedAmount !== row.amount;
    persistRow(row, {
      countedAmount: isPartial ? row.amount : defaultPartial,
      excluded:      row.excluded,
      confirmed:     row.confirmed,
    });
  };

  const toggleConfirmed = (row: ExpenseRow) => {
    persistRow(row, {
      countedAmount: row.countedAmount,
      excluded:      row.excluded,
      confirmed:     !row.confirmed,
    });
  };

  const toggleRecurring = async (row: ExpenseRow) => {
    if (row.rowIndex === undefined || !row.sheetName) return;
    const next = !row.recurring;
    setRows((prev) =>
      prev.map((r) =>
        r.sheetName === row.sheetName && r.rowIndex === row.rowIndex
          ? { ...r, recurring: next }
          : r,
      ),
    );
    try {
      await updateRecurringFlag(row.sheetName, row.rowIndex, next);
    } catch (e) {
      Alert.alert('更新失敗', e instanceof Error ? e.message : String(e));
      loadRows(currentRange);
    }
  };

  const commitPartialAmount = (row: ExpenseRow, text: string) => {
    const n = Number(text.replace(/[^\d]/g, ''));
    if (!Number.isFinite(n) || n <= 0) return;
    persistRow(row, { countedAmount: n, excluded: row.excluded, confirmed: row.confirmed });
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
  const myRows = useMemo(() => {
    const filtered = rows.filter((r) => r.user === currentUser);
    const sorted = [...filtered];
    if (sortKey === 'timestamp') {
      sorted.sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1));
    } else if (sortKey === 'amount') {
      sorted.sort((a, b) => b.amount - a.amount);
    } else if (sortKey === 'category') {
      sorted.sort((a, b) => (a.category || '').localeCompare(b.category || ''));
    }
    return sorted;
  }, [rows, currentUser, sortKey]);

  // 重複判定は全ユーザーの行を対象にする（夫婦間で同じ買い物を二人とも記録した
  // ケースも検出するため）。表示は myRows だが、key で照合するので問題ない。
  const warningKeys = useMemo(() => detectDuplicateWarnings(rows), [rows]);

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
        <Text style={[styles.rangeLabel, { marginLeft: 8 }]}>並び</Text>
        <TouchableOpacity
          style={styles.rangeButton}
          onPress={() => setSortPickerOpen(true)}
        >
          <Text style={styles.rangeButtonText}>{sortLabel(sortKey)} ▾</Text>
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
    const isWarned = warningKeys.has(key);

    return (
      <View style={[styles.entry, item.excluded && styles.entryExcluded, isWarned && styles.entryWarned]}>
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
            <MemoText
              memo={item.memo}
              style={[styles.entryMemo, struck]}
              numberOfLines={isExpanded ? undefined : 2}
            />
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
          {isWarned && (
            <Checkbox
              label="確認済み"
              checked={item.confirmed}
              onPress={() => toggleConfirmed(item)}
            />
          )}
          <Checkbox
            label="固定費"
            checked={item.recurring}
            onPress={() => toggleRecurring(item)}
          />
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

  const handleDeleteEdit = (target: ExpenseRow) => {
    if (!target.sheetName || target.rowIndex === undefined) return;
    Alert.alert(
      '本当に削除しますか？',
      'この明細を削除します。アプリ上からは復活できません。',
      [
        { text: 'キャンセル', style: 'cancel' },
        {
          text: '削除',
          style: 'destructive',
          onPress: async () => {
            try {
              await markRowDeleted(target.sheetName!, target.rowIndex!);
              setRows((prev) =>
                prev.filter(
                  (r) =>
                    !(r.sheetName === target.sheetName && r.rowIndex === target.rowIndex),
                ),
              );
              setEditTarget(null);
            } catch (e) {
              Alert.alert('削除失敗', e instanceof Error ? e.message : String(e));
            }
          },
        },
      ],
    );
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
      {(gmailProgress.running || gmailProgress.finished) && (
        <View
          style={[
            styles.gmailBanner,
            gmailProgress.finished && !gmailProgress.running && styles.gmailBannerDone,
          ]}
        >
          {gmailProgress.running && <ActivityIndicator color="#fff" size="small" />}
          <Text style={styles.gmailBannerText}>
            {gmailProgress.running
              ? gmailProgress.total > 0
                ? `Gmail 取り込み中 ${gmailProgress.current}/${gmailProgress.total}`
                : `Gmail ${gmailProgress.phase}`
              : gmailProgress.result
                ? `Gmail 取り込み完了: 取込 ${gmailProgress.result.imported} / スキップ ${gmailProgress.result.skipped} / 失敗 ${gmailProgress.result.failed}`
                : `Gmail ${gmailProgress.phase}`}
          </Text>
        </View>
      )}

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

      <SortPickerModal
        visible={sortPickerOpen}
        selected={sortKey}
        onSelect={changeSort}
        onClose={() => setSortPickerOpen(false)}
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
        onDelete={handleDeleteEdit}
      />

      <PersonalModal
        visible={personalOpen}
        onClose={() => setPersonalOpen(false)}
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

const ADD_CATEGORY_SENTINEL = '__add_category__';

function EditEntryModal({
  target,
  onClose,
  onSave,
  onDelete,
}: {
  target:   ExpenseRow | null;
  onClose:  () => void;
  onSave:   (updated: ExpenseRow) => void;
  onDelete: (target: ExpenseRow) => void;
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

  const [categories, setCategories]       = useState<string[]>([]);
  const [categoryPickerOpen, setCategoryPickerOpen] = useState(false);
  const [addCategoryOpen, setAddCategoryOpen]       = useState(false);
  const [newCategoryText, setNewCategoryText]       = useState('');
  const [savingCategory, setSavingCategory]         = useState(false);

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
    // カテゴリ一覧を取得（キャッシュがあれば即座に返る）
    CategoryService.getCategories()
      .then(setCategories)
      .catch(() => setCategories([]));
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

  const handlePickCategory = (value: string) => {
    if (value === ADD_CATEGORY_SENTINEL) {
      setCategoryPickerOpen(false);
      setNewCategoryText('');
      setAddCategoryOpen(true);
      return;
    }
    setCategory(value);
    setCategoryPickerOpen(false);
  };

  const handleAddCategoryConfirm = async () => {
    const name = newCategoryText.trim();
    if (!name) {
      Alert.alert('入力エラー', 'カテゴリ名が空です');
      return;
    }
    setSavingCategory(true);
    try {
      await CategoryService.addCategory(name);
      const next = await CategoryService.getCategories();
      setCategories(next);
      setCategory(name);
      setAddCategoryOpen(false);
    } catch (e) {
      Alert.alert('追加失敗', e instanceof Error ? e.message : String(e));
    } finally {
      setSavingCategory(false);
    }
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

          {/* カテゴリはプルダウン選択 */}
          <View style={styles.fieldBox}>
            <Text style={styles.fieldLabel}>カテゴリ</Text>
            <TouchableOpacity
              style={styles.pickerButton}
              onPress={() => setCategoryPickerOpen(true)}
            >
              <Text style={styles.pickerButtonText}>
                {category || '(未選択)'} ▾
              </Text>
            </TouchableOpacity>
          </View>

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

          <View style={{ height: 24 }} />
          <TouchableOpacity
            style={styles.deleteBtn}
            onPress={() => onDelete(target)}
          >
            <Text style={styles.deleteBtnText}>この明細を削除</Text>
          </TouchableOpacity>

          <Text style={styles.editNote}>
            ※ 日時の月を変更しても行は元のシート（{target.sheetName}）のまま残ります
          </Text>
        </ScrollView>
      </SafeAreaView>

      {/* カテゴリ選択モーダル */}
      <Modal
        visible={categoryPickerOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setCategoryPickerOpen(false)}
      >
        <Pressable
          style={styles.modalBackdrop}
          onPress={() => setCategoryPickerOpen(false)}
        >
          <Pressable style={styles.modalSheet} onPress={(e) => e.stopPropagation()}>
            <Text style={styles.modalTitle}>カテゴリを選択</Text>
            <FlatList
              data={[...categories, ADD_CATEGORY_SENTINEL]}
              keyExtractor={(c) => c}
              renderItem={({ item }) => {
                const isAdd = item === ADD_CATEGORY_SENTINEL;
                const isSelected = !isAdd && item === category;
                return (
                  <TouchableOpacity
                    style={[
                      styles.modalItem,
                      isSelected && styles.modalItemSelected,
                    ]}
                    onPress={() => handlePickCategory(item)}
                  >
                    <Text
                      style={[
                        styles.modalItemText,
                        isSelected && styles.modalItemTextSelected,
                        isAdd && styles.modalItemTextAdd,
                      ]}
                    >
                      {isAdd ? '＋ カテゴリを追加...' : item}
                    </Text>
                  </TouchableOpacity>
                );
              }}
            />
          </Pressable>
        </Pressable>
      </Modal>

      {/* カテゴリ追加モーダル */}
      <Modal
        visible={addCategoryOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setAddCategoryOpen(false)}
      >
        <Pressable
          style={styles.modalBackdrop}
          onPress={() => !savingCategory && setAddCategoryOpen(false)}
        >
          <Pressable style={styles.modalSheet} onPress={(e) => e.stopPropagation()}>
            <Text style={styles.modalTitle}>カテゴリを追加</Text>
            <View style={{ padding: 16 }}>
              <TextInput
                style={styles.fieldInput}
                value={newCategoryText}
                onChangeText={setNewCategoryText}
                placeholder="例: 趣味"
                autoFocus
                editable={!savingCategory}
              />
              <View style={{ height: 12 }} />
              <View style={{ flexDirection: 'row', justifyContent: 'flex-end', gap: 8 }}>
                <Button
                  title="キャンセル"
                  onPress={() => setAddCategoryOpen(false)}
                  disabled={savingCategory}
                />
                <Button
                  title={savingCategory ? '追加中...' : '追加'}
                  onPress={handleAddCategoryConfirm}
                  disabled={savingCategory}
                />
              </View>
            </View>
          </Pressable>
        </Pressable>
      </Modal>
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

function sortLabel(k: SortKey): string {
  if (k === 'timestamp') return '日時';
  if (k === 'amount') return '金額';
  return 'カテゴリ';
}

function SortPickerModal({
  visible,
  selected,
  onSelect,
  onClose,
}: {
  visible:  boolean;
  selected: SortKey;
  onSelect: (key: SortKey) => void;
  onClose:  () => void;
}) {
  const items: SortKey[] = ['timestamp', 'amount', 'category'];
  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
    >
      <Pressable style={styles.modalBackdrop} onPress={onClose}>
        <Pressable style={styles.modalSheet} onPress={(e) => e.stopPropagation()}>
          <Text style={styles.modalTitle}>並び順を選択</Text>
          {items.map((k) => (
            <TouchableOpacity
              key={k}
              style={[
                styles.modalItem,
                k === selected && styles.modalItemSelected,
              ]}
              onPress={() => onSelect(k)}
            >
              <Text
                style={[
                  styles.modalItemText,
                  k === selected && styles.modalItemTextSelected,
                ]}
              >
                {sortLabel(k)}
              </Text>
            </TouchableOpacity>
          ))}
        </Pressable>
      </Pressable>
    </Modal>
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
  entryWarned:   { backgroundColor: '#ffedd5' },
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

  pickerButton: {
    borderWidth: 1,
    borderColor: '#ccc',
    borderRadius: 6,
    paddingHorizontal: 12,
    paddingVertical: 10,
    backgroundColor: '#fff',
  },
  pickerButtonText: { fontSize: 15, color: '#222' },

  modalItemTextAdd: { color: '#2563eb', fontWeight: 'bold' },

  deleteBtn: {
    borderWidth: 1,
    borderColor: '#dc2626',
    borderRadius: 6,
    paddingVertical: 10,
    alignItems: 'center',
    backgroundColor: '#fff',
  },
  deleteBtnText: { fontSize: 15, color: '#dc2626', fontWeight: 'bold' },

  gmailBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: '#2563eb',
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  gmailBannerDone: { backgroundColor: '#16a34a' },
  gmailBannerText: { color: '#fff', fontSize: 13, fontWeight: 'bold', flexShrink: 1 },
});
