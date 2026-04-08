import { useEffect, useState } from 'react';
import { ActivityIndicator, Alert, View } from 'react-native';
import { NavigationContainer } from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import HomeScreen from './screens/HomeScreen';
import CameraScreen from './screens/CameraScreen';
import SettingsScreen from './screens/SettingsScreen';
import { handleAuthCallback, isSignedIn } from './services/AuthService';

const Tab = createBottomTabNavigator();

export default function App() {
  const [signedIn, setSignedIn] = useState(false);
  const [checking, setChecking] = useState(true);

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
              options={{ title: '撮影' }}
            >
              {() => <CameraScreen />}
            </Tab.Screen>
            <Tab.Screen
              name="Settings"
              options={{ title: '設定' }}
            >
              {() => <SettingsScreen onSignedOut={() => setSignedIn(false)} />}
            </Tab.Screen>
          </Tab.Navigator>
        </NavigationContainer>
      )}
      <StatusBar style="auto" />
    </SafeAreaProvider>
  );
}
