import { useEffect, useState, useCallback } from 'react';
import {
  ActivityIndicator,
  Alert,
  Button,
  FlatList,
  Modal,
  Pressable,
  RefreshControl,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
  addCategory,
  getCategories,
  refresh as refreshCategories,
  removeCategory,
} from '../services/CategoryService';
import { signOut, AuthError } from '../services/AuthService';
import { getCurrentUserRaw, setCurrentUser } from '../services/UserService';
import {
  GmailSearchWindow,
  GMAIL_SEARCH_WINDOW_OPTIONS,
  getGmailSearchWindow,
  setGmailSearchWindow,
  resetSkippedNotTransactionIds,
  getSkippedNotTransactionMessageIds,
  getUniqueUsersRaw,
  getRowsRaw,
  flushWriteQueue,
} from '../services/SheetsService';
import * as WriteQueue from '../services/WriteQueueService';
import * as RowsCache from '../services/RowsCacheService';
import * as LastBatch from '../services/LastBatchService';
import * as Demo from '../services/DemoService';
import { runGmailImport, getSkippedMessageSummaries, SkippedMessageSummary } from '../services/GmailService';
import { useGmailProgress } from '../services/GmailProgressService';

interface Props {
  onSignedOut: () => void;
}

export default function SettingsScreen({ onSignedOut }: Props) {
  const [categories, setCategories] = useState<string[]>([]);
  const [input, setInput]           = useState('');
  const [loading, setLoading]       = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [userInput, setUserInput]   = useState<string>('');
  const [savedUser, setSavedUser]   = useState<string>('');
  const [gmailWindow, setGmailWindowState] = useState<GmailSearchWindow>('60d');
  const [windowPickerOpen, setWindowPickerOpen] = useState(false);
  const gmailProgress = useGmailProgress();
  const [skippedOpen, setSkippedOpen]       = useState(false);
  const [skippedLoading, setSkippedLoading] = useState(false);
  const [skippedItems, setSkippedItems]     = useState<SkippedMessageSummary[]>([]);

  // ─── 未送信の書き込み ───
  const queuedWrites            = WriteQueue.useWriteQueue();
  const [flushing, setFlushing] = useState(false);

  // ─── デモモード ───
  const [demo, setDemo]           = useState<Demo.DemoConfig>(Demo.getConfigSync);
  // 設定内容(表示名・カテゴリ別合計など)はON/OFFを切り替えた直後だけ見せる。
  // 画面を開いただけ・ONのまま再訪しただけでは出さない(横から見られてもデモと分からないように)
  const [panelOpen, setPanelOpen] = useState(false);
  const [demoUsers, setDemoUsers] = useState<string[]>([]); // 実名の一覧
  const [aliasDraft, setAliasDraft] = useState<Record<string, string>>({});
  /** 当月の実際のカテゴリ別合計（マスク前）。[カテゴリ, 金額] の降順 */
  const [catActual, setCatActual] = useState<[string, number][]>([]);
  const [catDraft, setCatDraft]   = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [list, u, win, cfg] = await Promise.all([
        getCategories(),
        getCurrentUserRaw(),
        getGmailSearchWindow(),
        Demo.loadConfig(),
      ]);
      setCategories(list);
      setUserInput(u);
      setSavedUser(u);
      setGmailWindowState(win);
      setDemo(cfg);

      // デモの導線を畳んでいる間は対応表もカテゴリ別合計も表示しないので、
      // そのためだけの Sheets 読み出しを走らせない
      if (Demo.DEMO_MODE_AVAILABLE) {
        // デモ表示名の対応表を作るために「シートに実在する名前」を集める
        const sheetUsers = await getUniqueUsersRaw();
        const names = [...new Set([u, ...sheetUsers])];
        setDemoUsers(names);
        setAliasDraft(
          Object.fromEntries(names.map((n) => [n, cfg.aliases[n] ?? ''])),
        );

        // カテゴリ別合計の編集はデモON時のみ必要（余計な通信を増やさない）
        if (cfg.enabled) await loadCategoryTotals(cfg);
      }
    } catch (e) {
      Alert.alert('読み込み失敗', e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  /** 当月の実データからカテゴリ別合計を作る（画面のカテゴリ別カードと同じ定義） */
  const loadCategoryTotals = async (cfg: Demo.DemoConfig) => {
    const rows = await getRowsRaw();
    const m = new Map<string, number>();
    for (const r of rows) {
      if (r.excluded) continue;
      const key = Demo.catKey(r.category);
      m.set(key, (m.get(key) ?? 0) + r.countedAmount);
    }
    const list = [...m.entries()].sort((a, b) => b[1] - a[1]);
    setCatActual(list);
    setCatDraft(
      Object.fromEntries(
        list.map(([k]) => [k, cfg.categoryTotals[k] ? String(cfg.categoryTotals[k]) : '']),
      ),
    );
  };

  const patchDemo = async (patch: Partial<Demo.DemoConfig>) => {
    try {
      const next = await Demo.updateConfig(patch);
      setDemo(next);
      // ON にした直後は実データのカテゴリ別合計を取りに行く
      if (patch.enabled === true && catActual.length === 0) {
        await loadCategoryTotals(next);
      }
    } catch (e) {
      Alert.alert('保存失敗', e instanceof Error ? e.message : String(e));
    }
  };

  /** カテゴリ別合計の入力を確定する。空欄・0 なら指定なし（倍率のみ）に戻す */
  const commitCatTotal = (category: string) => {
    const raw = (catDraft[category] ?? '').replace(/[^\d]/g, '');
    const n   = Number(raw);
    const next = { ...demo.categoryTotals };
    if (raw && Number.isFinite(n) && n > 0) next[category] = n;
    else delete next[category];
    patchDemo({ categoryTotals: next });
  };

  /** カテゴリ別倍率を選ぶ。undefined は「指定なし（共通倍率を使う）」 */
  const setCategoryScale = (category: string, value: number | undefined) => {
    const next = { ...demo.categoryScales };
    if (value === undefined) delete next[category];
    else next[category] = value;
    patchDemo({ categoryScales: next });
  };

  /** 表示名の入力を確定してデモ設定に保存する */
  const commitAlias = (realName: string) => {
    const next = { ...demo.aliases };
    const v = (aliasDraft[realName] ?? '').trim();
    if (v) next[realName] = v;
    else delete next[realName];
    patchDemo({ aliases: next });
  };

  const handlePickWindow = async (v: GmailSearchWindow) => {
    setWindowPickerOpen(false);
    if (v === gmailWindow) return;
    try {
      await setGmailSearchWindow(v);
      setGmailWindowState(v);
    } catch (e) {
      Alert.alert('保存失敗', e instanceof Error ? e.message : String(e));
    }
  };

  const handleRunGmailImport = () => {
    if (gmailProgress.running) return;
    runGmailImport();
  };

  // ─── 未送信の書き込み ───

  const handleFlushQueue = async () => {
    if (flushing) return;
    setFlushing(true);
    try {
      const { sent, remaining } = await flushWriteQueue();
      Alert.alert(
        '送信結果',
        remaining === 0
          ? `${sent} 件すべて送信しました。`
          : `送信 ${sent} 件 / 未送信 ${remaining} 件。通信状況を確認してもう一度お試しください。`,
      );
    } catch (e) {
      if (e instanceof AuthError) { onSignedOut(); return; }
      Alert.alert('送信失敗', e instanceof Error ? e.message : String(e));
    } finally {
      setFlushing(false);
    }
  };

  const handleDiscardOne = (item: WriteQueue.QueuedWrite) => {
    Alert.alert(
      'この変更を破棄しますか？',
      `${WriteQueue.describeOp(item.op)}\nスプレッドシートには反映されません。取り消せません。`,
      [
        { text: 'キャンセル', style: 'cancel' },
        { text: '破棄', style: 'destructive', onPress: () => WriteQueue.discard(item.id) },
      ],
    );
  };

  const handleDiscardAllQueued = () => {
    Alert.alert(
      'すべて破棄しますか？',
      `${queuedWrites.length} 件の未送信の変更を捨てます。スプレッドシートには反映されません。取り消せません。`,
      [
        { text: 'キャンセル', style: 'cancel' },
        { text: 'すべて破棄', style: 'destructive', onPress: () => WriteQueue.clear() },
      ],
    );
  };

  const handleOpenSkipped = async () => {
    setSkippedOpen(true);
    setSkippedLoading(true);
    try {
      const ids = await getSkippedNotTransactionMessageIds();
      if (ids.length === 0) {
        setSkippedItems([]);
      } else {
        const summaries = await getSkippedMessageSummaries(ids);
        setSkippedItems(summaries);
      }
    } catch (e) {
      Alert.alert('読み込み失敗', e instanceof Error ? e.message : String(e));
      setSkippedOpen(false);
    } finally {
      setSkippedLoading(false);
    }
  };

  const handleResetSkipped = () => {
    if (gmailProgress.running) return;
    Alert.alert(
      'スキップ済みを再取り込み',
      '"取引なし" としてスキップされたメールを再処理します。\n実行しますか？',
      [
        { text: 'キャンセル', style: 'cancel' },
        {
          text: '実行',
          onPress: async () => {
            try {
              const count = await resetSkippedNotTransactionIds();
              if (count === 0) {
                Alert.alert('対象なし', 'スキップ済みのメールはありませんでした');
                return;
              }
              Alert.alert(
                '再取り込み開始',
                `${count} 件を再処理対象にしました。取り込みを開始します。`,
              );
              runGmailImport();
            } catch (e) {
              Alert.alert('失敗', e instanceof Error ? e.message : String(e));
            }
          },
        },
      ],
    );
  };

  const handleSaveUser = async () => {
    const name = userInput.trim();
    if (!name) {
      Alert.alert('入力エラー', 'ユーザー名を入力してください');
      return;
    }
    try {
      await setCurrentUser(name);
      setSavedUser(name);
      Alert.alert('保存しました', `ユーザー名: ${name}`);
    } catch (e) {
      Alert.alert('保存失敗', e instanceof Error ? e.message : String(e));
    }
  };

  useEffect(() => {
    load();
  }, [load]);

  const handleAdd = async () => {
    const name = input.trim();
    if (!name) return;
    setLoading(true);
    try {
      await addCategory(name);
      setInput('');
      const list = await getCategories();
      setCategories(list);
    } catch (e) {
      Alert.alert('追加失敗', e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = (name: string) => {
    Alert.alert(
      '削除確認',
      `「${name}」を削除しますか？`,
      [
        { text: 'キャンセル', style: 'cancel' },
        {
          text: '削除',
          style: 'destructive',
          onPress: async () => {
            setLoading(true);
            try {
              await removeCategory(name);
              const list = await getCategories();
              setCategories(list);
            } catch (e) {
              Alert.alert('削除失敗', e instanceof Error ? e.message : String(e));
            } finally {
              setLoading(false);
            }
          },
        },
      ],
    );
  };

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      const list = await refreshCategories();
      setCategories(list);
    } catch (e) {
      Alert.alert('更新失敗', e instanceof Error ? e.message : String(e));
    } finally {
      setRefreshing(false);
    }
  };

  const handleSignOut = () => {
    Alert.alert(
      'サインアウト確認',
      'Googleからサインアウトしますか？',
      [
        { text: 'キャンセル', style: 'cancel' },
        {
          text: 'サインアウト',
          style: 'destructive',
          onPress: async () => {
            try {
              await signOut();
              // 同じ端末で別アカウントに切り替えることがあるため、
              // 前アカウントのデータがオフラインキャッシュ・「前回の登録」として残らないようにする
              RowsCache.clear();
              LastBatch.clearLastBatch();
              onSignedOut();
            } catch (e) {
              Alert.alert('サインアウト失敗', e instanceof Error ? e.message : String(e));
            }
          },
        },
      ],
    );
  };

  return (
    <SafeAreaView style={styles.container}>
      <FlatList
        data={categories}
        keyExtractor={(item) => item}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={handleRefresh} />}
        ListHeaderComponent={
          <View style={styles.body}>
            {/* デモモード。利用期間が終わったので導線は畳んである。
                機能は DemoService に残してあるので、また外部に見せるときは
                DEMO_MODE_AVAILABLE を true に戻せばこのカードごと復活する */}
            {Demo.DEMO_MODE_AVAILABLE && (
              <View style={styles.card}>
                <View style={[styles.cardRow, styles.demoToggleRow, (demo.enabled && panelOpen) && styles.cardRowBorder]}>
                  <TouchableOpacity
                    onPress={() => {
                      setPanelOpen(true);
                      patchDemo({ enabled: !demo.enabled });
                    }}
                    style={[styles.demoToggleBtn, demo.enabled && styles.demoToggleBtnOn]}
                    activeOpacity={0.7}
                  />
                </View>

                {demo.enabled && panelOpen && (
                  <>
                    <Text style={styles.demoGroupLabel}>表示名</Text>
                    {demoUsers.map((name) => (
                      <View key={name} style={[styles.cardRow, styles.cardRowBorder]}>
                        <Text style={styles.demoRealName} numberOfLines={1}>{name} →</Text>
                        <TextInput
                          style={styles.cardInput}
                          value={aliasDraft[name] ?? ''}
                          onChangeText={(v) => setAliasDraft((p) => ({ ...p, [name]: v }))}
                          onBlur={() => commitAlias(name)}
                          onSubmitEditing={() => commitAlias(name)}
                          placeholder={Demo.maskUser(name)}
                          returnKeyType="done"
                        />
                      </View>
                    ))}

                    <Text style={styles.demoGroupLabel}>カテゴリ別の合計金額（当月）</Text>
                    {catActual.length === 0 ? (
                      <Text style={styles.demoHint}>当月のデータがありません</Text>
                    ) : (
                      <>
                        {catActual.map(([cat, actual]) => (
                          <View key={cat} style={[styles.cardRow, styles.cardRowBorder]}>
                            <Text style={styles.demoRealName} numberOfLines={1}>{cat}</Text>
                            <Text style={styles.demoActualAmount}>¥{actual.toLocaleString()} →</Text>
                            <TextInput
                              style={[styles.cardInput, { textAlign: 'right' }]}
                              value={catDraft[cat] ?? ''}
                              onChangeText={(v) => setCatDraft((p) => ({ ...p, [cat]: v }))}
                              onBlur={() => commitCatTotal(cat)}
                              onSubmitEditing={() => commitCatTotal(cat)}
                              placeholder="指定なし"
                              keyboardType="number-pad"
                              returnKeyType="done"
                            />
                          </View>
                        ))}
                        <Text style={styles.demoHint}>
                          金額を入れたカテゴリは、その月の合計がその値になるよう明細を比例配分します。
                          空欄なら下の倍率が使われます。
                        </Text>
                      </>
                    )}

                    <Text style={styles.demoGroupLabel}>金額の倍率（合計未指定のカテゴリ）</Text>
                    <View style={[styles.cardRow, styles.cardRowBorder, { flexWrap: 'wrap' }]}>
                      {Demo.SCALE_OPTIONS.map((s) => (
                        <TouchableOpacity
                          key={s}
                          style={[styles.pillBtn, demo.scale === s && styles.pillBtnActive]}
                          onPress={() => patchDemo({ scale: s })}
                        >
                          <Text style={[styles.pillBtnText, demo.scale === s && styles.pillBtnTextActive]}>
                            ×{s}
                          </Text>
                        </TouchableOpacity>
                      ))}
                    </View>
                    <Text style={styles.demoHint}>
                      1倍以外を選ぶと、明細ごとに ±20% ずらすため実際の金額は分かりません。
                      1倍なら元の金額のまま表示されます。
                    </Text>

                    {catActual.length > 0 && (
                      <>
                        <Text style={styles.demoGroupLabel}>カテゴリ別倍率（合計未指定のカテゴリ）</Text>
                        {catActual.map(([cat]) => {
                          const catScale = demo.categoryScales[cat];
                          return (
                            <View key={cat} style={[styles.cardRow, styles.cardRowBorder, { flexWrap: 'wrap' }]}>
                              <Text style={styles.demoRealName} numberOfLines={1}>{cat}</Text>
                              <TouchableOpacity
                                style={[styles.pillBtn, catScale === undefined && styles.pillBtnActive]}
                                onPress={() => setCategoryScale(cat, undefined)}
                              >
                                <Text style={[styles.pillBtnText, catScale === undefined && styles.pillBtnTextActive]}>
                                  共通
                                </Text>
                              </TouchableOpacity>
                              {Demo.SCALE_OPTIONS.map((s) => (
                                <TouchableOpacity
                                  key={s}
                                  style={[styles.pillBtn, catScale === s && styles.pillBtnActive]}
                                  onPress={() => setCategoryScale(cat, s)}
                                >
                                  <Text style={[styles.pillBtnText, catScale === s && styles.pillBtnTextActive]}>
                                    ×{s}
                                  </Text>
                                </TouchableOpacity>
                              ))}
                            </View>
                          );
                        })}
                        <Text style={styles.demoHint}>
                          カテゴリ別の合計金額を指定した場合はそちらが優先され、この倍率は使われません。
                        </Text>
                      </>
                    )}

                    <View style={[styles.cardRow, styles.cardRowBorder]}>
                      <Text style={styles.cardRowLabel}>店名もぼかす</Text>
                      <Switch
                        value={demo.maskStore}
                        onValueChange={(v) => patchDemo({ maskStore: v })}
                        trackColor={{ false: '#ccc', true: '#a5d6a7' }}
                        thumbColor={demo.maskStore ? '#2e7d32' : '#f4f3f4'}
                      />
                    </View>
                    <View style={styles.cardRow}>
                      <Text style={styles.cardRowLabel}>メモを隠す</Text>
                      <Switch
                        value={demo.hideMemo}
                        onValueChange={(v) => patchDemo({ hideMemo: v })}
                        trackColor={{ false: '#ccc', true: '#a5d6a7' }}
                        thumbColor={demo.hideMemo ? '#2e7d32' : '#f4f3f4'}
                      />
                    </View>
                  </>
                )}
              </View>
            )}

            {/* ユーザー */}
            <Text style={styles.sectionLabel}>このデバイスのユーザー</Text>
            <View style={styles.card}>
              <View style={styles.cardRow}>
                <TextInput
                  style={styles.cardInput}
                  value={userInput}
                  onChangeText={setUserInput}
                  placeholder="あなたの名前"
                />
                <TouchableOpacity
                  style={[styles.smallBtn, (!userInput.trim() || userInput.trim() === savedUser) && styles.smallBtnDisabled]}
                  onPress={handleSaveUser}
                  disabled={!userInput.trim() || userInput.trim() === savedUser}
                >
                  <Text style={styles.smallBtnText}>保存</Text>
                </TouchableOpacity>
              </View>
            </View>

            {/* Gmail */}
            <Text style={styles.sectionLabel}>Gmail 連携</Text>
            <View style={styles.card}>
              <View style={[styles.cardRow, styles.cardRowBorder]}>
                <Text style={styles.cardRowLabel}>検索期間</Text>
                <TouchableOpacity style={styles.pillBtn} onPress={() => setWindowPickerOpen(true)}>
                  <Text style={styles.pillBtnText}>{gmailWindowLabel(gmailWindow)} ▾</Text>
                </TouchableOpacity>
              </View>
              <TouchableOpacity
                style={[styles.gmailRunBtn, gmailProgress.running && styles.gmailRunBtnDisabled]}
                onPress={handleRunGmailImport}
                disabled={gmailProgress.running}
              >
                <Text style={styles.gmailRunBtnText}>
                  {gmailProgress.running ? `取り込み中... ${gmailProgress.phase}` : '今すぐ取り込みを実行'}
                </Text>
              </TouchableOpacity>
              <View style={styles.skippedRow}>
                <TouchableOpacity style={styles.skippedCheckBtn} onPress={handleOpenSkipped}>
                  <Text style={styles.skippedCheckBtnText}>スキップ済みを確認</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.resetSkippedBtn, gmailProgress.running && styles.gmailRunBtnDisabled]}
                  onPress={handleResetSkipped}
                  disabled={gmailProgress.running}
                >
                  <Text style={styles.resetSkippedBtnText}>再取り込み</Text>
                </TouchableOpacity>
              </View>
              {gmailProgress.finished && gmailProgress.result && (
                <Text style={styles.gmailResultText}>
                  前回: 取込 {gmailProgress.result.imported} / スキップ {gmailProgress.result.skipped} / 失敗 {gmailProgress.result.failed}
                </Text>
              )}
            </View>

            {/* 未送信の書き込み（溜まっているときだけ出す）。
                中身は実データ（店名・金額）そのままなので、デモ中は見せない */}
            {!demo.enabled && queuedWrites.length > 0 && (
              <>
                <Text style={styles.sectionLabel}>未送信の変更（{queuedWrites.length} 件）</Text>
                <View style={styles.card}>
                  <Text style={styles.queueHint}>
                    通信できずに端末へ保存した変更です。送信できるまでスプレッドシートには反映されません。
                  </Text>
                  {queuedWrites.map((q) => (
                    <View key={q.id} style={[styles.cardRow, styles.cardRowBorder]}>
                      <View style={styles.queueItemBody}>
                        <Text style={styles.queueOpText}>{WriteQueue.describeOp(q.op)}</Text>
                        <Text style={styles.queueMetaText}>
                          {q.queuedAt} · {q.permanent ? '送信不可' : `${q.attempts} 回失敗`} · {q.lastError}
                        </Text>
                      </View>
                      <TouchableOpacity
                        style={styles.queueDiscardBtn}
                        onPress={() => handleDiscardOne(q)}
                      >
                        <Text style={styles.queueDiscardBtnText}>破棄</Text>
                      </TouchableOpacity>
                    </View>
                  ))}
                  <TouchableOpacity
                    style={[styles.gmailRunBtn, flushing && styles.gmailRunBtnDisabled]}
                    onPress={handleFlushQueue}
                    disabled={flushing}
                  >
                    <Text style={styles.gmailRunBtnText}>
                      {flushing ? '送信中...' : '今すぐ送信'}
                    </Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={styles.queueClearBtn} onPress={handleDiscardAllQueued}>
                    <Text style={styles.queueClearBtnText}>すべて破棄</Text>
                  </TouchableOpacity>
                </View>
              </>
            )}

            {/* カテゴリ */}
            <Text style={styles.sectionLabel}>カテゴリ</Text>
            <View style={[styles.card, { paddingBottom: 8 }]}>
              <View style={[styles.cardRow, styles.cardRowBorder]}>
                <TextInput
                  style={styles.cardInput}
                  value={input}
                  onChangeText={setInput}
                  placeholder="新しいカテゴリ名"
                  editable={!loading}
                />
                <TouchableOpacity
                  style={[styles.smallBtn, (loading || !input.trim()) && styles.smallBtnDisabled]}
                  onPress={handleAdd}
                  disabled={loading || !input.trim()}
                >
                  <Text style={styles.smallBtnText}>追加</Text>
                </TouchableOpacity>
              </View>
            </View>
          </View>
        }
        renderItem={({ item }) => (
          <View style={styles.categoryItem}>
            <Text style={styles.categoryItemText}>{item}</Text>
            <TouchableOpacity onPress={() => handleDelete(item)} disabled={loading} style={styles.deleteBtn}>
              <Text style={styles.deleteText}>削除</Text>
            </TouchableOpacity>
          </View>
        )}
        ListEmptyComponent={
          <Text style={styles.empty}>{loading ? '読み込み中...' : 'カテゴリがありません'}</Text>
        }
        ListFooterComponent={
          <View style={styles.footer}>
            <TouchableOpacity style={styles.signOutBtn} onPress={handleSignOut}>
              <Text style={styles.signOutBtnText}>サインアウト</Text>
            </TouchableOpacity>
          </View>
        }
      />

      {/* スキップ済みメール確認モーダル */}
      <Modal
        visible={skippedOpen}
        transparent
        animationType="slide"
        onRequestClose={() => setSkippedOpen(false)}
      >
        <View style={styles.skippedModalContainer}>
          <View style={styles.skippedModalHeader}>
            <Text style={styles.skippedModalTitle}>
              スキップ済みメール（取引なし判定）
            </Text>
            <TouchableOpacity onPress={() => setSkippedOpen(false)}>
              <Text style={styles.skippedModalClose}>✕</Text>
            </TouchableOpacity>
          </View>
          {skippedLoading ? (
            <ActivityIndicator style={{ marginTop: 40 }} />
          ) : skippedItems.length === 0 ? (
            <Text style={styles.skippedEmpty}>スキップ済みのメールはありません</Text>
          ) : (
            <FlatList
              data={skippedItems}
              keyExtractor={(item) => item.id}
              contentContainerStyle={{ padding: 12 }}
              renderItem={({ item }) => (
                <View style={styles.skippedCard}>
                  <Text style={styles.skippedSubject} numberOfLines={2}>{item.subject}</Text>
                  <Text style={styles.skippedDate}>{item.date}</Text>
                  <Text style={styles.skippedBody} numberOfLines={5}>{item.bodyPreview}</Text>
                </View>
              )}
            />
          )}
        </View>
      </Modal>

      {/* Gmail 検索期間ピッカー */}
      <Modal
        visible={windowPickerOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setWindowPickerOpen(false)}
      >
        <Pressable
          style={styles.modalBackdrop}
          onPress={() => setWindowPickerOpen(false)}
        >
          <Pressable style={styles.modalSheet} onPress={(e) => e.stopPropagation()}>
            <Text style={styles.modalTitle}>検索期間を選択</Text>
            {GMAIL_SEARCH_WINDOW_OPTIONS.map((w) => (
              <TouchableOpacity
                key={w}
                style={[
                  styles.modalItem,
                  w === gmailWindow && styles.modalItemSelected,
                ]}
                onPress={() => handlePickWindow(w)}
              >
                <Text
                  style={[
                    styles.modalItemText,
                    w === gmailWindow && styles.modalItemTextSelected,
                  ]}
                >
                  {gmailWindowLabel(w)}
                </Text>
              </TouchableOpacity>
            ))}
          </Pressable>
        </Pressable>
      </Modal>
    </SafeAreaView>
  );
}

