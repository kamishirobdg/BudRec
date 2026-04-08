import { useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
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
import { getProvider } from '../providers';

// TODO: 設定画面でユーザー（夫/妻）を切り替えられるようにする
const DEFAULT_USER = '夫';

export default function CameraScreen() {
  const [permission, requestPermission] = useCameraPermissions();
  const [facing] = useState<CameraType>('back');
  const [busy, setBusy]       = useState(false);
  const [statusMsg, setStatusMsg] = useState<string>('');
  const cameraRef = useRef<CameraView>(null);

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
      const timestamp = formatTimestamp(data.date);
      const row: ExpenseRow = {
        timestamp,
        source:   'camera',
        user:     DEFAULT_USER,
        store:    data.store,
        category: data.category,
        amount:   data.amount,
        memo:     summarizeItems(data.items),
      };
      await appendRow(row);

      setStatusMsg('');
      Alert.alert(
        '記録しました',
        `${data.store}\n¥${data.amount.toLocaleString()} / ${data.category}\n${timestamp}`,
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
    </View>
  );
}

/** レシート日付（YYYY-MM-DD）+ 現在時刻で timestamp を組み立てる */
function formatTimestamp(receiptDate: string): string {
  const now  = new Date();
  const time = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
  // OCR が日付を取れなかった場合は今日の日付にフォールバック
  const date = /^\d{4}-\d{2}-\d{2}$/.test(receiptDate)
    ? receiptDate
    : `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  return `${date} ${time}`;
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
});
