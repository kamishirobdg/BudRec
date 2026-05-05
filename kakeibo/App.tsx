import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, AppState, View } from 'react-native';
import { NavigationContainer } from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { Ionicons } from '@expo/vector-icons';
import HomeScreen from './screens/HomeScreen';
import CameraScreen from './screens/CameraScreen';
import SummaryScreen from './screens/SummaryScreen';
import { handleAuthCallback, isSignedIn } from './services/AuthService';
import { runGmailImport } from './services/GmailService';

const Tab = createBottomTabNavigator();

export default function App() {
  const [signedIn, setSignedIn] = useState(false);
  const [checking, setChecking] = useState(true);
  // Gmail 取り込みの最終実行時刻（ms）。5分以内の重複実行を防ぐ
  const lastGmailRunRef = useRef(0);

  useEffect(() => {
    (async () => {
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
              {() => <CameraScreen />}
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
              {() => <SummaryScreen onSignedOut={() => setSignedIn(false)} />}
            </Tab.Screen>
          </Tab.Navigator>
        </NavigationContainer>
      )}
      <StatusBar style="auto" />
    </SafeAreaProvider>
  );
}