function gmailWindowLabel(w: GmailSearchWindow): string {
  switch (w) {
    case '30d':  return '過去 30 日';
    case '60d':  return '過去 60 日';
    case '180d': return '過去 180 日';
    case '1y':   return '過去 1 年';
    case 'all':  return '全期間';
  }
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f2f4f7' },
  center:    { flex: 1, backgroundColor: '#f2f4f7', alignItems: 'center', justifyContent: 'center', gap: 16, paddingHorizontal: 24 },
  empty:     { textAlign: 'center', color: '#888', marginTop: 16, paddingHorizontal: 16 },

  body: { padding: 16 },

  sectionLabel: { fontSize: 12, fontWeight: '600', color: '#888', letterSpacing: 0.5, marginBottom: 8, marginTop: 4, paddingHorizontal: 4 },

  card: {
    backgroundColor: '#fff',
    borderRadius: 16,
    overflow: 'hidden',
    marginBottom: 16,
    paddingHorizontal: 16,
    paddingTop: 4,
  },
  cardRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 12 },
  cardRowBorder: { borderBottomWidth: 1, borderBottomColor: '#f0f0f0' },
  cardRowLabel: { fontSize: 14, color: '#555', flex: 1 },
  cardInput: {
    flex: 1,
    fontSize: 15,
    color: '#1a1a1a',
    paddingVertical: 4,
  },

  smallBtn: { backgroundColor: '#2e7d32', borderRadius: 10, paddingHorizontal: 16, paddingVertical: 8 },
  smallBtnDisabled: { backgroundColor: '#ccc' },
  smallBtnText: { color: '#fff', fontSize: 13, fontWeight: '600' },

  pillBtn: { backgroundColor: '#f5f5f5', borderWidth: 1, borderColor: '#e0e0e0', borderRadius: 20, paddingHorizontal: 12, paddingVertical: 6 },
  pillBtnText: { fontSize: 13, color: '#333' },
  pillBtnActive:     { backgroundColor: '#e8f5e9', borderColor: '#2e7d32' },
  pillBtnTextActive: { color: '#2e7d32', fontWeight: 'bold' },

  demoToggleRow:  { justifyContent: 'flex-end' },
  demoToggleBtn:  { width: 28, height: 28, borderRadius: 14, backgroundColor: '#ccc' },
  demoToggleBtnOn: { backgroundColor: '#2e7d32' },

  demoHint:       { fontSize: 11, color: '#888', lineHeight: 16, marginTop: 2, paddingBottom: 8 },
  demoGroupLabel: { fontSize: 11, fontWeight: '600', color: '#888', marginTop: 10 },
  demoRealName:   { fontSize: 14, color: '#555', maxWidth: 120 },
  demoActualAmount: { fontSize: 12, color: '#999' },

  gmailRunBtn: { backgroundColor: '#2e7d32', borderRadius: 12, paddingVertical: 13, alignItems: 'center', marginVertical: 10 },
  gmailRunBtnDisabled: { backgroundColor: '#9ca3af' },
  gmailRunBtnText: { color: '#fff', fontSize: 14, fontWeight: 'bold' },

  skippedRow:  { flexDirection: 'row', gap: 8, marginBottom: 10 },
  skippedCheckBtn:      { flex: 1, borderWidth: 1, borderColor: '#9ca3af', borderRadius: 10, paddingVertical: 10, alignItems: 'center' },
  skippedCheckBtnText:  { color: '#374151', fontSize: 13, fontWeight: '600' },
  resetSkippedBtn:      { flex: 1, borderWidth: 1, borderColor: '#d97706', borderRadius: 10, paddingVertical: 10, alignItems: 'center' },
  resetSkippedBtnText:  { color: '#d97706', fontSize: 13, fontWeight: '600' },
  gmailResultText: { fontSize: 12, color: '#888', marginBottom: 10 },

  queueHint: { fontSize: 12, color: '#6b7280', lineHeight: 18, paddingTop: 8, paddingBottom: 4 },
  queueItemBody: { flex: 1 },
  queueOpText: { fontSize: 14, color: '#1a1a1a' },
  queueMetaText: { fontSize: 11, color: '#9ca3af', marginTop: 2 },
  queueDiscardBtn: { borderWidth: 1, borderColor: '#ef4444', borderRadius: 10, paddingHorizontal: 12, paddingVertical: 6 },
  queueDiscardBtnText: { color: '#ef4444', fontSize: 12, fontWeight: '600' },
  queueClearBtn: { alignItems: 'center', paddingVertical: 10, marginBottom: 6 },
  queueClearBtnText: { color: '#ef4444', fontSize: 13, fontWeight: '600' },

  categoryItem: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginHorizontal: 16,
    paddingVertical: 13,
    paddingHorizontal: 16,
    backgroundColor: '#fff',
    borderBottomWidth: 1,
    borderBottomColor: '#f5f5f5',
  },
  categoryItemText: { fontSize: 15, color: '#1a1a1a' },

  deleteBtn:  { paddingHorizontal: 10, paddingVertical: 4 },
  deleteText: { color: '#e53935', fontSize: 13, fontWeight: '600' },

  footer: { padding: 16, paddingTop: 8 },
  signOutBtn:     { borderRadius: 14, paddingVertical: 14, alignItems: 'center', backgroundColor: '#fff' },
  signOutBtnText: { color: '#e53935', fontSize: 15, fontWeight: '600' },

  skippedModalContainer: {
    flex: 1,
    backgroundColor: '#fff',
    marginTop: 60,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    elevation: 8,
  },
  skippedModalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#eee',
  },
  skippedModalTitle: { fontSize: 15, fontWeight: 'bold', flex: 1 },
  skippedModalClose: { fontSize: 20, color: '#666', paddingLeft: 12 },
  skippedEmpty: { textAlign: 'center', color: '#888', marginTop: 40, fontSize: 14 },
  skippedCard: {
    borderWidth: 1,
    borderColor: '#e5e7eb',
    borderRadius: 8,
    padding: 12,
    marginBottom: 10,
    backgroundColor: '#fafafa',
  },
  skippedSubject: { fontSize: 14, fontWeight: 'bold', color: '#111', marginBottom: 2 },
  skippedDate: { fontSize: 11, color: '#6b7280', marginBottom: 6 },
  skippedBody: { fontSize: 12, color: '#374151', lineHeight: 18 },
  modalBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'center', alignItems: 'center' },
  modalSheet:    { backgroundColor: '#fff', borderRadius: 16, width: '80%', maxHeight: '70%', paddingVertical: 12 },
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
});
