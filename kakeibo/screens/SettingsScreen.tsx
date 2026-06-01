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
import { signOut } from '../services/AuthService';
import { getCurrentUser, setCurrentUser } from '../services/UserService';
import {
  GmailSearchWindow,
  GMAIL_SEARCH_WINDOW_OPTIONS,
  getGmailSearchWindow,
  setGmailSearchWindow,
  resetSkippedNotTransactionIds,
  getSkippedNotTransactionMessageIds,
} from '../services/SheetsService';
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

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [list, u, win] = await Promise.all([
        getCategories(),
        getCurrentUser(),
        getGmailSearchWindow(),
      ]);
      setCategories(list);
      setUserInput(u);
      setSavedUser(u);
      setGmailWindowState(win);
    } catch (e) {
      Alert.alert('読み込み失敗', e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

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

  gmailRunBtn: { backgroundColor: '#2e7d32', borderRadius: 12, paddingVertical: 13, alignItems: 'center', marginVertical: 10 },
  gmailRunBtnDisabled: { backgroundColor: '#9ca3af' },
  gmailRunBtnText: { color: '#fff', fontSize: 14, fontWeight: 'bold' },

  skippedRow:  { flexDirection: 'row', gap: 8, marginBottom: 10 },
  skippedCheckBtn:      { flex: 1, borderWidth: 1, borderColor: '#9ca3af', borderRadius: 10, paddingVertical: 10, alignItems: 'center' },
  skippedCheckBtnText:  { color: '#374151', fontSize: 13, fontWeight: '600' },
  resetSkippedBtn:      { flex: 1, borderWidth: 1, borderColor: '#d97706', borderRadius: 10, paddingVertical: 10, alignItems: 'center' },
  resetSkippedBtnText:  { color: '#d97706', fontSize: 13, fontWeight: '600' },
  gmailResultText: { fontSize: 12, color: '#888', marginBottom: 10 },

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
