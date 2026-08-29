import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Button,
  FlatList,
  Image,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
  CameraView,
  CameraType,
  useCameraPermissions,
} from 'expo-camera';
import * as ImagePicker from 'expo-image-picker';
import * as Notifications from 'expo-notifications';
import { useNavigation } from '@react-navigation/native';
import * as CategoryService from '../services/CategoryService';
import { appendRow, ExpenseRow, getUniqueUsers } from '../services/SheetsService';
import { QueuedWriteError } from '../services/WriteQueueService';
import { AuthError } from '../services/AuthService';
import { getCurrentUser } from '../services/UserService';
import { getProvider } from '../providers';
import type { ReceiptData } from '../providers';
import { CancelledError } from '../providers/AIProvider';
import * as ReceiptQueue from '../services/ReceiptQueueService';
import * as LastBatch from '../services/LastBatchService';
import * as Demo from '../services/DemoService';
import ReceiptReviewModal from './ReceiptReviewModal';

// 通知ハンドラ: フォアグラウンド時もバナーとリストに表示する。
// タブ切替・バックグラウンド移行時に OCR 処理の進捗と結果を見せるため。
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert:  true,
    shouldShowBanner: true,
    shouldShowList:   true,
    shouldPlaySound:  false,
    shouldSetBadge:   false,
  }),
});

interface Props {
  onSignedOut:    () => void;
  onStatusChange: (msg: string) => void;
  onSuccess:      (msg: string) => void;
}

/** 保存前に確認してもらう読み取り結果 */
interface ReviewTarget {
  /** 元のレシート画像。保存するか捨てるまで pending に残す */
  uri:  string;
  rows: ExpenseRow[];
}

