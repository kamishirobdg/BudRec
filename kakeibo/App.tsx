import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Animated, AppState, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { createNavigationContainerRef, NavigationContainer } from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { Ionicons } from '@expo/vector-icons';
import HomeScreen from './screens/HomeScreen';
import CameraScreen from './screens/CameraScreen';
import SummaryScreen from './screens/SummaryScreen';
import UserSetupScreen from './screens/UserSetupScreen';
import ErrorBoundary from './components/ErrorBoundary';
import { handleAuthCallback, isSignedIn, AuthError } from './services/AuthService';
import { getCurrentUserRaw, isUserNameSet } from './services/UserService';
import { runGmailImport } from './services/GmailService';
import { flushWriteQueue, registerUser } from './services/SheetsService';
import { loadConfig as loadDemoConfig } from './services/DemoService';
import * as OcrWorker from './services/OcrWorker';
import { registerBackgroundOcr } from './services/BackgroundOcr';

const Tab = createBottomTabNavigator();
const navigationRef = createNavigationContainerRef();

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
  // 初回起動時（再インストール直後含む）はユーザー名が保存されるまで
  // アプリ本体へ進ませない。既定名のまま Gmail 取り込みが走るのを防ぐ
  const [userNameSet, setUserNameSet] = useState(false);
  const lastGmailRunRef = useRef(0);

  // 書き込み中ステータスと成功トースト（画面遷移をまたいで表示するためここで管理）
  const [ocrStatus, setOcrStatus] = useState('');
  // 同じ文面が続いても出し直せるよう連番を持つ
  const [ocrToast, setOcrToastState] = useState<{ text: string; id: number } | null>(null);
  const toastOpacity = useRef(new Animated.Value(0)).current;
  const toastSeq = useRef(0);
  const setOcrToast = (text: string) => setOcrToastState({ text, id: ++toastSeq.current });

  // 裏の OCR の進み具合。撮影タブには専用の表示があるので、それ以外のタブで上部に出す
  const [currentRoute, setCurrentRoute] = useState<string | undefined>();
  const [ocrProgress, setOcrProgress]   = useState<OcrWorker.WorkerProgress>(OcrWorker.getProgress());

  useEffect(() => {
    if (!ocrToast) return;
    Animated.timing(toastOpacity, { toValue: 1, duration: 200, useNativeDriver: true }).start();
    const timer = setTimeout(() => {
      Animated.timing(toastOpacity, { toValue: 0, duration: 300, useNativeDriver: true })
        .start(({ finished }) => { if (finished) setOcrToastState(null); });
    }, 4000);
    return () => clearTimeout(timer);
  }, [ocrToast, toastOpacity]);

  useEffect(() => OcrWorker.subscribe((e) => {
    if (e.type === 'saved') setOcrToast(e.message);
    if (e.type === 'auth-failed') {
      // 画像は OCR 待ちのまま残るので、再サインイン後に続きから処理される
      Alert.alert('再サインインが必要です', 'セッションが期限切れです。再度サインインしてください。', [
        { text: 'OK', onPress: () => setSignedIn(false) },
      ]);
    }
    setOcrProgress(OcrWorker.getProgress());
  }), []);

  const goToSummary = () => {
    setOcrToastState(null);
    if (navigationRef.isReady()) navigationRef.navigate('Summary' as never);
  };

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
      const [ok, named] = await Promise.all([isSignedIn(), isUserNameSet()]);
      setSignedIn(ok);
      setUserNameSet(named);
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

  /**
   * 通信が戻ったであろうタイミングでの同期。
   * 未送信の書き込みを先に片付けてから Gmail 取り込みを走らせる
   * （逆順だと取り込みのリクエストで枠を使い切って未送信が残りやすい）。
   */
  const syncPending = () => {
    flushWriteQueue()
      .catch(async (e) => {
        console.warn('[App] 未送信の書き込みを送れなかった:', e instanceof Error ? e.message : e);
        // セッションが本当に切れている場合はサインアウト状態にして再ログインを促す
        // （それ以外の一時的な失敗は WriteQueue に残ったまま次回の自動送信に任せる）
        if (e instanceof AuthError) {
          const ok = await isSignedIn();
          if (!ok) setSignedIn(false);
        }
      })
      .finally(() => maybeRunGmailImport());
  };

  // サインイン直後に実行（ユーザー名が設定されるまでは取り込みを走らせない）
  useEffect(() => {
    if (!signedIn || !userNameSet) return;
    syncPending();
    // 前回 OCR 待ちのまま終了された画像の続き（中止・失敗したものは対象外）
    OcrWorker.kick();
    // 無料枠切れで推定待ちになった画像を、アプリを開いていなくても処理し直す
    registerBackgroundOcr();
    // 代理入力の相手の候補として、この端末のユーザー名を共有の一覧に載せる
    getCurrentUserRaw()
      .then((name) => registerUser(name))
      .catch((e) => console.warn('[App] ユーザー名を登録できなかった:', e instanceof Error ? e.message : e));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signedIn, userNameSet]);

  // フォアグラウンド復帰時にも実行（トークン有効性を再確認してから）
  useEffect(() => {
    if (!signedIn || !userNameSet) return;
    const sub = AppState.addEventListener('change', async (state) => {
      if (state !== 'active') return;
      const ok = await isSignedIn();
      if (!ok) {
        setSignedIn(false);
        return;
      }
      syncPending();
      // 推定待ちの時刻を過ぎていれば OCR を再開する
      OcrWorker.kick();
    });
    return () => sub.remove();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signedIn, userNameSet]);

  return (
    <SafeAreaProvider>
      {checking ? (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          <ActivityIndicator />
        </View>
      ) : !signedIn ? (
        <HomeScreen onSignedIn={() => setSignedIn(true)} />
      ) : !userNameSet ? (
        <UserSetupScreen onDone={() => setUserNameSet(true)} />
      ) : (
        <NavigationContainer
          ref={navigationRef}
          onReady={() => setCurrentRoute(navigationRef.getCurrentRoute()?.name)}
          onStateChange={() => setCurrentRoute(navigationRef.getCurrentRoute()?.name)}
        >
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
      {/* 書き込み中・OCR 処理中バナー（全画面共通） */}
      {(() => {
        const text = ocrStatus || (
          ocrProgress.running && signedIn && userNameSet && currentRoute !== 'Camera'
            ? `OCR処理中 ${Math.min(ocrProgress.done + 1, ocrProgress.total)}/${ocrProgress.total}`
            : ''
        );
        return !!text && (
          <View style={styles.statusBanner} pointerEvents="none">
            <ActivityIndicator color="#fff" size="small" />
            <Text style={styles.statusBannerText}>{text}</Text>
          </View>
        );
      })()}

      {/* 成功トースト（全画面共通） */}
      {!!ocrToast && (
        <Animated.View style={[styles.toast, { opacity: toastOpacity }]} pointerEvents="box-none">
          {/* 文面はタッチを受けない（下の「要確認」バナーやヘッダーを塞がない） */}
          <View pointerEvents="none">
            <Text style={styles.toastText}>{ocrToast.text}</Text>
          </View>
          {currentRoute !== 'Summary' && (
            <TouchableOpacity style={styles.toastBtn} onPress={goToSummary}>
              <Text style={styles.toastBtnText}>一覧へ</Text>
            </TouchableOpacity>
          )}
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
  toastBtn: {
    alignSelf:       'center',
    marginTop:       10,
    backgroundColor: '#fff',
    borderRadius:    8,
    paddingHorizontal: 20,
    paddingVertical:   6,
  },
  toastBtnText: {
    color:      '#15803d',
    fontSize:   14,
    fontWeight: 'bold',
  },
});
