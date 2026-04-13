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
      <Text style={styles.title}>この端末のユーザー</Text>
      <View style={styles.inputRow}>
        <TextInput
          style={styles.input}
          value={userInput}
          onChangeText={setUserInput}
          placeholder="あなたの名前"
        />
        <Button
          title="保存"
          onPress={handleSaveUser}
          disabled={!userInput.trim() || userInput.trim() === savedUser}
        />
      </View>

      <Text style={styles.title}>Gmail 取り込み</Text>
      <View style={styles.gmailRow}>
        <Text style={styles.gmailLabel}>検索期間</Text>
        <TouchableOpacity
          style={styles.pickerButton}
          onPress={() => setWindowPickerOpen(true)}
        >
          <Text style={styles.pickerButtonText}>
            {gmailWindowLabel(gmailWindow)} ▾
          </Text>
        </TouchableOpacity>
      </View>
      <TouchableOpacity
        style={[
          styles.runGmailBtn,
          gmailProgress.running && styles.runGmailBtnDisabled,
        ]}
        onPress={handleRunGmailImport}
        disabled={gmailProgress.running}
      >
        <Text style={styles.runGmailBtnText}>
          {gmailProgress.running
            ? `取り込み中... ${gmailProgress.phase}`
            : '今すぐ取り込みを実行'}
        </Text>
      </TouchableOpacity>
      <View style={styles.skippedRow}>
        <TouchableOpacity
          style={styles.skippedCheckBtn}
          onPress={handleOpenSkipped}
        >
          <Text style={styles.skippedCheckBtnText}>スキップ済みを確認</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[
            styles.resetSkippedBtn,
            gmailProgress.running && styles.runGmailBtnDisabled,
          ]}
          onPress={handleResetSkipped}
          disabled={gmailProgress.running}
        >
          <Text style={styles.resetSkippedBtnText}>再取り込み</Text>
        </TouchableOpacity>
      </View>
      {gmailProgress.finished && gmailProgress.result && (
        <Text style={styles.gmailResultText}>
          前回: 取込 {gmailProgress.result.imported} / スキップ{' '}
          {gmailProgress.result.skipped} / 失敗 {gmailProgress.result.failed}
        </Text>
      )}

      <Text style={[styles.title, { marginTop: 20 }]}>カテゴリ設定</Text>

      <View style={styles.inputRow}>
        <TextInput
          style={styles.input}
          value={input}
          onChangeText={setInput}
          placeholder="新しいカテゴリ名"
          editable={!loading}
        />
        <Button title="追加" onPress={handleAdd} disabled={loading || !input.trim()} />
      </View>

      <FlatList
        data={categories}
        keyExtractor={(item) => item}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={handleRefresh} />
        }
        renderItem={({ item }) => (
          <View style={styles.row}>
            <Text style={styles.rowText}>{item}</Text>
            <TouchableOpacity
              onPress={() => handleDelete(item)}
              disabled={loading}
              style={styles.deleteBtn}
            >
              <Text style={styles.deleteText}>削除</Text>
            </TouchableOpacity>
          </View>
        )}
        ListEmptyComponent={
          <Text style={styles.empty}>
            {loading ? '読み込み中...' : 'カテゴリがありません'}
          </Text>
        }
      />

      <View style={styles.signOutBox}>
        <Button title="サインアウト" onPress={handleSignOut} color="#888" />
      </View>

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
  container: {
    flex: 1,
    backgroundColor: '#fff',
    paddingHorizontal: 16,
    paddingTop: 8,
  },
  center: {
    flex: 1,
    backgroundColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 16,
    paddingHorizontal: 24,
  },
  title: {
    fontSize: 20,
    fontWeight: 'bold',
    marginBottom: 12,
  },
  inputRow: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 12,
    alignItems: 'center',
  },
  input: {
    flex: 1,
    borderWidth: 1,
    borderColor: '#ccc',
    borderRadius: 6,
    paddingHorizontal: 12,
    paddingVertical: 8,
    fontSize: 16,
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#eee',
  },
  rowText: {
    fontSize: 16,
  },
  deleteBtn: {
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  deleteText: {
    color: '#d33',
    fontSize: 14,
  },
  empty: {
    textAlign: 'center',
    color: '#888',
    marginTop: 24,
  },
  signOutBox: {
    marginTop: 16,
    paddingVertical: 12,
    borderTopWidth: 1,
    borderTopColor: '#eee',
  },

  gmailRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginBottom: 8,
  },
  gmailLabel: { fontSize: 14, color: '#444' },
  pickerButton: {
    borderWidth: 1,
    borderColor: '#ccc',
    borderRadius: 6,
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: '#fff',
  },
  pickerButtonText: { fontSize: 14, color: '#222' },
  runGmailBtn: {
    backgroundColor: '#2563eb',
    borderRadius: 8,
    paddingVertical: 12,
    alignItems: 'center',
    marginBottom: 8,
  },
  runGmailBtnDisabled: {
    backgroundColor: '#9ca3af',
  },
  runGmailBtnText: { color: '#fff', fontSize: 14, fontWeight: 'bold' },
  skippedRow: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 8,
  },
  skippedCheckBtn: {
    flex: 1,
    borderWidth: 1,
    borderColor: '#6b7280',
    borderRadius: 8,
    paddingVertical: 10,
    alignItems: 'center',
  },
  skippedCheckBtnText: { color: '#374151', fontSize: 14, fontWeight: 'bold' },
  resetSkippedBtn: {
    flex: 1,
    borderWidth: 1,
    borderColor: '#d97706',
    borderRadius: 8,
    paddingVertical: 10,
    alignItems: 'center',
  },
  resetSkippedBtnText: { color: '#d97706', fontSize: 14, fontWeight: 'bold' },
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
  gmailResultText: { fontSize: 12, color: '#666', marginBottom: 8 },

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
  modalItem: { paddingHorizontal: 16, paddingVertical: 12 },
  modalItemSelected: { backgroundColor: '#eaf2ff' },
  modalItemText: { fontSize: 15, color: '#222' },
  modalItemTextSelected: { color: '#2563eb', fontWeight: 'bold' },
});