export default function CameraScreen({ onSignedOut, onStatusChange, onSuccess }: Props) {
  const navigation = useNavigation();
  const [permission, requestPermission] = useCameraPermissions();
  const [facing] = useState<CameraType>('back');
  const [busy, setBusy]           = useState(false);
  const [statusMsg, setStatusMsg] = useState<string>('');
  const cameraRef                 = useRef<CameraView>(null);

  // OCR 中の中止用。429 が続くとモデルを乗り換えながら数分粘ることがあるので、
  // 待たされ続けるより諦められるようにしておく（画像は pending に残るので後から再開できる）
  const ocrAbortRef = useRef<AbortController | null>(null);
  const [ocrCancellable, setOcrCancellable] = useState(false);

  // 未処理レシートの URI 一覧
  const [pendingUris, setPendingUris] = useState<string[]>([]);
  // 手動入力モーダルの対象レシート
  const [manualTarget, setManualTarget] = useState<string | null>(null);

  // 複数レシートを読み取ったときの確認対象（まだ書き込んでいない）
  const [review, setReview]         = useState<ReviewTarget | null>(null);
  const [reviewBusy, setReviewBusy] = useState(false);
  // 一括処理のループから同期的に見たいので ref にも持つ
  const reviewRef = useRef<ReviewTarget | null>(null);

  const openReview = (target: ReviewTarget) => {
    reviewRef.current = target;
    setReview(target);
  };
  const closeReview = () => {
    reviewRef.current = null;
    setReview(null);
  };

  // 代理入力モード
  const [proxyMode, setProxyMode] = useState(false);
  const [proxyUser, setProxyUser] = useState('');

  // 通知権限を起動時にリクエスト（通知なしでも動作するので静かに）
  useEffect(() => {
    Notifications.requestPermissionsAsync().catch(() => {});
  }, []);

  /** pending-receipts ディレクトリを読み直して state に反映 */
  const refreshPending = useCallback(() => {
    try {
      setPendingUris(ReceiptQueue.listPendingReceipts());
    } catch {
      setPendingUris([]);
    }
  }, []);

  // マウント時に未処理レシートをスキャン
  useEffect(() => {
    refreshPending();
  }, [refreshPending]);

  const handleProxyToggle = useCallback(async () => {
    if (proxyMode) {
      setProxyMode(false);
      setProxyUser('');
      return;
    }
    try {
      const currentUser = await getCurrentUser();
      const allUsers = await getUniqueUsers();
      const others = allUsers.filter((u) => u !== currentUser);
      if (others.length === 0) {
        Alert.alert('代理入力', '他のユーザーが見つかりません。相手のユーザーが入力を行った後に利用できます。');
        return;
      }
      if (others.length === 1) {
        setProxyUser(others[0]);
        setProxyMode(true);
        return;
      }
      Alert.alert(
        '代理入力するユーザーを選択',
        '',
        others.map((u) => ({ text: u, onPress: () => { setProxyUser(u); setProxyMode(true); } })),
      );
    } catch {
      Alert.alert('エラー', '代理入力の設定に失敗しました');
    }
  }, [proxyMode]);

  useLayoutEffect(() => {
    navigation.setOptions({
      headerRight: () => (
        <TouchableOpacity
          style={[styles.proxyHeaderBtn, proxyMode && styles.proxyHeaderBtnActive]}
          onPress={handleProxyToggle}
        >
          <Text style={[styles.proxyHeaderBtnText, proxyMode && styles.proxyHeaderBtnTextActive]}>
            {proxyMode ? `代理: ${proxyUser}` : '代理入力'}
          </Text>
        </TouchableOpacity>
      ),
    });
  }, [navigation, proxyMode, proxyUser, handleProxyToggle]);

  /**
   * 行をスプレッドシートに書き込む。1 件でも入れば成功として扱い、結果メッセージを返す。
   * 全滅したときだけ例外を投げる。
   */
  const saveRows = async (rows: ExpenseRow[]): Promise<string> => {
    setStatusMsg(rows.length > 1 ? `書き込み中... (${rows.length}件)` : '書き込み中...');
    onStatusChange(
      rows.length > 1
        ? `スプレッドシートに書き込み中... (${rows.length}件)`
        : 'スプレッドシートに書き込み中...',
    );

    const saved: ExpenseRow[] = [];
    let queued = 0;
    let failed = 0;

    for (const row of rows) {
      try {
        await appendRow(row);
        saved.push(row);
      } catch (e) {
        // 通信できないだけなら端末に退避済み。OCR をやり直させる必要はない
        if (e instanceof QueuedWriteError) {
          saved.push(row);
          queued++;
          continue;
        }
        // 再サインインが必要なら残りも全部失敗するので即中断する
        if (e instanceof AuthError) throw e;
        // 1 件の失敗で他のレシートまで巻き添えにしない。件数だけ伝える
        console.error('[Receipt] 1件の書き込みに失敗:', e);
        failed++;
      }
    }

    if (saved.length === 0) throw new Error('スプレッドシートに書き込めませんでした');
    // 一覧の「前回の登録」から後で見直せるようにする。
    // デモ中は appendRow がメモリ上のオーバーレイに積むだけで実データは書かれないが、
    // saved にはマスク前の実データ（店名・金額）が入っているため、
    // ここに保存すると端末ファイルに実データが残ってしまう。デモ中は保存しない
    if (!(await Demo.isDemo())) LastBatch.saveLastBatch(saved);
    return buildSaveMessage(saved, queued, failed);
  };

  /**
   * OCR して行を組み立てる。
   * - 1 件だけならそのまま書き込み、通知メッセージを返す
   * - **複数件なら確認モーダルを開いて null を返す**（誤読が起きやすいので保存前に見せる）
   */
  const attemptReceipt = async (base64: string, uri: string): Promise<string | null> => {
    setStatusMsg('OCR解析中...');
    onStatusChange('OCR解析中...');
    const categories = await CategoryService.getCategories();
    const provider = getProvider();
    const receipts = await provider.extractReceipts(base64, categories, ocrAbortRef.current?.signal);

    // 金額を読めなかったものは捨てる（0 円の行を作らない）
    const valid = receipts.filter((r) => r.amount > 0);
    if (valid.length === 0) throw new Error('レシートを読み取れませんでした');

    const user   = proxyMode ? proxyUser : await getCurrentUser();
    const source = proxyMode ? 'proxy_camera' : 'camera';
    const rows   = valid.map((data) => toExpenseRow(data, user, source));

    if (rows.length > 1) {
      openReview({ uri, rows });
      return null;
    }
    return saveRows(rows);
  };

  /** 2 回失敗時のダイアログ（再試行 / 手動入力 / 諦める） */
  const showFailureDialog = (uri: string, msg: string) => {
    Alert.alert(
      'OCR失敗',
      `2 回試行しましたが失敗しました:\n${msg}`,
      [
        {
          text: '再試行',
          onPress: () => {
            processReceipt(uri);
          },
        },
        {
          text: '手動入力',
          onPress: () => setManualTarget(uri),
        },
        {
          text: '諦める',
          style: 'destructive',
          onPress: () => {
            ReceiptQueue.deleteReceipt(uri);
            refreshPending();
          },
        },
      ],
      { cancelable: false },
    );
  };

  /**
   * 保存済みレシートファイルを OCR 処理する。
   * 失敗時は 1 秒待って 1 回だけ自動リトライ。それでも失敗なら 3 択ダイアログ。
   *
   * 戻り値は一括処理のループを止めるかどうかの判断に使う:
   * - `auth-failed` … 残り全件も同じ理由で失敗するので、Alert を連発させず打ち切る
   * - `cancelled`   … ユーザーが中止したので残りも処理しない（画像は pending に残す）
   */
  const processReceipt = async (uri: string): Promise<'ok' | 'auth-failed' | 'cancelled'> => {
    setBusy(true);
    setStatusMsg('OCR解析中...');
    // キャンセルボタン用。1 枚ごとに作り直す
    const abort = new AbortController();
    ocrAbortRef.current = abort;
    setOcrCancellable(true);
    let result: 'ok' | 'auth-failed' | 'cancelled' = 'ok';
    try {
      let base64: string;
      try {
        base64 = ReceiptQueue.readReceipt(uri);
      } catch (e) {
        Alert.alert(
          'ファイル読み込み失敗',
          `画像ファイルが壊れています。破棄します。\n${e instanceof Error ? e.message : String(e)}`,
        );
        ReceiptQueue.deleteReceipt(uri);
        refreshPending();
        return 'ok';
      }

      try {
        const msg = await attemptReceipt(base64, uri);
        if (msg === null) return 'ok'; // 確認モーダル待ち。画像はモーダル側で片付ける
        ReceiptQueue.deleteReceipt(uri);
        refreshPending();
        onSuccess(msg);
        return 'ok';
      } catch (firstErr) {
        if (firstErr instanceof AuthError) throw firstErr;
        // 中止は「失敗」ではない。リトライもダイアログも出さず、画像は pending に残す
        if (firstErr instanceof CancelledError) return 'cancelled';
        console.warn('[Receipt] OCR 1回目失敗、リトライ:', firstErr);
      }

      // 自動リトライ
      setStatusMsg('OCR再試行中...');
      onStatusChange('OCR再試行中...');
      await new Promise((r) => setTimeout(r, 1000));
      if (abort.signal.aborted) return 'cancelled';
      try {
        const msg = await attemptReceipt(base64, uri);
        if (msg === null) return 'ok';
        ReceiptQueue.deleteReceipt(uri);
        refreshPending();
        onSuccess(msg);
      } catch (secondErr) {
        if (secondErr instanceof AuthError) throw secondErr;
        if (secondErr instanceof CancelledError) return 'cancelled';
        const msg = secondErr instanceof Error ? secondErr.message : String(secondErr);
        showFailureDialog(uri, msg);
      }
    } catch (e) {
      if (e instanceof AuthError) {
        result = 'auth-failed';
        Alert.alert('再サインインが必要です', 'セッションが期限切れです。再度サインインしてください。', [
          { text: 'OK', onPress: onSignedOut },
        ]);
      }
    } finally {
      ocrAbortRef.current = null;
      setOcrCancellable(false);
      setBusy(false);
      setStatusMsg('');
      onStatusChange('');
    }
    return result;
  };

  /** OCR 中止。通信を打ち切るだけで、画像は pending に残るので後から再開できる */
  const handleCancelOcr = () => {
    ocrAbortRef.current?.abort();
    setStatusMsg('中止しています...');
  };

  const handleShoot = async () => {
    if (!cameraRef.current || busy) return;
    setBusy(true);
    setStatusMsg('撮影中...');

    try {
      const photo = await cameraRef.current.takePictureAsync({
        base64:  true,
        // レシートの小さい文字が JPEG 圧縮で潰れると誤読になる。
        // 複数枚を 1 枚に収めた場合は特に効くので、多少サイズが増えても品質を優先する
        quality: 0.85,
        skipProcessing: true,
        shutterSound: false,
      });
      if (!photo?.base64) throw new Error('画像の取得に失敗しました');
      const uri = ReceiptQueue.saveReceipt(photo.base64);
      refreshPending();
      setBusy(false);
      setStatusMsg('');
      navigation.navigate('Summary' as never);
      await processReceipt(uri);
    } catch (e) {
      setBusy(false);
      setStatusMsg('');
      Alert.alert('失敗', e instanceof Error ? e.message : String(e));
    }
  };

  const handlePickImage = async () => {
    if (busy) return;
    // ピッカーが実際に開くまでの間も連打で多重起動されないようにする（撮影ボタンと同様）
    setBusy(true);

    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      base64: true,
      quality: 0.9,
      allowsMultipleSelection: false,
    });

    if (result.canceled || !result.assets[0]?.base64) {
      setBusy(false);
      return;
    }

    try {
      const uri = ReceiptQueue.saveReceipt(result.assets[0].base64);
      refreshPending();
      setBusy(false);
      navigation.navigate('Summary' as never);
      await processReceipt(uri);
    } catch (e) {
      setBusy(false);
      Alert.alert('失敗', e instanceof Error ? e.message : String(e));
    }
  };

  /** pending バナーから一括処理 */
  const handleProcessPending = async () => {
    if (busy || pendingUris.length === 0) return;
    navigation.navigate('Summary' as never);
    const snapshot = [...pendingUris];
    for (const uri of snapshot) {
      // 途中で失敗 → 3択ダイアログが出るのでそこで止まる。
      // ダイアログ閉じた後は refreshPending で次の件がバナーに残るのでユーザーが再開できる
      const outcome = await processReceipt(uri);
      // 再サインインが必要な状態では残りも必ず同じ理由で失敗するので Alert を件数分
      // 積まない。中止された場合も残りを続けない。どちらも残りはバナーに残る
      if (outcome !== 'ok') break;
      // 確認モーダルが開いたら残りは進めない（次の結果で上書きしてしまうため）
      if (reviewRef.current) break;
    }
  };

  /** pending 全破棄（2 段階確認） */
  const handleDiscardPending = () => {
    if (pendingUris.length === 0) return;
    Alert.alert(
      '全て破棄しますか？',
      `${pendingUris.length} 件の未処理レシートを全て削除します。`,
      [
        { text: 'キャンセル', style: 'cancel' },
        {
          text: '次へ',
          style: 'destructive',
          onPress: () => {
            Alert.alert(
              '本当に破棄しますか？',
              'この操作は取り消せません。',
              [
                { text: 'キャンセル', style: 'cancel' },
                {
                  text: '破棄する',
                  style: 'destructive',
                  onPress: () => {
                    ReceiptQueue.deleteAllReceipts();
                    refreshPending();
                  },
                },
              ],
            );
          },
        },
      ],
    );
  };

  /** 読み取り結果の確認モーダルで「登録する」 */
  const handleReviewCommit = async (kept: ExpenseRow[]) => {
    if (!review) return;

    // 全部「登録しない」＝このレシートは要らない。画像ごと片付ける
    if (kept.length === 0) {
      ReceiptQueue.deleteReceipt(review.uri);
      closeReview();
      refreshPending();
      return;
    }

    setReviewBusy(true);
    try {
      const msg = await saveRows(kept);
      ReceiptQueue.deleteReceipt(review.uri);
      closeReview();
      refreshPending();
      onSuccess(msg);
      navigation.navigate('Summary' as never);
    } catch (e) {
      if (e instanceof AuthError) {
        Alert.alert('再サインインが必要です', 'セッションが期限切れです。再度サインインしてください。', [
          { text: 'OK', onPress: onSignedOut },
        ]);
        return;
      }
      Alert.alert('保存失敗', e instanceof Error ? e.message : String(e));
    } finally {
      setReviewBusy(false);
      setStatusMsg('');
      onStatusChange('');
    }
  };

  /** 確認モーダルを閉じる（保存しない）。画像は残すので後から再処理できる */
  const handleReviewClose = () => {
    closeReview();
    refreshPending();
  };

  /** 手動入力モーダルから保存 */
  const handleManualSave = async (entry: ExpenseRow) => {
    if (!manualTarget) return;
    try {
      const message = await saveRows([entry]);
      ReceiptQueue.deleteReceipt(manualTarget);
      setManualTarget(null);
      refreshPending();
      onSuccess(message);
      navigation.navigate('Summary' as never);
    } catch (e) {
      if (e instanceof AuthError) {
        Alert.alert('再サインインが必要です', 'セッションが期限切れです。再度サインインしてください。', [
          { text: 'OK', onPress: onSignedOut },
        ]);
        return;
      }
      Alert.alert('保存失敗', e instanceof Error ? e.message : String(e));
    } finally {
      // saveRows が出した進捗バナーを消す
      setStatusMsg('');
      onStatusChange('');
    }
  };

  if (!permission) {
    return (
      <View style={styles.center}>
        <ActivityIndicator />
      </View>
    );
  }

  if (!permission.granted) {
    return (
      <View style={styles.center}>
        <Text style={styles.notice}>カメラの使用許可が必要です</Text>
        <Button title="許可する" onPress={requestPermission} />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <CameraView
        ref={cameraRef}
        style={styles.camera}
        facing={facing}
        enableTorch={false}
        mute
      />

      {/* 代理入力モードバナー */}
      {proxyMode && (
        <View style={styles.proxyBanner}>
          <Text style={styles.proxyBannerText}>代理入力中: {proxyUser}</Text>
        </View>
      )}

      {/* 未処理レシートバナー */}
      {pendingUris.length > 0 && !busy && (
        <View style={styles.pendingBanner}>
          <Text style={styles.pendingBannerText}>
            未処理レシート {pendingUris.length} 件
          </Text>
          <View style={styles.pendingBannerActions}>
            <TouchableOpacity
              style={styles.pendingBtn}
              onPress={handleProcessPending}
            >
              <Text style={styles.pendingBtnText}>処理する</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.pendingBtn, styles.pendingBtnDanger]}
              onPress={handleDiscardPending}
            >
              <Text style={[styles.pendingBtnText, styles.pendingBtnDangerText]}>
                破棄
              </Text>
            </TouchableOpacity>
          </View>
        </View>
      )}

      <View style={styles.overlay}>
        {busy ? (
          <View style={styles.statusBox}>
            <ActivityIndicator color="#fff" />
            <Text style={styles.statusText}>{statusMsg}</Text>
            {ocrCancellable && (
              <TouchableOpacity style={styles.cancelOcrBtn} onPress={handleCancelOcr}>
                <Text style={styles.cancelOcrBtnText}>中止</Text>
              </TouchableOpacity>
            )}
          </View>
        ) : (
          <View style={styles.buttonRow}>
            <TouchableOpacity style={styles.shootBtn} onPress={handleShoot}>
              <Text style={styles.shootBtnText}>撮影して記録</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.galleryBtn} onPress={handlePickImage}>
              <Text style={styles.galleryBtnText}>ギャラリーから選択</Text>
            </TouchableOpacity>
          </View>
        )}
      </View>

      <ManualEntryModal
        imageUri={manualTarget}
        onClose={() => setManualTarget(null)}
        onSave={handleManualSave}
        proxyUser={proxyMode ? proxyUser : undefined}
      />

      {/* 複数レシートを読み取ったときの確認・編集 */}
      <ReceiptReviewModal
        visible={review !== null}
        title="読み取り結果の確認"
        rows={review?.rows ?? []}
        mode="confirm"
        busy={reviewBusy}
        onClose={handleReviewClose}
        onCommit={handleReviewCommit}
      />
    </View>
  );
}

