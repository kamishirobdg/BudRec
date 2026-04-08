import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Animated,
  Button,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import {
  CameraView,
  CameraType,
  useCameraPermissions,
} from 'expo-camera';
import { getCategories } from '../services/CategoryService';
import { appendRow, ExpenseRow } from '../services/SheetsService';
import { getCurrentUser } from '../services/UserService';
import { getProvider } from '../providers';

export default function CameraScreen() {
  const [permission, requestPermission] = useCameraPermissions();
  const [facing] = useState<CameraType>('back');
  const [busy, setBusy]       = useState(false);
  const [statusMsg, setStatusMsg] = useState<string>('');
  const [toast, setToast]     = useState<string>('');
  const toastOpacity          = useRef(new Animated.Value(0)).current;
  const cameraRef = useRef<CameraView>(null);

  // toast の表示・自動消滅
  useEffect(() => {
    if (!toast) return;
    Animated.timing(toastOpacity, {
      toValue: 1,
      duration: 200,
      useNativeDriver: true,
    }).start();
    const timer = setTimeout(() => {
      Animated.timing(toastOpacity, {
        toValue: 0,
        duration: 300,
        useNativeDriver: true,
      }).start(() => setToast(''));
    }, 3000);
    return () => clearTimeout(timer);
  }, [toast, toastOpacity]);

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

      setStatusMsg('OCR解析中...');
      const categories = await getCategories();
      const provider   = getProvider();
      const data = await provider.extractReceipt(photo.base64, categories);

      setStatusMsg('スプレッドシートに書き込み中...');
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
      };
      await appendRow(row);

      setStatusMsg('');
      setToast(
        `記録しました\n${data.store}  ¥${data.amount.toLocaleString()}\n${data.category} · ${timestamp}`,
      );
    } catch (e) {
      setStatusMsg('');
      const msg = e instanceof Error ? e.message : String(e);
      Alert.alert('失敗', msg);
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={styles.container}>
      <CameraView
        ref={cameraRef}
        style={styles.camera}
        facing={facing}
        enableTorch={false}
        mute
      />
      <View style={styles.overlay}>
        {busy ? (
          <View style={styles.statusBox}>
            <ActivityIndicator color="#fff" />
            <Text style={styles.statusText}>{statusMsg}</Text>
          </View>
        ) : (
          <Button title="撮影して記録" onPress={handleShoot} />
        )}
      </View>

      {!!toast && (
        <Animated.View
          pointerEvents="none"
          style={[styles.toast, { opacity: toastOpacity }]}
        >
          <Text style={styles.toastText}>{toast}</Text>
        </Animated.View>
      )}
    </View>
  );
}

/**
 * レシートから抽出した日付・時刻で 'YYYY/MM/DD HH:MM:SS' 形式の timestamp を作る。
 * 日付・時刻のいずれかが取れなかった場合は撮影時の値で補完する。
 * 秒は OCR から取れないので 00 固定。
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
  toast: {
    position: 'absolute',
    top:      48,
    left:     16,
    right:    16,
    backgroundColor: 'rgba(34,197,94,0.95)',
    borderRadius:    12,
    paddingHorizontal: 20,
    paddingVertical:   16,
    shadowColor:    '#000',
    shadowOpacity:  0.3,
    shadowRadius:   8,
    shadowOffset:   { width: 0, height: 4 },
    elevation:      8,
  },
  toastText: {
    color:      '#fff',
    fontSize:   16,
    fontWeight: 'bold',
    textAlign:  'center',
    lineHeight: 22,
  },
});
