import { useState } from 'react';
import { Alert, Button, StyleSheet, Text, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { signInWithGoogle } from '../services/AuthService';

interface Props {
  onSignedIn: () => void;
}

export default function HomeScreen({ onSignedIn }: Props) {
  const [loading, setLoading] = useState(false);

  const handleSignIn = async () => {
    setLoading(true);
    try {
      await signInWithGoogle();
      onSignedIn();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      Alert.alert('サインイン失敗', msg);
    } finally {
      setLoading(false);
    }
  };

  return (
    <View style={styles.container}>
      <Text style={styles.title}>kakeibo</Text>
      <Text style={styles.subtitle}>夫婦の家計簿</Text>
      <Button
        title={loading ? '処理中...' : 'Googleサインイン'}
        onPress={handleSignIn}
        disabled={loading}
      />
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
    fontSize: 32,
    fontWeight: 'bold',
  },
  subtitle: {
    fontSize: 14,
    color: '#666',
    marginBottom: 16,
  },
});
