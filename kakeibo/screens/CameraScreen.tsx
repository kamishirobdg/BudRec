import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Button,
  FlatList,
  KeyboardAvoidingView,
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
import { ExpenseRow, getUniqueUsers } from '../services/SheetsService';
import { AuthError } from '../services/AuthService';
import { getCurrentUser } from '../services/UserService';
import * as ReceiptQueue from '../services/ReceiptQueueService';
import * as OcrWorker from '../services/OcrWorker';
import { saveReceiptRows } from '../services/ReceiptProcessing';
import ReceiptReviewModal from './ReceiptReviewModal';
import PendingReceiptsModal from './PendingReceiptsModal';
import ZoomableImage from '../components/ZoomableImage';

// 通知ハンドラ: フォアグラウンド時もバナーとリストに表示する。
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

export default function CameraScreen({ onSignedOut, onStatusChange, onSuccess }: Props) {
  const navigation = useNavigation();
  const [permission, requestPermission] = useCameraPermissions();
  const [facing] = useState<CameraType>('back');
  // 撮影・ギャラリー選択の最中だけ立てる。OCR の処理中も次を撮れる
  const [capturing, setCapturing] = useState(false);
  const cameraRef                 = useRef<CameraView>(null);

  // 画像キューと裏の OCR の状態
  const [items, setItems]       = useState<ReceiptQueue.ReceiptItem[]>([]);
  const [progress, setProgress] = useState<OcrWorker.WorkerProgress>(OcrWorker.getProgress());
  const [listOpen, setListOpen] = useState(false);

  // 手動入力・確認の対象
  const [manualTarget, setManualTarget] = useState<ReceiptQueue.ReceiptItem | null>(null);
  const [review, setReview]             = useState<ReceiptQueue.ReceiptItem | null>(null);
  const [reviewBusy, setReviewBusy]     = useState(false);

  // 代理入力モード
  const [proxyMode, setProxyMode] = useState(false);
  const [proxyUser, setProxyUser] = useState('');

  // 通知権限を起動時にリクエスト（OCR 処理中の常駐通知を出すため。拒否されても OCR は動く）
  useEffect(() => {
    Notifications.requestPermissionsAsync().catch(() => {});
  }, []);

  const refresh = useCallback(() => {
    try {
      setItems(ReceiptQueue.listItems());
    } catch {
      setItems([]);
    }
    setProgress(OcrWorker.getProgress());
  }, []);

  useEffect(() => {
    refresh();
    return OcrWorker.subscribe(refresh);
  }, [refresh]);

  const attention = items.filter((i) => i.status !== 'queued');

  useEffect(() => {
    if (listOpen && attention.length === 0) setListOpen(false);
  }, [listOpen, attention.length]);

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

  /** 撮影時点の代理相手で積む（後から代理入力を切り替えても変わらない） */
  const enqueue = (base64: string) => {
    OcrWorker.enqueue(base64, proxyMode ? proxyUser : undefined);
  };

  const handleShoot = async () => {
    if (!cameraRef.current || capturing) return;
    setCapturing(true);
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
      enqueue(photo.base64);
    } catch (e) {
      Alert.alert('失敗', e instanceof Error ? e.message : String(e));
    } finally {
      setCapturing(false);
    }
  };

  const handlePickImage = async () => {
    if (capturing) return;
    // ピッカーが実際に開くまでの間も連打で多重起動されないようにする（撮影ボタンと同様）
    setCapturing(true);
    try {
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        base64: true,
        quality: 0.9,
        allowsMultipleSelection: false,
      });
      if (result.canceled || !result.assets[0]?.base64) return;
      enqueue(result.assets[0].base64);
    } catch (e) {
      Alert.alert('失敗', e instanceof Error ? e.message : String(e));
    } finally {
      setCapturing(false);
    }
  };

  const handleDiscard = (item: ReceiptQueue.ReceiptItem) => {
    Alert.alert('破棄しますか？', undefined, [
      { text: 'キャンセル', style: 'cancel' },
      {
        text: '破棄する',
        style: 'destructive',
        onPress: () => {
          ReceiptQueue.deleteReceipt(item.uri);
          refresh();
        },
      },
    ]);
  };

  /** 要確認の全破棄（2 段階確認）。OCR 待ちの画像には触らない */
  const handleDiscardAll = () => {
    if (attention.length === 0) return;
    const targets = [...attention];
    Alert.alert(
      '全て破棄しますか？',
      `${targets.length} 件の画像を全て削除します。`,
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
                    for (const t of targets) ReceiptQueue.deleteReceipt(t.uri);
                    setListOpen(false);
                    refresh();
                  },
                },
              ],
            );
          },
        },
      ],
    );
  };

  const showAuthAlert = () => {
    Alert.alert('再サインインが必要です', 'セッションが期限切れです。再度サインインしてください。', [
      { text: 'OK', onPress: onSignedOut },
    ]);
  };

  /** 確認・手動入力から保存する。成功したら画像を消す */
  const saveFromItem = async (uri: string, rows: ExpenseRow[]): Promise<boolean> => {
    onStatusChange(
      rows.length > 1
        ? `スプレッドシートに書き込み中... (${rows.length}件)`
        : 'スプレッドシートに書き込み中...',
    );
    try {
      const { message: msg, entryIds } = await saveReceiptRows(rows);
      ReceiptQueue.completeReceipt(uri, entryIds);
      refresh();
      onSuccess(msg);
      return true;
    } catch (e) {
      if (e instanceof AuthError) {
        showAuthAlert();
        return false;
      }
      Alert.alert('保存失敗', e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      onStatusChange('');
    }
  };

  /** 読み取り結果の確認モーダルで「登録する」 */
  const handleReviewCommit = async (kept: ExpenseRow[]) => {
    if (!review) return;

    // 全部「登録しない」＝このレシートは要らない。画像ごと片付ける
    if (kept.length === 0) {
      ReceiptQueue.deleteReceipt(review.uri);
      setReview(null);
      refresh();
      return;
    }

    setReviewBusy(true);
    try {
      if (await saveFromItem(review.uri, kept)) setReview(null);
    } finally {
      setReviewBusy(false);
    }
  };

  /** 手動入力モーダルから保存 */
  const handleManualSave = async (entry: ExpenseRow) => {
    if (!manualTarget) return;
    if (await saveFromItem(manualTarget.uri, [entry])) setManualTarget(null);
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

      {/* 中止・失敗・確認待ちの画像 */}
      {attention.length > 0 && (
        <TouchableOpacity style={styles.pendingBanner} onPress={() => setListOpen(true)}>
          <Text style={styles.pendingBannerText}>要確認 {attention.length} 件</Text>
          <Text style={styles.pendingBannerChevron}>›</Text>
        </TouchableOpacity>
      )}

      <View style={styles.overlay}>
        {progress.running && (
          <View style={styles.statusBox}>
            <ActivityIndicator color="#fff" />
            <Text style={styles.statusText}>
              OCR処理中 {Math.min(progress.done + 1, progress.total)}/{progress.total}
            </Text>
            <TouchableOpacity style={styles.cancelOcrBtn} onPress={OcrWorker.cancel}>
              <Text style={styles.cancelOcrBtnText}>中止</Text>
            </TouchableOpacity>
          </View>
        )}
        <View style={styles.buttonRow}>
          <TouchableOpacity
            style={[styles.shootBtn, capturing && styles.btnDisabled]}
            onPress={handleShoot}
            disabled={capturing}
          >
            <Text style={styles.shootBtnText}>撮影して記録</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.galleryBtn, capturing && styles.btnDisabled]}
            onPress={handlePickImage}
            disabled={capturing}
          >
            <Text style={styles.galleryBtnText}>ギャラリーから選択</Text>
          </TouchableOpacity>
        </View>
      </View>

      <PendingReceiptsModal
        visible={listOpen}
        items={attention}
        onClose={() => setListOpen(false)}
        onResume={(item) => OcrWorker.requeue([item.uri])}
        onResumeAll={() => {
          OcrWorker.requeue(attention.filter((i) => i.status !== 'review').map((i) => i.uri));
          setListOpen(false);
        }}
        onManual={(item) => { setListOpen(false); setManualTarget(item); }}
        onReview={(item) => { setListOpen(false); setReview(item); }}
        onDiscard={handleDiscard}
        onDiscardAll={handleDiscardAll}
      />

      <ManualEntryModal
        imageUri={manualTarget?.uri ?? null}
        onClose={() => setManualTarget(null)}
        onSave={handleManualSave}
        proxyUser={manualTarget?.proxyUser}
      />

      {/* 複数レシートを読み取ったときの確認・編集 */}
      <ReceiptReviewModal
        visible={review !== null}
        title="読み取り結果の確認"
        rows={review?.rows ?? []}
        mode="confirm"
        busy={reviewBusy}
        onClose={() => setReview(null)}
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

        {/* Modal 内では Android の adjustResize が効かないため、キーボードぶんの高さを
            自前で削る。包まないと下部の金額・メモがキーボードに隠れて見えない
            （明細編集・読み取り確認モーダルと同じ対策） */}
        <KeyboardAvoidingView style={styles.fill} behavior="height">
          {/* 入力中も見えるよう、画像はスクロールさせず上部に固定する */}
          <View style={styles.manualImageBox}>
            <ZoomableImage uri={imageUri} height={220} />
          </View>
          <ScrollView
            style={styles.fill}
            contentContainerStyle={styles.manualScroll}
            keyboardShouldPersistTaps="handled"
          >
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
          </ScrollView>
        </KeyboardAvoidingView>
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

function pad(n: number): string {
  return String(n).padStart(2, '0');
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
    marginBottom:      16,
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
  btnDisabled: { opacity: 0.5 },
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
  pendingBannerChevron: {
    color: '#1f2937',
    fontSize: 22,
    fontWeight: 'bold',
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
  fill: { flex: 1 },
  manualScroll: { padding: 16 },
  manualImageBox: { paddingHorizontal: 16, paddingTop: 12 },

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
