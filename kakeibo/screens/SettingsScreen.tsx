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
import { isSignedIn } from '../services/AuthService';

export default function SettingsScreen() {
  const [categories, setCategories] = useState<string[]>([]);
  const [input, setInput]           = useState('');
  const [loading, setLoading]       = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [signedIn, setSignedIn]     = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const ok = await isSignedIn();
      setSignedIn(ok);
      if (!ok) {
        setCategories([]);
        return;
      }
      const list = await getCategories();
      setCategories(list);
    } catch (e) {
      Alert.alert('読み込み失敗', e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

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

  if (!signedIn) {
    return (
      <SafeAreaView style={styles.center}>
        <Text style={styles.notice}>
          先に Home タブで Google サインインしてください。
        </Text>
        <Button title="再読み込み" onPress={load} />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container}>
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
  notice: {
    textAlign: 'center',
    fontSize: 14,
    color: '#666',
  },
});
