import { useCallback, useEffect, useRef, useState } from 'react';
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
import { appendRow, ExpenseRow } from '../services/SheetsService';
import { AuthError } from '../services/AuthService';
import { getCurrentUser } from '../services/UserService';
import { getProvider } from '../providers';
import * as ReceiptQueue from '../services/ReceiptQueueService';

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

export default function CameraScreen({ onSignedOut, onStatusChange, onSuccess }: Props) {
  const navigation = useNavigation();
  const [permission, requestPermission] = useCameraPermissions();
  const [facing] = useState<CameraType>('back');
  const [busy, setBusy]           = useState(false);
  const [statusMsg, setStatusMsg] = useState<string>('');
  const cameraRef                 = useRef<CameraView>(null);

  // 未処理レシートの URI 一覧
  const [pendingUris, setPendingUris] = useState<string[]>([]);
  // 手動入力モーダルの対象レシート
  const [manualTarget, setManualTarget] = useState<string | null>(null);

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

  /** OCR → スプレッドシート書き込み。成功時は通知メッセージを返す。例外は投げるのみ */
  const runOcrAndSave = async (base64: string): Promise<string> => {
    setStatusMsg('OCR解析中...');
    onStatusChange('OCR解析中...');
    const categories = await CategoryService.getCategories();
    const provider = getProvider();
    const data = await provider.extractReceipt(base64, categories);

    setStatusMsg('書き込み中...');
    onStatusChange('スプレッドシートに書き込み中...');
    const timestamp = formatTimestamp(data.date, data.time);
    const user = await getCurrentUser();
    const row: ExpenseRow = {
      timestamp,
      source:        'camera',
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
    await appendRow(row);
    return `記録しました\n${data.store}  ¥${data.amount.toLocaleString()}\n${data.category} · ${timestamp}`;
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
   */
  const processReceipt = async (uri: string) => {
    setBusy(true);
    setStatusMsg('OCR解析中...');
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
        return;
      }

      try {
        const msg = await runOcrAndSave(base64);
        ReceiptQueue.deleteReceipt(uri);
        refreshPending();
        onSuccess(msg);
        return;
      } catch (firstErr) {
        if (firstErr instanceof AuthError) throw firstErr;
        console.warn('[Receipt] OCR 1回目失敗、リトライ:', firstErr);
      }

      // 自動リトライ
      setStatusMsg('OCR再試行中...');
      onStatusChange('OCR再試行中...');
      await new Promise((r) => setTimeout(r, 1000));
      try {
        const msg = await runOcrAndSave(base64);
        ReceiptQueue.deleteReceipt(uri);
        refreshPending();
        onSuccess(msg);
      } catch (secondErr) {
        if (secondErr instanceof AuthError) throw secondErr;
        const msg = secondErr instanceof Error ? secondErr.message : String(secondErr);
        showFailureDialog(uri, msg);
      }
    } catch (e) {
      if (e instanceof AuthError) {
        Alert.alert('再サインインが必要です', 'セッションが期限切れです。再度サインインしてください。', [
          { text: 'OK', onPress: onSignedOut },
        ]);
      }
    } finally {
      setBusy(false);
      setStatusMsg('');
      onStatusChange('');
    }
  };

  const handleShoot = async () => {
    if (!cameraRef.current || busy) return;
    setBusy(true);
    setStatusMsg('撮影中...');

    try {
      const photo = await cameraRef.current.takePictureAsync({
        base64:  true,
        quality: 0.6,
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

    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      base64: true,
      quality: 0.8,
      allowsMultipleSelection: false,
    });

    if (result.canceled || !result.assets[0]?.base64) return;

    try {
      const uri = ReceiptQueue.saveReceipt(result.assets[0].base64);
      refreshPending();
      navigation.navigate('Summary' as never);
      await processReceipt(uri);
    } catch (e) {
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
      await processReceipt(uri);
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

  /** 手動入力モーダルから保存 */
  const handleManualSave = async (entry: ExpenseRow) => {
    if (!manualTarget) return;
    try {
      await appendRow(entry);
      ReceiptQueue.deleteReceipt(manualTarget);
      setManualTarget(null);
      refreshPending();
      onSuccess(`手動入力を記録しました\n${entry.store}  ¥${entry.amount.toLocaleString()}`);
      navigation.navigate('Summary' as never);
    } catch (e) {
      if (e instanceof AuthError) {
        Alert.alert('再サインインが必要です', 'セッションが期限切れです。再度サインインしてください。', [
          { text: 'OK', onPress: onSignedOut },
        ]);
        return;
      }
      Alert.alert('保存失敗', e instanceof Error ? e.message : String(e));
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
}: {
  imageUri: string | null;
  onClose:  () => void;
  onSave:   (entry: ExpenseRow) => void;
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
    getCurrentUser().then(setCurrentUserState).catch(() => setCurrentUserState(''));
    CategoryService.getCategories()
      .then(setCategories)
      .catch(() => setCategories([]));
  }, [imageUri]);

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
      source:        'manual',
      user:          currentUser,
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
          <Text style={styles.modalHeaderTitle}>手動入力</Text>
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

/**
 * レシートから抽出した日付・時刻で 'YYYY/MM/DD HH:MM:SS' 形式の timestamp を作る。
 */
function formatTimestamp(receiptDate: string, receiptTime?: string): string {
  const now = new Date();
  const datePart = /^\d{4}-\d{2}-\d{2}$/.test(receiptDate)
    ? receiptDate.replace(/-/g, '/')
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
