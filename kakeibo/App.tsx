import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Animated, AppState, StyleSheet, Text, View } from 'react-native';
import { NavigationContainer } from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { Ionicons } from '@expo/vector-icons';
import HomeScreen from './screens/HomeScreen';
import CameraScreen from './screens/CameraScreen';
import SummaryScreen from './screens/SummaryScreen';
import ErrorBoundary from './components/ErrorBoundary';
import { handleAuthCallback, isSignedIn } from './services/AuthService';
import { runGmailImport } from './services/GmailService';
import { loadConfig as loadDemoConfig } from './services/DemoService';

const Tab = createBottomTabNavigator();

export default function App() {
  return (
    <ErrorBoundary>
      <AppContent />
    </ErrorBoundary>
  );
}

/** アプリ本体。描画中に落ちたら外側の ErrorBoundary が受け止める */
function AppContent() {
  const [signedIn, setSignedIn] = useState(false);
  const [checking, setChecking] = useState(true);
  const lastGmailRunRef = useRef(0);

  // OCR 処理中ステータスと成功トースト（画面遷移をまたいで表示するためここで管理）
  const [ocrStatus, setOcrStatus] = useState('');
  const [ocrToast,  setOcrToast]  = useState('');
  const toastOpacity = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (!ocrToast) return;
    Animated.timing(toastOpacity, { toValue: 1, duration: 200, useNativeDriver: true }).start();
    const timer = setTimeout(() => {
      Animated.timing(toastOpacity, { toValue: 0, duration: 300, useNativeDriver: true })
        .start(() => setOcrToast(''));
    }, 3000);
    return () => clearTimeout(timer);
  }, [ocrToast, toastOpacity]);

  useEffect(() => {
    (async () => {
      // デモモード設定を先に読む（各サービスが同期的に参照するため）
      await loadDemoConfig();
      try {
        // Web リダイレクトからの戻りを処理（native では no-op）
        await handleAuthCallback();
      } catch (e) {
        Alert.alert('サインイン失敗', e instanceof Error ? e.message : String(e));
      }
      const ok = await isSignedIn();
      setSignedIn(ok);
      setChecking(false);
    })();
  }, []);

  /** 5分以上経過していれば Gmail 取り込みを実行 */
  const maybeRunGmailImport = () => {
    const COOLDOWN_MS = 5 * 60 * 1000;
    const now = Date.now();
    if (now - lastGmailRunRef.current < COOLDOWN_MS) return;
    lastGmailRunRef.current = now;
    runGmailImport().catch(async () => {
      const ok = await isSignedIn();
      if (!ok) setSignedIn(false);
    });
  };

  // サインイン直後に実行
  useEffect(() => {
    if (signedIn) maybeRunGmailImport();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signedIn]);

  // フォアグラウンド復帰時にも実行（トークン有効性を再確認してから）
  useEffect(() => {
    if (!signedIn) return;
    const sub = AppState.addEventListener('change', async (state) => {
      if (state !== 'active') return;
      const ok = await isSignedIn();
      if (!ok) {
        setSignedIn(false);
        return;
      }
      maybeRunGmailImport();
    });
    return () => sub.remove();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signedIn]);

  return (
    <SafeAreaProvider>
      {checking ? (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          <ActivityIndicator />
        </View>
      ) : !signedIn ? (
        <HomeScreen onSignedIn={() => setSignedIn(true)} />
      ) : (
        <NavigationContainer>
          <Tab.Navigator
            screenOptions={{
              headerShown: true,
              tabBarActiveTintColor: '#2563eb',
            }}
          >
            <Tab.Screen
              name="Camera"
              options={{
                title: '撮影',
                tabBarIcon: ({ color, size }) => (
                  <Ionicons name="camera" color={color} size={size} />
                ),
              }}
            >
              {() => (
                // タブ単位でも囲む。片方の画面が落ちてももう片方は使えるようにする
                <ErrorBoundary>
                  <CameraScreen
                    onSignedOut={() => setSignedIn(false)}
                    onStatusChange={setOcrStatus}
                    onSuccess={setOcrToast}
                  />
                </ErrorBoundary>
              )}
            </Tab.Screen>
            <Tab.Screen
              name="Summary"
              options={{
                title: '一覧',
                tabBarIcon: ({ color, size }) => (
                  <Ionicons name="list" color={color} size={size} />
                ),
              }}
            >
              {() => (
                <ErrorBoundary>
                  <SummaryScreen onSignedOut={() => setSignedIn(false)} />
                </ErrorBoundary>
              )}
            </Tab.Screen>
          </Tab.Navigator>
        </NavigationContainer>
      )}
      {/* OCR 処理中バナー（全画面共通） */}
      {!!ocrStatus && (
        <View style={styles.statusBanner} pointerEvents="none">
          <ActivityIndicator color="#fff" size="small" />
          <Text style={styles.statusBannerText}>{ocrStatus}</Text>
        </View>
      )}

      {/* 成功トースト（全画面共通） */}
      {!!ocrToast && (
        <Animated.View style={[styles.toast, { opacity: toastOpacity }]} pointerEvents="none">
          <Text style={styles.toastText}>{ocrToast}</Text>
        </Animated.View>
      )}

      <StatusBar style="auto" />
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  statusBanner: {
    position:        'absolute',
    top:             56,
    left:            16,
    right:           16,
    flexDirection:   'row',
    alignItems:      'center',
    gap:             8,
    backgroundColor: 'rgba(30,30,30,0.88)',
    borderRadius:    10,
    paddingHorizontal: 16,
    paddingVertical:   10,
    elevation:       10,
    zIndex:          100,
  },
  statusBannerText: {
    color:      '#fff',
    fontSize:   14,
    fontWeight: '600',
  },
  toast: {
    position:        'absolute',
    top:             56,
    left:            16,
    right:           16,
    backgroundColor: 'rgba(34,197,94,0.95)',
    borderRadius:    12,
    paddingHorizontal: 20,
    paddingVertical:   16,
    elevation:       10,
    zIndex:          100,
    shadowColor:     '#000',
    shadowOpacity:   0.3,
    shadowRadius:    8,
    shadowOffset:    { width: 0, height: 4 },
  },
  toastText: {
    color:      '#fff',
    fontSize:   16,
    fontWeight: 'bold',
    textAlign:  'center',
    lineHeight: 22,
  },
});
