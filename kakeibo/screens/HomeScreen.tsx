import { useState } from 'react';
import { ActivityIndicator, Alert, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { Ionicons } from '@expo/vector-icons';
import { signInWithGoogle } from '../services/AuthService';

interface Props {
  onSignedIn: () => void;
}

export default function HomeScreen({ onSignedIn }: Props) {
  const [loading, setLoading] = useState(false);

  const handleSignIn = async () => {
    if (loading) return;
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
      <View style={styles.logo}>
        <Text style={styles.logoEmoji}>💰</Text>
      </View>
      <Text style={styles.title}>Bud-Rec</Text>
      <Text style={styles.subtitle}>夫婦の家計簿</Text>
      <TouchableOpacity
        style={[styles.button, loading && styles.buttonDisabled]}
        onPress={handleSignIn}
        disabled={loading}
      >
        {loading ? (
          <ActivityIndicator color="#fff" />
        ) : (
          <>
            <Ionicons name="logo-google" size={18} color="#fff" />
            <Text style={styles.buttonText}>Google でサインイン</Text>
          </>
        )}
      </TouchableOpacity>
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
    paddingHorizontal: 32,
  },
  logo: {
    width: 96,
    height: 96,
    borderRadius: 24,
    backgroundColor: '#2e7d32',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 20,
  },
  logoEmoji: { fontSize: 48 },
  title:     { fontSize: 28, fontWeight: '700', color: '#333' },
  subtitle:  { fontSize: 14, color: '#888', marginTop: 4, marginBottom: 40 },
  button: {
    alignSelf: 'stretch',
    flexDirection: 'row',
    gap: 8,
    backgroundColor: '#2e7d32',
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 50,
  },
  buttonDisabled: { backgroundColor: '#81a784' },
  buttonText:     { color: '#fff', fontSize: 16, fontWeight: '600' },
});
