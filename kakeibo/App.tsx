import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, View } from 'react-native';
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
  // Gmail 取り込みをセッション中に1回だけ走らせるためのフラグ
  const gmailImportedRef = useRef(false);

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

  // サインイン後、バックグラウンドで Gmail 取り込みを1度だけ走らせる
  // （UI ブロック・通知無し、エラーは GmailService 内で console.error に出る）
  useEffect(() => {
    if (signedIn && !gmailImportedRef.current) {
      gmailImportedRef.current = true;
      runGmailImport();
    }
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
