import { FlatList, Image, Modal, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { ReceiptItem, ReceiptStatus } from '../services/ReceiptQueueService';

interface Props {
  visible:      boolean;
  /** 中止・失敗・確認待ちの画像（OCR 待ちは含めない） */
  items:        ReceiptItem[];
  onClose:      () => void;
  onResume:     (item: ReceiptItem) => void;
  onResumeAll:  () => void;
  onManual:     (item: ReceiptItem) => void;
  onReview:     (item: ReceiptItem) => void;
  onDiscard:    (item: ReceiptItem) => void;
  onDiscardAll: () => void;
}

const STATUS_LABEL: Record<ReceiptStatus, string> = {
  queued:   'OCR待ち',
  deferred: '推定待ち',
  stopped:  '中止',
  failed:   '失敗',
  review:   '確認待ち',
};

const STATUS_COLOR: Record<ReceiptStatus, string> = {
  queued:   '#6b7280',
  deferred: '#6b7280',
  stopped:  '#6b7280',
  failed:   '#dc2626',
  review:   '#2563eb',
};

/** 撮影画面の「要確認」から開く一覧。画像ごとに再開・手入力・確認・破棄を選ぶ */
export default function PendingReceiptsModal({
  visible, items, onClose, onResume, onResumeAll, onManual, onReview, onDiscard, onDiscardAll,
}: Props) {
  const resumable = items.some((i) => i.status !== 'review');

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <SafeAreaView style={styles.container}>
        <View style={styles.header}>
          <Text style={styles.title}>要確認</Text>
          <TouchableOpacity onPress={onClose}>
            <Text style={styles.headerBtn}>閉じる</Text>
          </TouchableOpacity>
        </View>

        {resumable && (
          <TouchableOpacity style={styles.resumeAllBtn} onPress={onResumeAll}>
            <Text style={styles.resumeAllText}>すべて再開</Text>
          </TouchableOpacity>
        )}

        <FlatList
          data={items}
          keyExtractor={(i) => i.uri}
          contentContainerStyle={styles.list}
          renderItem={({ item }) => (
            <View style={styles.row}>
              <Image source={{ uri: item.uri }} style={styles.thumb} resizeMode="cover" />
              <View style={styles.body}>
                <Text style={[styles.status, { color: STATUS_COLOR[item.status] }]}>
                  {STATUS_LABEL[item.status]}
                  {item.proxyUser ? `（${item.proxyUser}の代理）` : ''}
                </Text>
                {item.status === 'failed' && !!item.error && (
                  <Text style={styles.error} numberOfLines={2}>{item.error}</Text>
                )}
                {item.status === 'review' && (
                  <Text style={styles.sub}>{item.rows?.length ?? 0} 件を読み取り</Text>
                )}
                <View style={styles.actions}>
                  {item.status === 'review' ? (
                    <ActionBtn label="確認" primary onPress={() => onReview(item)} />
                  ) : (
                    <>
                      <ActionBtn label="再開" primary onPress={() => onResume(item)} />
                      <ActionBtn label="手入力" onPress={() => onManual(item)} />
                    </>
                  )}
                  <ActionBtn label="破棄" danger onPress={() => onDiscard(item)} />
                </View>
              </View>
            </View>
          )}
        />

        {items.length > 0 && (
          <TouchableOpacity style={styles.discardAllBtn} onPress={onDiscardAll}>
            <Text style={styles.discardAllText}>すべて破棄</Text>
          </TouchableOpacity>
        )}
      </SafeAreaView>
    </Modal>
  );
}

function ActionBtn({ label, onPress, primary, danger }: {
  label: string; onPress: () => void; primary?: boolean; danger?: boolean;
}) {
  return (
    <TouchableOpacity
      style={[styles.btn, primary && styles.btnPrimary, danger && styles.btnDanger]}
      onPress={onPress}
    >
      <Text style={[styles.btnText, primary && styles.btnTextPrimary, danger && styles.btnTextDanger]}>
        {label}
      </Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f2f4f7' },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: '#fff',
    borderBottomWidth: 1,
    borderBottomColor: '#eee',
  },
  title:     { fontSize: 18, fontWeight: 'bold', color: '#222' },
  headerBtn: { fontSize: 15, color: '#2563eb', fontWeight: '600' },
  resumeAllBtn: {
    margin: 16,
    marginBottom: 0,
    backgroundColor: '#2e7d32',
    borderRadius: 12,
    paddingVertical: 12,
    alignItems: 'center',
  },
  resumeAllText: { color: '#fff', fontSize: 15, fontWeight: '600' },
  list: { padding: 16, gap: 12 },
  row: {
    flexDirection: 'row',
    gap: 12,
    backgroundColor: '#fff',
    borderRadius: 16,
    padding: 12,
  },
  thumb:  { width: 72, height: 96, borderRadius: 8, backgroundColor: '#e5e7eb' },
  body:   { flex: 1, gap: 4 },
  status: { fontSize: 15, fontWeight: 'bold' },
  error:  { fontSize: 12, color: '#6b7280' },
  sub:    { fontSize: 12, color: '#6b7280' },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 'auto', paddingTop: 8 },
  btn: {
    borderWidth: 1,
    borderColor: '#d1d5db',
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 6,
    backgroundColor: '#fff',
  },
  btnPrimary:     { backgroundColor: '#2563eb', borderColor: '#2563eb' },
  btnDanger:      { borderColor: '#dc2626' },
  btnText:        { fontSize: 13, fontWeight: '600', color: '#1f2937' },
  btnTextPrimary: { color: '#fff' },
  btnTextDanger:  { color: '#dc2626' },
  discardAllBtn: { padding: 16, alignItems: 'center' },
  discardAllText: { color: '#dc2626', fontSize: 14, fontWeight: '600' },
});