// ─── 手動入力モーダル ────────────────────────────────────────────────────────

const ADD_CATEGORY_SENTINEL = '__add_category__';

function ManualEntryModal({
  imageUri,
  onClose,
  onSave,
  proxyUser,
}: {
  imageUri:   string | null;
  onClose:    () => void;
  onSave:     (entry: ExpenseRow) => void;
  proxyUser?: string;
}) {
  const [timestamp, setTimestamp]   = useState('');
  const [store, setStore]           = useState('');
  const [category, setCategory]     = useState('');
  const [amount, setAmount]         = useState('');
  const [memo, setMemo]             = useState('');
  const [currentUser, setCurrentUserState] = useState('');

  const [categories, setCategories] = useState<string[]>([]);
  const [categoryPickerOpen, setCategoryPickerOpen] = useState(false);
  const [addCategoryOpen, setAddCategoryOpen]       = useState(false);
  const [newCategoryText, setNewCategoryText]       = useState('');
  const [savingCategory, setSavingCategory]         = useState(false);

  useEffect(() => {
    if (!imageUri) return;
    // 初期値は現在時刻
    const now = new Date();
    const ts =
      `${now.getFullYear()}/${pad(now.getMonth() + 1)}/${pad(now.getDate())} ` +
      `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
    setTimestamp(ts);
    setStore('');
    setCategory('');
    setAmount('');
    setMemo('');
    if (!proxyUser) {
      getCurrentUser().then(setCurrentUserState).catch(() => setCurrentUserState(''));
    }
    CategoryService.getCategories()
      .then(setCategories)
      .catch(() => setCategories([]));
  }, [imageUri, proxyUser]);

  if (!imageUri) return null;

  const handleSave = () => {
    const amt = Number(amount.replace(/[^\d]/g, ''));
    if (!Number.isFinite(amt) || amt <= 0) {
      Alert.alert('入力エラー', '金額を入力してください');
      return;
    }
    if (!store.trim()) {
      Alert.alert('入力エラー', '店舗を入力してください');
      return;
    }
    if (!category.trim()) {
      Alert.alert('入力エラー', 'カテゴリを選択してください');
      return;
    }
    onSave({
      timestamp,
      source:        proxyUser ? 'proxy_manual' : 'manual',
      user:          proxyUser ?? currentUser,
      store:         store.trim(),
      category:      category.trim(),
      amount:        amt,
      memo:          memo.trim(),
      countedAmount: amt,
      excluded:      false,
      confirmed:     false,
      recurring:     false,
    });
  };

  const handlePickCategory = (value: string) => {
    if (value === ADD_CATEGORY_SENTINEL) {
      setCategoryPickerOpen(false);
      setNewCategoryText('');
      setAddCategoryOpen(true);
      return;
    }
    setCategory(value);
    setCategoryPickerOpen(false);
  };

  const handleAddCategoryConfirm = async () => {
    const name = newCategoryText.trim();
    if (!name) {
      Alert.alert('入力エラー', 'カテゴリ名が空です');
      return;
    }
    setSavingCategory(true);
    try {
      await CategoryService.addCategory(name);
      const next = await CategoryService.getCategories();
      setCategories(next);
      setCategory(name);
      setAddCategoryOpen(false);
    } catch (e) {
      Alert.alert('追加失敗', e instanceof Error ? e.message : String(e));
    } finally {
      setSavingCategory(false);
    }
  };

  return (
    <Modal
      visible={imageUri !== null}
      animationType="slide"
      onRequestClose={onClose}
    >
      <SafeAreaView style={{ flex: 1, backgroundColor: '#fff' }}>
        <View style={styles.modalHeader}>
          <Text style={styles.modalHeaderTitle}>
            {proxyUser ? `手動入力（${proxyUser}の代理）` : '手動入力'}
          </Text>
          <Button title="閉じる" onPress={onClose} />
        </View>

        <ScrollView contentContainerStyle={styles.manualScroll}>
          <Image
            source={{ uri: imageUri }}
            style={styles.manualImage}
            resizeMode="contain"
          />

          <View style={styles.fieldBox}>
            <Text style={styles.fieldLabel}>日時</Text>
            <TextInput
              style={styles.fieldInput}
              value={timestamp}
              onChangeText={setTimestamp}
              placeholder="YYYY/MM/DD HH:MM:SS"
            />
          </View>

          <View style={styles.fieldBox}>
            <Text style={styles.fieldLabel}>店舗</Text>
            <TextInput
              style={styles.fieldInput}
              value={store}
              onChangeText={setStore}
            />
          </View>

          <View style={styles.fieldBox}>
            <Text style={styles.fieldLabel}>カテゴリ</Text>
            <TouchableOpacity
              style={styles.pickerButton}
              onPress={() => setCategoryPickerOpen(true)}
            >
              <Text style={styles.pickerButtonText}>
                {category || '(未選択)'} ▾
              </Text>
            </TouchableOpacity>
          </View>

          <View style={styles.fieldBox}>
            <Text style={styles.fieldLabel}>金額</Text>
            <TextInput
              style={styles.fieldInput}
              value={amount}
              onChangeText={setAmount}
              keyboardType="number-pad"
            />
          </View>

          <View style={styles.fieldBox}>
            <Text style={styles.fieldLabel}>メモ</Text>
            <TextInput
              style={[styles.fieldInput, { minHeight: 60, textAlignVertical: 'top' }]}
              value={memo}
              onChangeText={setMemo}
              multiline
            />
          </View>

          <View style={{ height: 8 }} />
          <Button title="保存" onPress={handleSave} />
          <Text style={styles.manualNote}>
            ※ 保存後にレシート画像は削除されます
          </Text>
        </ScrollView>
      </SafeAreaView>

      {/* カテゴリ選択モーダル */}
      <Modal
        visible={categoryPickerOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setCategoryPickerOpen(false)}
      >
        <Pressable
          style={styles.modalBackdrop}
          onPress={() => setCategoryPickerOpen(false)}
        >
          <Pressable style={styles.modalSheet} onPress={(e) => e.stopPropagation()}>
            <Text style={styles.modalTitle}>カテゴリを選択</Text>
            <FlatList
              data={[...categories, ADD_CATEGORY_SENTINEL]}
              keyExtractor={(c) => c}
              renderItem={({ item }) => {
                const isAdd = item === ADD_CATEGORY_SENTINEL;
                const isSelected = !isAdd && item === category;
                return (
                  <TouchableOpacity
                    style={[
                      styles.modalItem,
                      isSelected && styles.modalItemSelected,
                    ]}
                    onPress={() => handlePickCategory(item)}
                  >
                    <Text
                      style={[
                        styles.modalItemText,
                        isSelected && styles.modalItemTextSelected,
                        isAdd && styles.modalItemTextAdd,
                      ]}
                    >
                      {isAdd ? '＋ カテゴリを追加...' : item}
                    </Text>
                  </TouchableOpacity>
                );
              }}
            />
          </Pressable>
        </Pressable>
      </Modal>

      {/* カテゴリ追加モーダル */}
      <Modal
        visible={addCategoryOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setAddCategoryOpen(false)}
      >
        <Pressable
          style={styles.modalBackdrop}
          onPress={() => !savingCategory && setAddCategoryOpen(false)}
        >
          <Pressable style={styles.modalSheet} onPress={(e) => e.stopPropagation()}>
            <Text style={styles.modalTitle}>カテゴリを追加</Text>
            <View style={{ padding: 16 }}>
              <TextInput
                style={styles.fieldInput}
                value={newCategoryText}
                onChangeText={setNewCategoryText}
                placeholder="例: 趣味"
                autoFocus
                editable={!savingCategory}
              />
              <View style={{ height: 12 }} />
              <View style={{ flexDirection: 'row', justifyContent: 'flex-end', gap: 8 }}>
                <Button
                  title="キャンセル"
                  onPress={() => setAddCategoryOpen(false)}
                  disabled={savingCategory}
                />
                <Button
                  title={savingCategory ? '追加中...' : '追加'}
                  onPress={handleAddCategoryConfirm}
                  disabled={savingCategory}
                />
              </View>
            </View>
          </Pressable>
        </Pressable>
      </Modal>
    </Modal>
  );
}

// ─── utils ───────────────────────────────────────────────────────────────────

/** OCR 結果 1 件を書き込み用の行に変換する */
function toExpenseRow(data: ReceiptData, user: string, source: string): ExpenseRow {
  return {
    timestamp:     formatTimestamp(data.date, data.time),
    source,
    user,
    store:         data.store,
    category:      data.category,
    amount:        data.amount,
    memo:          summarizeItems(data.items),
    countedAmount: data.amount,
    excluded:      false,
    confirmed:     false,
    recurring:     false,
  };
}

/**
 * 保存結果をトーストの文面にする。
 * 1 件なら日時・カテゴリまで見せ、複数なら店名と金額を並べる。
 */
function buildSaveMessage(saved: ExpenseRow[], queued: number, failed: number): string {
  const notes: string[] = [];
  if (failed > 0) notes.push(`${failed}件は書き込めませんでした`);

  if (saved.length === 1) {
    const r = saved[0];
    return [
      queued > 0 ? '未送信で保存しました（通信が戻ったら自動送信）' : '記録しました',
      `${r.store || '(店名なし)'}  ¥${r.amount.toLocaleString()}`,
      `${r.category} · ${r.timestamp}`,
      ...notes,
    ].join('\n');
  }

  const lines = saved
    .slice(0, 3)
    .map((r) => `${r.store || '(店名なし)'}  ¥${r.amount.toLocaleString()}`);
  if (saved.length > 3) lines.push(`ほか ${saved.length - 3} 件`);
  if (queued > 0) notes.unshift(`うち ${queued} 件は未送信（通信が戻ったら自動送信）`);

  return [`${saved.length}件を記録しました`, ...lines, ...notes].join('\n');
}

/**
 * レシートの日付として受け入れる過去の幅（日）。
 * これより古いものは年の誤読とみなす。
 */
const MAX_PAST_DAYS = 400;

/**
 * レシートから抽出した日付・時刻で 'YYYY/MM/DD HH:MM:SS' 形式の timestamp を作る。
 * 日付は AIProvider 側で YYYY-MM-DD に正規化済み。ここでは採用してよい値かだけ見る。
 */
function formatTimestamp(receiptDate: string, receiptTime?: string): string {
  const now = new Date();
  const accepted = acceptableDate(receiptDate, now);
  const datePart = accepted
    ? accepted.replace(/-/g, '/')
    : `${now.getFullYear()}/${pad(now.getMonth() + 1)}/${pad(now.getDate())}`;
  let timePart: string;
  if (receiptTime && /^\d{1,2}:\d{2}(:\d{2})?$/.test(receiptTime)) {
    const [h, m, s] = receiptTime.split(':');
    timePart = `${pad(Number(h))}:${pad(Number(m))}:${pad(Number(s ?? 0))}`;
  } else {
    timePart = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  }
  return `${datePart} ${timePart}`;
}

/**
 * 読み取った日付を採用してよいか。駄目なら null（＝撮影日を使う）。
 *
 * 未来日は有効期限や次回来店期限を購入日と取り違えたケース、極端に古い日付は年の
 * 誤読が多い。そのまま書くと別の月シートに入って一覧から消えたように見えるので、
 * 撮影日に寄せる方が事故が小さい。
 */
function acceptableDate(date: string, now: Date): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;

  const [y, m, d] = date.split('-').map(Number);
  const parsed  = new Date(y, m - 1, d).getTime();
  const today   = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const diffDay = (parsed - today) / 86_400_000;

  if (diffDay > 1) { // 時差ぶんだけ 1 日は許容する
    console.warn('[OCR] 未来の日付だったので撮影日を使う:', date);
    return null;
  }
  if (diffDay < -MAX_PAST_DAYS) {
    console.warn('[OCR] 古すぎる日付だったので撮影日を使う:', date);
    return null;
  }
  return date;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function summarizeItems(items?: { name: string; price: number }[]): string {
  if (!items || items.length === 0) return '';
  return items.map((it) => `${it.name}:${it.price}`).join(', ');
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#000',
  },
  camera: {
    flex: 1,
  },
  overlay: {
    position: 'absolute',
    bottom:  32,
    left:    0,
    right:   0,
    alignItems: 'center',
  },
  statusBox: {
    flexDirection: 'row',
    alignItems:    'center',
    gap:           12,
    backgroundColor: 'rgba(0,0,0,0.6)',
    paddingHorizontal: 16,
    paddingVertical:   12,
    borderRadius:      8,
  },
  statusText: {
    color:    '#fff',
    fontSize: 14,
  },
  cancelOcrBtn: {
    borderWidth:  1,
    borderColor:  'rgba(255,255,255,0.6)',
    borderRadius: 14,
    paddingHorizontal: 12,
    paddingVertical:    4,
  },
  cancelOcrBtnText: { color: '#fff', fontSize: 13, fontWeight: 'bold' },
  buttonRow: {
    alignItems: 'center',
    gap: 12,
  },
  shootBtn: {
    backgroundColor: '#2563eb',
    paddingHorizontal: 32,
    paddingVertical: 14,
    borderRadius: 10,
  },
  shootBtnText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: 'bold',
  },
  galleryBtn: {
    backgroundColor: 'rgba(0,0,0,0.55)',
    paddingHorizontal: 24,
    paddingVertical: 10,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.4)',
  },
  galleryBtnText: {
    color: '#fff',
    fontSize: 14,
  },
  center: {
    flex: 1,
    backgroundColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 16,
    paddingHorizontal: 24,
  },
  notice: {
    textAlign: 'center',
    fontSize:  14,
    color:     '#666',
  },
  pendingBanner: {
    position: 'absolute',
    top: 48,
    left: 16,
    right: 16,
    backgroundColor: 'rgba(251, 191, 36, 0.95)',
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    elevation: 6,
  },
  proxyHeaderBtn: {
    marginRight: 12,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#888',
  },
  proxyHeaderBtnActive: {
    backgroundColor: '#16a34a',
    borderColor: '#16a34a',
  },
  proxyHeaderBtnText: {
    fontSize: 13,
    color: '#444',
  },
  proxyHeaderBtnTextActive: {
    color: '#fff',
    fontWeight: 'bold',
  },
  proxyBanner: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    backgroundColor: 'rgba(22, 163, 74, 0.9)',
    paddingHorizontal: 16,
    paddingVertical: 8,
    alignItems: 'center',
    zIndex: 10,
  },
  proxyBannerText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: 'bold',
  },
  pendingBannerText: {
    color: '#1f2937',
    fontSize: 14,
    fontWeight: 'bold',
    flexShrink: 1,
  },
  pendingBannerActions: {
    flexDirection: 'row',
    gap: 8,
  },
  pendingBtn: {
    backgroundColor: '#fff',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 6,
  },
  pendingBtnText: {
    color: '#1f2937',
    fontSize: 13,
    fontWeight: 'bold',
  },
  pendingBtnDanger: {
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#dc2626',
  },
  pendingBtnDangerText: {
    color: '#dc2626',
  },

  // 手動入力モーダル
  modalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#eee',
  },
  modalHeaderTitle: { fontSize: 18, fontWeight: 'bold' },
  manualScroll: { padding: 16 },
  manualImage: {
    width: '100%',
    height: 240,
    backgroundColor: '#f3f4f6',
    borderRadius: 8,
    marginBottom: 16,
  },
  manualNote: { fontSize: 11, color: '#888', marginTop: 12, textAlign: 'center' },

  fieldBox:   { marginBottom: 12 },
  fieldLabel: { fontSize: 12, color: '#666', marginBottom: 4 },
  fieldInput: {
    borderWidth: 1,
    borderColor: '#ccc',
    borderRadius: 6,
    paddingHorizontal: 12,
    paddingVertical: 8,
    fontSize: 15,
  },
  pickerButton: {
    borderWidth: 1,
    borderColor: '#ccc',
    borderRadius: 6,
    paddingHorizontal: 12,
    paddingVertical: 10,
    backgroundColor: '#fff',
  },
  pickerButtonText: { fontSize: 15, color: '#222' },

  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.4)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  modalSheet: {
    backgroundColor: '#fff',
    borderRadius: 12,
    width: '80%',
    maxHeight: '70%',
    paddingVertical: 12,
  },
  modalTitle: {
    fontSize: 16,
    fontWeight: 'bold',
    paddingHorizontal: 16,
    paddingBottom: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#eee',
  },
  modalItem: { paddingHorizontal: 16, paddingVertical: 12 },
  modalItemSelected: { backgroundColor: '#eaf2ff' },
  modalItemText: { fontSize: 15, color: '#222' },
  modalItemTextSelected: { color: '#2563eb', fontWeight: 'bold' },
  modalItemTextAdd: { color: '#2563eb', fontWeight: 'bold' },
});
