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
  getRows,
  getRowsForRange,
  getSheetNameFromDate,
  listAvailableYears,
  listMonthSheetNames,
  markRowDeleted,
  updateRow,
  updateRowFlags,
  updateRecurringFlag,
  applyRecurringEntries,
  flushWriteQueue,
} from '../services/SheetsService';
import { QueuedWriteError, useWriteQueue } from '../services/WriteQueueService';
import * as CategoryService from '../services/CategoryService';
import { getCurrentUser } from '../services/UserService';
import { detectDuplicateWarnings } from '../services/DuplicateDetector';
import { useGmailProgress } from '../services/GmailProgressService';
import {
  SortKey,
  getSortKey,
  setSortKey,
  getRecurringAppliedMonth,
  setRecurringAppliedMonth,
} from '../services/PreferencesService';
import { AuthError } from '../services/AuthService';
import * as Demo from '../services/DemoService';
import * as LastBatch from '../services/LastBatchService';
import SettingsScreen from './SettingsScreen';
import PersonalModal from './PersonalModal';
import ReceiptReviewModal from './ReceiptReviewModal';
import MemoText from './MemoText';

// ─── UI helpers ──────────────────────────────────────────────────────────────

/** 編集前後で実質同じ行か（触られていない行を書き戻さないため） */
function isSameEntry(a: ExpenseRow, b: ExpenseRow): boolean {
  return a.timestamp === b.timestamp
    && a.store === b.store
    && a.category === b.category
    && a.amount === b.amount
    && a.memo === b.memo
    && a.countedAmount === b.countedAmount;
}

function sourceLabel(s: string): string {
  if (s === 'camera' || s === 'proxy_camera') return 'カメラ';
  if (s === 'gmail')    return 'Gmail';
  if (s === 'manual' || s === 'proxy_manual') return '手入力';
  if (s === 'suica')    return 'Suica';
  if (s === 'recurring') return '固定費';
  return s;
}

function sourceBadgeColors(s: string): [string, string] {
  if (s === 'gmail')    return ['#fce4ec', '#c62828'];
  if (s === 'manual' || s === 'proxy_manual') return ['#f3e5f5', '#6a1b9a'];
  if (s === 'recurring') return ['#e8f5e9', '#2e7d32'];
  return ['#e3f2fd', '#1565c0'];
}

function formatTimestamp(ts: string): string {
  const m = ts.match(/\d{4}[\/\-](\d{2})[\/\-](\d{2})\s+(\d{2}:\d{2})/);
  return m ? `${m[1]}/${m[2]} ${m[3]}` : ts;
}

