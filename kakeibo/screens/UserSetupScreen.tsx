import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { setCurrentUser } from '../services/UserService';
import {
  RegisteredUser, getDeviceId, getUniqueUsersRaw, listRegisteredUsers, registerUser,
} from '../services/SheetsService';

interface Props {
  onDone: () => void;
}

/** この期間内に別の端末で使われた名前を選んだら確認する */
const ACTIVE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * 初回起動時のユーザー名入力。
 * 名前が保存されるまでアプリ本体（Gmail 取り込み含む）へ進ませない。
 * 再インストール直後に既定名のままメール取り込みが走って
 * 誤った名義のレコードが作られるのを防ぐ。
 *
 * 共有の一覧（_users）に登録済みの名前と、当月（足りなければ前月）の支出の記録に出てくる名前をボタンで並べる。
 * この端末が前に使っていた名前は
 * 端末 ID（同じ署名なら再インストールしても変わらない）で分かるので、最初から選んでおく。
 */
export default function UserSetupScreen({ onDone }: Props) {
  const [name, setName]         = useState('');
  const [saving, setSaving]     = useState(false);
  const [loading, setLoading]   = useState(true);
  const [users, setUsers]       = useState<RegisteredUser[]>([]);
  const [deviceId, setDeviceId] = useState('');
  // 支出の記録に出てくる名前（_users がまだ無い・相手の端末がまだ登録していないときの候補）
  const [recorded, setRecorded] = useState<string[]>([]);

  useEffect(() => {
    (async () => {
      try {
        const [list, me, inRecords] = await Promise.all([
          listRegisteredUsers(),
          getDeviceId(),
          getUniqueUsersRaw().catch(() => [] as string[]),
        ]);
        setUsers(list);
        setDeviceId(me);
        setRecorded(inRecords);
        const mine = list.find((u) => u.deviceId === me);
        if (mine) setName(mine.name);
      } catch {
        // 読めなければ手で入力してもらう
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const names = [...new Set([...users.map((u) => u.name), ...recorded])];

  const save = async (value: string) => {
    setSaving(true);
    try {
      await setCurrentUser(value);
      registerUser(value).catch(() => {});
      onDone();
    } catch (e) {
      Alert.alert('保存失敗', e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const handleSave = () => {
    const trimmed = name.trim();
    if (!trimmed || saving) return;
    // 同じ名前を二人が名乗ると記録が混ざる。別の端末が最近使っている名前なら確かめる
    const others = users.filter((u) =>
      u.name === trimmed && u.deviceId && u.deviceId !== deviceId && Date.now() - u.lastSeen < ACTIVE_MS);
    if (others.length === 0) {
      save(trimmed);
      return;
    }
    const where = others
      .map((u) => `${u.deviceName || '別の端末'}（${formatDay(u.lastSeen)} に使用）`)
      .join('、');
    Alert.alert(
      'この名前は別の端末で使われています',
      `「${trimmed}」は ${where} で使われています。この端末でも同じ名前を使いますか？`,
      [
        { text: 'やめる', style: 'cancel' },
        { text: '使う', onPress: () => save(trimmed) },
      ],
    );
  };

  return (
    <SafeAreaView style={styles.container}>
      {/* edgeToEdgeEnabled では Android の adjustResize で画面が縮まないため、自前で避ける */}
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={styles.fill}
      >
        <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
          <Text style={styles.title}>ユーザー名</Text>
          <Text style={styles.caption}>この端末で記録する名前を選ぶか、入力してください</Text>

          {loading ? (
            <ActivityIndicator style={{ marginBottom: 16 }} />
          ) : names.length > 0 && (
            <View style={styles.chips}>
              {names.map((n) => (
                <TouchableOpacity
                  key={n}
                  style={[styles.chip, name.trim() === n && styles.chipActive]}
                  onPress={() => setName(n)}
                >
                  <Text style={[styles.chipText, name.trim() === n && styles.chipTextActive]}>{n}</Text>
                </TouchableOpacity>
              ))}
            </View>
          )}

          <TextInput
            style={styles.input}
            value={name}
            onChangeText={setName}
            placeholder="新しい名前"
            returnKeyType="done"
            onSubmitEditing={handleSave}
          />
          <TouchableOpacity
            style={[styles.button, (!name.trim() || saving) && styles.buttonDisabled]}
            onPress={handleSave}
            disabled={!name.trim() || saving}
          >
            <Text style={styles.buttonText}>はじめる</Text>
          </TouchableOpacity>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function formatDay(ms: number): string {
  if (!ms) return '以前';
  const d = new Date(ms);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff' },
  fill:      { flex: 1 },
  body:      { flexGrow: 1, justifyContent: 'center', paddingHorizontal: 32, paddingVertical: 24 },
  title:     { fontSize: 22, fontWeight: '700', color: '#333', marginBottom: 8 },
  caption:   { fontSize: 13, color: '#888', marginBottom: 24 },
  chips:     { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginBottom: 16 },
  chip: {
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: '#2e7d32',
    backgroundColor: '#fff',
  },
  chipActive:     { backgroundColor: '#2e7d32' },
  chipText:       { fontSize: 16, color: '#2e7d32', fontWeight: '600' },
  chipTextActive: { color: '#fff' },
  input: {
    borderWidth:  1,
    borderColor:  '#ddd',
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical:   12,
    fontSize:     16,
    marginBottom: 16,
  },
  button: {
    backgroundColor: '#2e7d32',
    borderRadius:    12,
    paddingVertical: 14,
    alignItems:      'center',
  },
  buttonDisabled: { backgroundColor: '#ccc' },
  buttonText:     { color: '#fff', fontSize: 16, fontWeight: '600' },
});
