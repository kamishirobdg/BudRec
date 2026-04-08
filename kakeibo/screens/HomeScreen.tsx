import { useEffect, useState } from 'react';
import { Alert, Button, StyleSheet, Text, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { appendRow, ExpenseRow } from '../services/SheetsService';
import {
  handleAuthCallback,
  isSignedIn,
  signInWithGoogle,
  signOut,
} from '../services/AuthService';

const DUMMY_ENTRY: ExpenseRow = {
  timestamp: '2026-04-07 12:00',
  source:    'camera',
  user:      '夫',
  store:     'テストストア',
  category:  '食費',
  amount:    1000,
  memo:      '動作確認',
};

export default function HomeScreen() {
  const [signedIn, setSignedIn] = useState(false);
  const [loading, setLoading]   = useState(false);

  useEffect(() => {
    (async () => {
      try {
        // Web リダイレクトから戻ってきた場合のコールバック処理
        await handleAuthCallback();
      } catch (e) {
        Alert.alert('サインイン失敗', e instanceof Error ? e.message : String(e));
      }
      const ok = await isSignedIn();
      setSignedIn(ok);
    })();
  }, []);

  const handleSignIn = async () => {
    setLoading(true);
    try {
      await signInWithGoogle();
      setSignedIn(true);
      Alert.alert('成功', 'Googleサインインしました');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      Alert.alert('サインイン失敗', msg);
    } finally {
      setLoading(false);
    }
  };

  const handleSignOut = async () => {
    setLoading(true);
    try {
      await signOut();
      setSignedIn(false);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      Alert.alert('サインアウト失敗', msg);
    } finally {
      setLoading(false);
    }
  };

  const handleTestWrite = async () => {
    setLoading(true);
    try {
      await appendRow(DUMMY_ENTRY);
      Alert.alert('成功', 'スプレッドシートに書き込みました');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      Alert.alert('失敗', msg);
    } finally {
      setLoading(false);
    }
  };

  return (
    <View style={styles.container}>
      <Text style={styles.title}>kakeibo</Text>
      <Text style={styles.status}>
        状態: {signedIn ? '✓ サインイン済み' : '未サインイン'}
      </Text>

      {!signedIn ? (
        <Button
          title={loading ? '処理中...' : 'Googleサインイン'}
          onPress={handleSignIn}
          disabled={loading}
        />
      ) : (
        <>
          <Button
            title={loading ? '書き込み中...' : 'テスト書き込み'}
            onPress={handleTestWrite}
            disabled={loading}
          />
          <Button
            title="サインアウト"
            onPress={handleSignOut}
            disabled={loading}
            color="#888"
          />
        </>
      )}

      <StatusBar style="auto" />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 16,
  },
  title: {
    fontSize: 24,
    fontWeight: 'bold',
  },
  status: {
    fontSize: 14,
    color: '#666',
  },
});