// ─────────────────────────────────────────────────────────────────────────────

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
  const [catView, setCatView]           = useState<'total' | 'byUser'>('total');
  const [demoMode, setDemoMode]         = useState(Demo.isDemoSync);
  // カテゴリ別カードで選択中のカテゴリ（表示名。null なら絞り込みなし）
  const [catFilter, setCatFilter]       = useState<string | null>(null);
  const gmailProgress                    = useGmailProgress();
  // 送れずに端末へ退避した書き込み（バナーに件数を出す）
  const queuedWrites                     = useWriteQueue();
  const [flushing, setFlushing]          = useState(false);
  // 「前回の登録」で開く確認・編集モーダル
  const [lastBatchRows, setLastBatchRows] = useState<ExpenseRow[] | null>(null);
  const [lastBatchBusy, setLastBatchBusy] = useState(false);

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
    let months: string[], years: string[];
    try {
      [months, years] = await Promise.all([listMonthSheetNames(), listAvailableYears()]);
    } catch (e) {
      if (e instanceof AuthError) { onSignedOut(); return; }
      return; // 取得失敗時はデフォルト表示のまま
    }
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
      const [list, partial, user, demo] = await Promise.all([
        getRowsForRange(range),
        getDefaultPartialAmount(),
        getCurrentUser(),
        Demo.isDemo(),
      ]);
      setRows(list);
      setDefaultPartial(partial);
      setCurrentUserState(user);
      setDemoMode(demo);
    } catch (e) {
      if (e instanceof AuthError) { onSignedOut(); return; }
      Alert.alert('読み込み失敗', e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [onSignedOut]);

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

  /** 設定を閉じる。デモモードの ON/OFF を即座に反映するため再読み込みする */
  const closeSettings = () => {
    setSettingsOpen(false);
    loadRows(currentRange);
  };

  const handleRefresh = async () => {
    setRefreshing(true);
    await Promise.all([buildRangeOptions(), loadRows(currentRange)]);
    setRefreshing(false);
  };

  /** 未送信バナーのタップ: 溜まっている書き込みを今すぐ送る */
  const handleFlushQueue = async () => {
    if (flushing) return;
    setFlushing(true);
    try {
      const { remaining } = await flushWriteQueue();
      if (remaining > 0) {
        Alert.alert(
          'まだ送信できません',
          `${remaining} 件が未送信のままです。通信状況を確認してから、もう一度お試しください。`,
        );
      }
    } catch (e) {
      if (e instanceof AuthError) { onSignedOut(); return; }
      Alert.alert('送信失敗', e instanceof Error ? e.message : String(e));
    } finally {
      setFlushing(false);
    }
  };

  /**
   * 「前回の登録」: この端末から最後に入れた行をシートから探して確認・編集モーダルで開く。
   * 表示中の期間とは関係なく、登録した月のシートを直接読む。
   */
  const handleOpenLastBatch = async () => {
    if (lastBatchBusy) return;
    const keys = LastBatch.getLastBatch();
    if (keys.length === 0) {
      Alert.alert('前回の登録', 'この端末から登録した記録がまだありません。');
      return;
    }

    setLastBatchBusy(true);
    try {
      const sheets = [...new Set(keys.map((k) => k.sheetName))];
      const lists  = await Promise.all(sheets.map((s) => getRows(s)));
      const found  = LastBatch.pickBatchRows(lists.flat(), keys);
      if (found.length === 0) {
        Alert.alert('前回の登録', '該当する明細が見つかりませんでした。削除されたか、内容が変更された可能性があります。');
        return;
      }
      setLastBatchRows(found);
    } catch (e) {
      if (e instanceof AuthError) { onSignedOut(); return; }
      Alert.alert('読み込み失敗', e instanceof Error ? e.message : String(e));
    } finally {
      setLastBatchBusy(false);
    }
  };

  /** 「前回の登録」モーダルの保存。触られた行だけ書き戻す */
  const handleLastBatchCommit = async (kept: ExpenseRow[], removed: ExpenseRow[]) => {
    setLastBatchBusy(true);
    let changed = 0;

    try {
      for (const row of kept) {
        if (!row.sheetName || row.rowIndex === undefined) continue;
        const before = lastBatchRows?.find(
          (r) => r.sheetName === row.sheetName && r.rowIndex === row.rowIndex,
        );
        if (before && isSameEntry(before, row)) continue; // 触っていない行は送らない
        try {
          await updateRow(row.sheetName, row.rowIndex, row);
          changed++;
        } catch (e) {
          if (!(e instanceof QueuedWriteError)) throw e;
          changed++; // 端末に退避済み。未送信バナーで気づける
        }
      }

      for (const row of removed) {
        if (!row.sheetName || row.rowIndex === undefined) continue;
        try {
          await markRowDeleted(row.sheetName, row.rowIndex);
          changed++;
        } catch (e) {
          if (!(e instanceof QueuedWriteError)) throw e;
          changed++;
        }
      }

      // 次に開いたときも同じ行を引けるよう、編集後の内容でキーを取り直す
      if (kept.length > 0) LastBatch.saveLastBatch(kept);

      setLastBatchRows(null);
      if (changed > 0) loadRows(currentRange);
    } catch (e) {
      if (e instanceof AuthError) { onSignedOut(); return; }
      Alert.alert('保存失敗', e instanceof Error ? e.message : String(e));
    } finally {
      setLastBatchBusy(false);
    }
  };

  // 未送信が片付いたら一覧を取り直す（追加行の行番号はサーバー側で決まるため）。
  // App 側の自動送信で片付いた場合もここで拾える
  const prevQueueCount = useRef(queuedWrites.length);
  useEffect(() => {
    const prev = prevQueueCount.current;
    prevQueueCount.current = queuedWrites.length;
    if (prev > 0 && queuedWrites.length === 0) loadRows(currentRange);
  }, [queuedWrites.length, loadRows, currentRange]);

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
      if (e instanceof AuthError) { onSignedOut(); return; }
      // 端末に退避できた変更は巻き戻さない（未送信バナーで気づける）
      if (e instanceof QueuedWriteError) return;
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
      if (e instanceof AuthError) { onSignedOut(); return; }
      if (e instanceof QueuedWriteError) return;
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

  // ─── 固定費: 月初に未適用なら自動コピー ─────────────────────────────────────
  const checkAndApplyRecurring = useCallback(async () => {
    const currentMonth = getSheetNameFromDate();
    try {
      // デモ中は実行しない。適用済みフラグも立てない（デモ解除後に改めて走らせる）
      if (await Demo.isDemo()) return;
      const applied = await getRecurringAppliedMonth();
      if (applied === currentMonth) return;
      const count = await applyRecurringEntries();
      await setRecurringAppliedMonth(currentMonth);
      if (count > 0) loadRows(currentRange);
    } catch (e) {
      if (e instanceof AuthError) onSignedOut();
    }
  }, [currentRange, loadRows, onSignedOut]);

  useEffect(() => {
    checkAndApplyRecurring();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // 起動時1回のみ

  // ─── 集計対象（自分の行 ＋ 自分が代理入力した行） ───
  const myRows = useMemo(() => {
    const isProxyEntry = (r: ExpenseRow) =>
      (r.source === 'proxy_camera' || r.source === 'proxy_manual') && r.user !== currentUser;
    const filtered = rows.filter((r) => r.user === currentUser || isProxyEntry(r));
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

  /** カテゴリ表示名（空カテゴリは '未設定' に寄せる。絞り込みの照合キー） */
  const catLabel = (c: string) => c || '未設定';

  // カテゴリ別カードで選択中のカテゴリだけに絞った明細
  const visibleRows = useMemo(
    () => (catFilter === null ? myRows : myRows.filter((r) => catLabel(r.category) === catFilter)),
    [myRows, catFilter],
  );

  const toggleCatFilter = (label: string) => {
    setCatFilter((prev) => (prev === label ? null : label));
  };

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

  // カテゴリ×ユーザー別集計（全ユーザー対象）
  const summaryByUserCat = useMemo(() => {
    const byCatUser = new Map<string, Map<string, number>>();
    for (const r of rows) {
      if (r.excluded) continue;
      const cat = r.category || '未設定';
      if (!byCatUser.has(cat)) byCatUser.set(cat, new Map());
      const um = byCatUser.get(cat)!;
      um.set(r.user, (um.get(r.user) ?? 0) + r.countedAmount);
    }
    return [...byCatUser.entries()]
      .map(([cat, um]) => ({
        cat,
        total: [...um.values()].reduce((a, b) => a + b, 0),
        users: [...um.entries()].sort((a, b) => b[1] - a[1]),
      }))
      .sort((a, b) => b.total - a.total);
  }, [rows]);

  const renderHeader = () => {
    const maxCat = summary.categories[0]?.[1] ?? 1;
    return (
      <View>
        {/* コントロール行 */}
        <View style={styles.rangeRow}>
          <Text style={styles.rangeLabel}>期間</Text>
          <TouchableOpacity style={styles.rangeButton} onPress={() => setPickerOpen(true)}>
            <Text style={styles.rangeButtonText}>{currentRangeLabel} ▾</Text>
          </TouchableOpacity>
          <Text style={[styles.rangeLabel, { marginLeft: 8 }]}>並び</Text>
          <TouchableOpacity style={styles.rangeButton} onPress={() => setSortPickerOpen(true)}>
            <Text style={styles.rangeButtonText}>{sortLabel(sortKey)} ▾</Text>
          </TouchableOpacity>
        </View>

        {/* 合計カード */}
        <View style={styles.totalCard}>
          {demoMode && (
            <View style={styles.demoPill}>
              <Text style={styles.demoPillText}>DEMO</Text>
            </View>
          )}
          <Text style={styles.totalCardLabel}>{currentRangeLabel}の支出合計</Text>
          <Text style={styles.totalCardAmount}>¥{summary.total.toLocaleString()}</Text>
          {summary.users.length > 0 && (
            <View style={styles.userPills}>
              {summary.users.map(([u, v]) => (
                <View key={u} style={styles.userPill}>
                  <Text style={styles.userPillName}>{u || '未設定'}</Text>
                  <Text style={styles.userPillAmount}>¥{v.toLocaleString()}</Text>
                </View>
              ))}
            </View>
          )}
        </View>

        {/* カテゴリ別 */}
        {summary.categories.length > 0 && (
          <View style={styles.catCard}>
            {/* ヘッダー行: タイトル + 人別トグル */}
            <View style={styles.catCardHeaderRow}>
              <Text style={styles.catCardTitle}>カテゴリ別</Text>
              <TouchableOpacity
                style={[styles.catViewToggle, catView === 'byUser' && styles.catViewToggleActive]}
                onPress={() => setCatView((v) => v === 'total' ? 'byUser' : 'total')}
              >
                <Text style={[styles.catViewToggleText, catView === 'byUser' && styles.catViewToggleTextActive]}>
                  人別
                </Text>
              </TouchableOpacity>
            </View>

            {catView === 'total' ? (
              /* ── 合計ビュー ── */
              summary.categories.map(([c, v]) => {
                const label = catLabel(c);
                const selected = catFilter === label;
                return (
                  <TouchableOpacity
                    key={c}
                    style={[styles.catRow, selected && styles.catRowSelected]}
                    onPress={() => toggleCatFilter(label)}
                    activeOpacity={0.6}
                  >
                    <View style={styles.catRowLeft}>
                      <Text style={[styles.catName, selected && styles.catNameSelected]}>
                        {label}
                      </Text>
                      <View style={styles.catBarBg}>
                        <View style={[styles.catBarFill, { width: `${Math.min(100, Math.round((v / maxCat) * 100))}%` as any }]} />
                      </View>
                    </View>
                    <Text style={[styles.catAmount, selected && styles.catNameSelected]}>
                      ¥{v.toLocaleString()}
                    </Text>
                  </TouchableOpacity>
                );
              })
            ) : (
              /* ── 人別ビュー ── */
              summaryByUserCat.map(({ cat, total, users }) => {
                const maxUser = users[0]?.[1] ?? 1;
                const selected = catFilter === cat;
                return (
                  <View key={cat} style={[styles.catUserGroup, selected && styles.catRowSelected]}>
                    <TouchableOpacity
                      style={styles.catUserGroupHeader}
                      onPress={() => toggleCatFilter(cat)}
                      activeOpacity={0.6}
                    >
                      <Text style={[styles.catUserGroupName, selected && styles.catNameSelected]}>
                        {cat}
                      </Text>
                      <Text style={[styles.catAmount, selected && styles.catNameSelected]}>
                        ¥{total.toLocaleString()}
                      </Text>
                    </TouchableOpacity>
                    {users.map(([user, amt]) => (
                      <View key={user} style={styles.catUserRow}>
                        <Text style={styles.catUserName}>{user}</Text>
                        <View style={styles.catBarBg}>
                          <View style={[styles.catUserBar, { width: `${Math.round((amt / maxUser) * 100)}%` as any }]} />
                        </View>
                        <Text style={styles.catUserAmt}>¥{amt.toLocaleString()}</Text>
                      </View>
                    ))}
                  </View>
                );
              })
            )}
          </View>
        )}

        {/* 明細セクションヘッダー */}
        <View style={styles.detailsHeader}>
          <Text style={styles.detailsHeaderText}>
            明細 — <Text style={styles.detailsHeaderUser}>{currentUser || '自分'}</Text>
          </Text>
          <View style={styles.detailsHeaderRight}>
            {catFilter !== null && (
              <TouchableOpacity
                style={styles.filterChip}
                onPress={() => setCatFilter(null)}
                activeOpacity={0.7}
              >
                <Text style={styles.filterChipText}>{catFilter} ✕</Text>
              </TouchableOpacity>
            )}
            {/* デモ中は実データを触らせない */}
            {!demoMode && (
              <TouchableOpacity
                style={styles.lastBatchBtn}
                onPress={handleOpenLastBatch}
                disabled={lastBatchBusy}
                activeOpacity={0.7}
              >
                <Text style={styles.lastBatchBtnText}>前回の登録</Text>
              </TouchableOpacity>
            )}
          </View>
        </View>
      </View>
    );
  };

  const renderItem = ({ item }: { item: ExpenseRow }) => {
    const isPartial = item.countedAmount !== item.amount;
    const struck = item.excluded ? styles.struck : undefined;
    const key = `${item.sheetName ?? ''}:${item.rowIndex ?? ''}`;
    const isExpanded = expanded.has(key);
    const isWarned = warningKeys.has(key);
    const isProxy = item.source === 'proxy_camera' || item.source === 'proxy_manual';
    const [badgeBg, badgeColor] = sourceBadgeColors(item.source);

    return (
      <View style={[styles.entry, isProxy && styles.entryProxy, item.excluded && styles.entryExcluded, isWarned && styles.entryWarned]}>
        {/* 上段: 日時・バッジ + 金額 */}
        <View style={styles.entryTop}>
          <View style={styles.entryMetaRow}>
            <Text style={[styles.entryDate, struck]}>{formatTimestamp(item.timestamp)}</Text>
            <View style={[styles.sourceBadge, { backgroundColor: badgeBg }]}>
              <Text style={[styles.sourceBadgeText, { color: badgeColor }]}>{sourceLabel(item.source)}</Text>
            </View>
            {isProxy && (
              <View style={styles.proxyBadge}>
                <Text style={styles.proxyBadgeText}>{item.user}（代理）</Text>
              </View>
            )}
          </View>
          <Text style={[styles.entryAmount, struck]}>¥{item.amount.toLocaleString()}</Text>
        </View>

        {/* 店舗 / カテゴリ */}
        <Text style={[styles.entryStore, struck]}>
          {item.store || '(店舗無し)'} / {item.category}
        </Text>

        {/* ユーザー (代理でない場合) */}
        {!isProxy && <Text style={[styles.entryMeta, struck]}>{item.user}</Text>}

        {/* メモ */}
        {!!item.memo && (
          <TouchableOpacity onPress={() => toggleExpanded(key)} activeOpacity={0.6}>
            <MemoText memo={item.memo} style={[styles.entryMemo, struck]} numberOfLines={isExpanded ? undefined : 2} />
          </TouchableOpacity>
        )}

        {/* トグルチップ */}
        <View style={styles.controls}>
          <ToggleChip label="除外" activeLabel="除外中" checked={item.excluded} onPress={() => toggleExcluded(item)} activeColor="#ef4444" />
          <ToggleChip label="一部計上" checked={isPartial} onPress={() => togglePartial(item)} activeColor="#f59e0b" />
          {isPartial && (
            <PartialAmountInput value={item.countedAmount} onCommit={(t) => commitPartialAmount(item, t)} />
          )}
          {isWarned && (
            <ToggleChip label="確認済み" checked={item.confirmed} onPress={() => toggleConfirmed(item)} activeColor="#8b5cf6" />
          )}
          <ToggleChip label="固定費" checked={item.recurring} onPress={() => toggleRecurring(item)} activeColor="#3b82f6" />
          <TouchableOpacity style={styles.editBtn} onPress={() => setEditTarget(item)}>
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
    } catch (e) {
      if (e instanceof AuthError) { onSignedOut(); return; }
      // 端末に退避できたなら画面上は保存できたものとして扱う
      if (!(e instanceof QueuedWriteError)) {
        Alert.alert('保存失敗', e instanceof Error ? e.message : String(e));
        return;
      }
    }
    setRows((prev) =>
      prev.map((r) =>
        r.sheetName === updated.sheetName && r.rowIndex === updated.rowIndex
          ? updated
          : r,
      ),
    );
    setEditTarget(null);
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
            } catch (e) {
              if (e instanceof AuthError) { onSignedOut(); return; }
              if (!(e instanceof QueuedWriteError)) {
                Alert.alert('削除失敗', e instanceof Error ? e.message : String(e));
                return;
              }
            }
            setRows((prev) =>
              prev.filter(
                (r) =>
                  !(r.sheetName === target.sheetName && r.rowIndex === target.rowIndex),
              ),
            );
            setEditTarget(null);
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

      {/* デモ中は送信しないのでバナーも出さない（見せている画面に出すと紛らわしい） */}
      {!demoMode && queuedWrites.length > 0 && (
        <TouchableOpacity
          style={styles.queueBanner}
          onPress={handleFlushQueue}
          disabled={flushing}
        >
          {flushing && <ActivityIndicator color="#fff" size="small" />}
          <Text style={styles.queueBannerText}>
            {flushing
              ? '未送信の変更を送信中...'
              : `未送信の変更が ${queuedWrites.length} 件（この一覧には未反映・タップで送信）`}
          </Text>
        </TouchableOpacity>
      )}

      <FlatList
        data={visibleRows}
        keyExtractor={(r) => `${r.sheetName ?? ''}:${r.rowIndex ?? r.timestamp}`}
        renderItem={renderItem}
        ListHeaderComponent={renderHeader}
        ListEmptyComponent={
          <Text style={styles.empty}>
            {catFilter === null ? 'データがありません' : `${catFilter} の明細はありません`}
          </Text>
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
        onRequestClose={() => closeSettings()}
      >
        <SafeAreaView style={{ flex: 1, backgroundColor: '#fff' }}>
          <View style={styles.modalHeader}>
            <Text style={styles.modalHeaderTitle}>設定</Text>
            <Button title="閉じる" onPress={closeSettings} />
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

      {/* 直近に登録した明細をまとめて見直す */}
      <ReceiptReviewModal
        visible={lastBatchRows !== null}
        title="前回の登録"
        rows={lastBatchRows ?? []}
        mode="edit"
        busy={lastBatchBusy}
        onClose={() => setLastBatchRows(null)}
        onCommit={handleLastBatchCommit}
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

function ToggleChip({
  label,
  activeLabel,
  checked,
  onPress,
  activeColor = '#ef4444',
}: {
  label:        string;
  activeLabel?: string;
  checked:      boolean;
  onPress:      () => void;
  activeColor?: string;
}) {
  const r = parseInt(activeColor.slice(1, 3), 16);
  const g = parseInt(activeColor.slice(3, 5), 16);
  const b = parseInt(activeColor.slice(5, 7), 16);
  const bg = checked ? `rgba(${r},${g},${b},0.12)` : '#f5f5f5';
  const col = checked ? activeColor : '#888';
  return (
    <TouchableOpacity style={[styles.toggleChip, { backgroundColor: bg }]} onPress={onPress}>
      <View style={[styles.toggleDot, checked && { backgroundColor: col, borderColor: col }]} />
      <Text style={[styles.toggleChipText, { color: col }]}>
        {checked && activeLabel ? activeLabel : label}
      </Text>
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
          {/* 読み取り専用フィールド */}
          <View style={styles.readOnlyGroup}>
            <View style={styles.readOnlyRow}>
              <Text style={styles.readOnlyLabel}>取込元</Text>
              <View style={styles.readOnlyValueRow}>
                {(() => { const [bg, col] = sourceBadgeColors(source); return (
                  <View style={[styles.sourceBadge, { backgroundColor: bg }]}>
                    <Text style={[styles.sourceBadgeText, { color: col }]}>{sourceLabel(source)}</Text>
                  </View>
                ); })()}
                <Text style={styles.readOnlyNote}>変更不可</Text>
              </View>
            </View>
            <View style={[styles.readOnlyRow, { borderBottomWidth: 0 }]}>
              <Text style={styles.readOnlyLabel}>ユーザー</Text>
              <View style={styles.readOnlyValueRow}>
                <Text style={styles.readOnlyValue}>{user}</Text>
                <Text style={styles.readOnlyNote}>変更不可</Text>
              </View>
            </View>
          </View>
          <Field label="日時 (YYYY-MM-DD HH:MM)" value={timestamp} onChangeText={setTimestamp} />
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

          <View style={{ height: 8 }} />
          <TouchableOpacity style={styles.saveBtn} onPress={handleSave}>
            <Text style={styles.saveBtnText}>保存する</Text>
          </TouchableOpacity>

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
  // ─── レイアウト ───────────────────────────────────────────────────────────
  container: { flex: 1, backgroundColor: '#f2f4f7' },
  center:    { flex: 1, backgroundColor: '#f2f4f7', alignItems: 'center', justifyContent: 'center' },
  empty:     { textAlign: 'center', color: '#888', marginTop: 24, marginHorizontal: 16 },

  // ─── コントロール行 ───────────────────────────────────────────────────────
  rangeRow: {
    flexDirection: 'row',
    alignItems:    'center',
    gap:           8,
    paddingHorizontal: 16,
    paddingVertical:   12,
    backgroundColor:   '#fff',
    borderBottomWidth: 1,
    borderBottomColor: '#f0f0f0',
  },
  rangeLabel:      { fontSize: 13, color: '#666' },
  rangeButton: {
    paddingHorizontal: 12,
    paddingVertical:    5,
    backgroundColor:   '#f5f5f5',
    borderWidth:        1,
    borderColor:       '#e0e0e0',
    borderRadius:      20,
  },
  rangeButtonText: { fontSize: 13, color: '#333' },

  // ─── 合計カード ───────────────────────────────────────────────────────────
  totalCard: {
    margin: 16,
    marginBottom: 0,
    backgroundColor: '#2e7d32',
    borderRadius: 20,
    padding: 20,
  },
  demoPill: {
    position: 'absolute',
    top: 12,
    right: 12,
    backgroundColor: 'rgba(255,255,255,0.22)',
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  demoPillText: { fontSize: 10, fontWeight: '700', color: '#fff', letterSpacing: 1 },
  totalCardLabel:  { fontSize: 12, color: 'rgba(255,255,255,0.8)', marginBottom: 4 },
  totalCardAmount: { fontSize: 30, fontWeight: '700', color: '#fff', letterSpacing: -0.5, marginBottom: 16 },
  userPills:       { flexDirection: 'row', gap: 10 },
  userPill: {
    flex: 1,
    backgroundColor: 'rgba(255,255,255,0.2)',
    borderRadius: 12,
    padding: 10,
  },
  userPillName:   { fontSize: 12, color: 'rgba(255,255,255,0.85)', marginBottom: 2 },
  userPillAmount: { fontSize: 15, fontWeight: '700', color: '#fff' },

  // ─── カテゴリカード ───────────────────────────────────────────────────────
  catCard: {
    margin: 16,
    marginBottom: 0,
    backgroundColor: '#fff',
    borderRadius: 16,
    overflow: 'hidden',
  },
  catCardHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#f5f5f5',
  },
  catCardTitle: { fontSize: 14, fontWeight: '700', color: '#333' },
  catViewToggle: {
    paddingHorizontal: 12,
    paddingVertical: 4,
    borderRadius: 14,
    backgroundColor: '#f5f5f5',
    borderWidth: 1,
    borderColor: '#e0e0e0',
  },
  catViewToggleActive:     { backgroundColor: '#2e7d32', borderColor: '#2e7d32' },
  catViewToggleText:       { fontSize: 12, color: '#666', fontWeight: '600' },
  catViewToggleTextActive: { color: '#fff' },

  catRow:    { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 10, gap: 12 },
  catRowLeft: { flex: 1, gap: 4 },
  catRowSelected: { backgroundColor: '#e8f5e9' },
  catNameSelected: { color: '#2e7d32', fontWeight: '700' },
  catName:   { fontSize: 13, color: '#333' },
  catBarBg:  { height: 4, backgroundColor: '#f0f0f0', borderRadius: 2 },
  catBarFill: { height: 4, backgroundColor: '#2e7d32', borderRadius: 2 },
  catAmount: { fontSize: 14, fontWeight: '600', color: '#333' },

  // カテゴリ×人別
  catUserGroup:      { borderBottomWidth: 1, borderBottomColor: '#f5f5f5', paddingBottom: 8 },
  catUserGroupHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 16, paddingTop: 10, paddingBottom: 4 },
  catUserGroupName:  { fontSize: 13, fontWeight: '700', color: '#333' },
  catUserRow:  { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 4, gap: 8 },
  catUserName: { fontSize: 12, color: '#666', width: 64 },
  catUserBar:  { height: 4, backgroundColor: '#43a047', borderRadius: 2 },
  catUserAmt:  { fontSize: 12, fontWeight: '600', color: '#555' },

  // ─── 明細ヘッダー ─────────────────────────────────────────────────────────
  detailsHeader: {
    marginTop: 16,
    marginHorizontal: 16,
    paddingVertical: 12,
    paddingHorizontal: 16,
    backgroundColor: '#fff',
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#f0f0f0',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  detailsHeaderText: { fontSize: 14, fontWeight: '700', color: '#333' },
  detailsHeaderUser: { color: '#2e7d32' },
  detailsHeaderRight: { flexDirection: 'row', alignItems: 'center', gap: 8, flexShrink: 1 },
  lastBatchBtn: {
    borderWidth: 1,
    borderColor: '#2e7d32',
    borderRadius: 14,
    paddingHorizontal: 12,
    paddingVertical: 5,
  },
  lastBatchBtnText: { color: '#2e7d32', fontSize: 12, fontWeight: '600' },
  filterChip: {
    backgroundColor: '#e8f5e9',
    borderWidth: 1,
    borderColor: '#2e7d32',
    borderRadius: 14,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  filterChipText: { fontSize: 12, color: '#2e7d32', fontWeight: '600' },

  // ─── 明細カード ───────────────────────────────────────────────────────────
  entry: {
    paddingHorizontal: 16,
    paddingVertical:   14,
    backgroundColor:   '#fff',
    marginHorizontal:  16,
    borderBottomWidth: 1,
    borderBottomColor: '#f5f5f5',
  },
  entryExcluded: { backgroundColor: '#fafafa' },
  entryWarned:   { backgroundColor: '#fff7ed' },
  entryProxy:    { backgroundColor: '#f0fdf4' },

  entryTop:     { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 6 },
  entryMetaRow: { flexDirection: 'row', alignItems: 'center', gap: 5, flex: 1, flexWrap: 'wrap' },
  entryDate:    { fontSize: 12, color: '#999' },
  entryAmount:  { fontSize: 17, fontWeight: '700', color: '#1a1a1a' },
  entryStore:   { fontSize: 15, fontWeight: '600', color: '#1a1a1a', marginBottom: 2 },
  entryMeta:    { fontSize: 12, color: '#888', marginBottom: 4 },
  entryMemo:    { fontSize: 12, color: '#aaa', marginTop: 4 },
  struck:       { textDecorationLine: 'line-through', color: '#bbb' },

  // ─── バッジ ───────────────────────────────────────────────────────────────
  sourceBadge:     { paddingHorizontal: 7, paddingVertical: 2, borderRadius: 8 },
  sourceBadgeText: { fontSize: 10, fontWeight: '500' },
  proxyBadge:      { paddingHorizontal: 7, paddingVertical: 2, borderRadius: 8, backgroundColor: '#dcfce7' },
  proxyBadgeText:  { fontSize: 10, fontWeight: '500', color: '#166534' },

  // ─── トグルチップ ─────────────────────────────────────────────────────────
  controls: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 6, marginTop: 10 },
  toggleChip:     { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 10, paddingVertical: 5, borderRadius: 12 },
  toggleDot:      { width: 8, height: 8, borderRadius: 4, borderWidth: 1.5, borderColor: '#ccc' },
  toggleChipText: { fontSize: 11 },

  partialInput: {
    borderWidth: 1,
    borderColor: '#e0e0e0',
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 4,
    fontSize: 14,
    minWidth: 80,
    textAlign: 'right',
    backgroundColor: '#fff',
  },

  editBtn:     { marginLeft: 'auto' as any, paddingHorizontal: 14, paddingVertical: 5, backgroundColor: '#f5f5f5', borderRadius: 10 },
  editBtnText: { fontSize: 12, color: '#555', fontWeight: '600' },

  // ─── モーダル共通 ─────────────────────────────────────────────────────────
  modalBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'center', alignItems: 'center' },
  modalSheet:    { backgroundColor: '#fff', borderRadius: 16, width: '85%', maxHeight: '70%', paddingVertical: 12 },
  modalTitle: {
    fontSize: 16,
    fontWeight: 'bold',
    paddingHorizontal: 16,
    paddingBottom: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#eee',
  },
  modalItem:             { paddingHorizontal: 16, paddingVertical: 12 },
  modalItemSelected:     { backgroundColor: '#e8f5e9' },
  modalItemText:         { fontSize: 15, color: '#222' },
  modalItemTextSelected: { color: '#2e7d32', fontWeight: 'bold' },
  modalItemTextAdd:      { color: '#2e7d32', fontWeight: 'bold' },

  modalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#eee',
    backgroundColor: '#fff',
  },
  modalHeaderTitle: { fontSize: 18, fontWeight: '700' },

  // ─── 編集フォーム ─────────────────────────────────────────────────────────
  editForm: { padding: 16, backgroundColor: '#f2f4f7', gap: 0 },

  readOnlyGroup: { backgroundColor: '#fff', borderRadius: 14, overflow: 'hidden', marginBottom: 12 },
  readOnlyRow:   { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: '#f5f5f5', gap: 10 },
  readOnlyLabel:    { fontSize: 13, color: '#888', width: 60 },
  readOnlyValueRow: { flexDirection: 'row', alignItems: 'center', gap: 8, flex: 1 },
  readOnlyValue:    { fontSize: 15, color: '#333' },
  readOnlyNote:     { fontSize: 10, backgroundColor: '#f5f5f5', color: '#999', paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6 },

  fieldBox:        { marginBottom: 12 },
  fieldLabel:      { fontSize: 12, color: '#666', marginBottom: 4 },
  fieldInput: {
    borderWidth: 1,
    borderColor: '#e0e0e0',
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 10,
    fontSize: 15,
    backgroundColor: '#fff',
  },
  fieldInputMulti: { minHeight: 80, textAlignVertical: 'top' },
  editNote:        { fontSize: 11, color: '#999', marginTop: 12, lineHeight: 16 },

  pickerButton: {
    borderWidth: 1,
    borderColor: '#e0e0e0',
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 10,
    backgroundColor: '#fff',
  },
  pickerButtonText: { fontSize: 15, color: '#222' },

  saveBtn:     { backgroundColor: '#2e7d32', borderRadius: 14, paddingVertical: 14, alignItems: 'center', marginTop: 4 },
  saveBtnText: { color: '#fff', fontSize: 16, fontWeight: '700' },

  deleteBtn:     { borderWidth: 1, borderColor: '#dc2626', borderRadius: 12, paddingVertical: 12, alignItems: 'center', backgroundColor: '#fff' },
  deleteBtnText: { fontSize: 15, color: '#dc2626', fontWeight: '600' },

  // ─── チェックボックス (編集モーダル内) ───────────────────────────────────
  checkbox:      { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 4 },
  checkboxLabel: { fontSize: 14, color: '#333' },
  box: {
    width: 20,
    height: 20,
    borderWidth: 1.5,
    borderColor: '#ccc',
    borderRadius: 4,
    alignItems: 'center',
    justifyContent: 'center',
  },
  boxChecked: { backgroundColor: '#2e7d32', borderColor: '#2e7d32' },
  boxMark:    { color: '#fff', fontSize: 13, lineHeight: 15 },

  // ─── Gmail バナー ─────────────────────────────────────────────────────────
  gmailBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: '#1d4ed8',
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  gmailBannerDone: { backgroundColor: '#16a34a' },
  gmailBannerText: { color: '#fff', fontSize: 13, fontWeight: 'bold', flexShrink: 1 },
  queueBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: '#b45309',
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  queueBannerText: { color: '#fff', fontSize: 13, fontWeight: 'bold', flexShrink: 1 },
});
