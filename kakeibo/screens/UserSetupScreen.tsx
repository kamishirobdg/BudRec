import { useState } from 'react';
import {
  Alert,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { setCurrentUser } from '../services/UserService';

interface Props {
  onDone: () => void;
}

/**
 * 初回起動時のユーザー名入力。
 * 名前が保存されるまでアプリ本体（Gmail 取り込み含む）へ進ませない。
 * 再インストール直後に既定名のままメール取り込みが走って
 * 誤った名義のレコードが作られるのを防ぐ。
 */
export default function UserSetupScreen({ onDone }: Props) {
  const [name, setName]     = useState('');
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    const trimmed = name.trim();
    if (!trimmed || saving) return;
    setSaving(true);
    try {
      await setCurrentUser(trimmed);
      onDone();
    } catch (e) {
      Alert.alert('保存失敗', e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <SafeAreaView style={styles.container}>
      {/* edgeToEdgeEnabled では Android の adjustResize で画面が縮まないため、自前で避ける */}
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={styles.body}
      >
        <Text style={styles.title}>ユーザー名</Text>
        <Text style={styles.caption}>この端末で記録する名前を入力してください</Text>
        <TextInput
          style={styles.input}
          value={name}
          onChangeText={setName}
          autoFocus
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
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff' },
  body:      { flex: 1, justifyContent: 'center', paddingHorizontal: 32 },
  title:     { fontSize: 22, fontWeight: '700', color: '#333', marginBottom: 8 },
  caption:   { fontSize: 13, color: '#888', marginBottom: 24 },
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
