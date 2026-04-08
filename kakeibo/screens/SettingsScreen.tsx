import { useEffect, useState, useCallback } from 'react';
import {
  Alert,
  Button,
  FlatList,
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

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [list, u] = await Promise.all([getCategories(), getCurrentUser()]);
      setCategories(list);
      setUserInput(u);
      setSavedUser(u);
    } catch (e) {
      Alert.alert('読み込み失敗', e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

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

      <Text style={styles.title}>カテゴリ設定</Text>

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
    </SafeAreaView>
  );
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
});
