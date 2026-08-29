/**
 * 複数行をまとめて確認・編集するモーダル。
 *
 * 2 つの使い方をする:
 * - `confirm`: 1 枚の画像から複数のレシートを読み取ったとき、**保存する前に**中身を直す
 * - `edit`:    一覧の「前回の登録」から、入れたばかりの行を後から直す
 *
 * 行の追加はできない（読み取れなかったレシートは撮り直す）。
 */

import { useEffect, useState } from 'react';
import {
  Alert,
  Button,
  FlatList,
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
import * as CategoryService from '../services/CategoryService';
import type { ExpenseRow } from '../services/SheetsService';

interface Props {
  visible:  boolean;
  title:    string;
  rows:     ExpenseRow[];
  mode:     'confirm' | 'edit';
  /** 保存処理中はボタンを止める */
  busy?:    boolean;
  onClose:  () => void;
  /**
   * @param kept    残す行（編集後の内容）
   * @param removed 除外する行（confirm なら登録しない、edit なら削除する）
   */
  onCommit: (kept: ExpenseRow[], removed: ExpenseRow[]) => void;
}

interface Draft {
  row:       ExpenseRow; // 元の行（rowIndex / sheetName を保つ）
  timestamp: string;
  store:     string;
  category:  string;
  amount:    string;
  memo:      string;
  removed:   boolean;
}

export default function ReceiptReviewModal({
  visible,
  title,
  rows,
  mode,
  busy = false,
  onClose,
  onCommit,
}: Props) {
  const [draft, setDraft]           = useState<Draft[]>([]);
  const [categories, setCategories] = useState<string[]>([]);
  const [pickerFor, setPickerFor]   = useState<number | null>(null);

  useEffect(() => {
    if (!visible) return;
    setDraft(
      rows.map((r) => ({
        row:       r,
        timestamp: r.timestamp,
        store:     r.store,
        category:  r.category,
        amount:    String(r.amount),
        memo:      r.memo,
        removed:   false,
      })),
    );
    CategoryService.getCategories()
      .then(setCategories)
      .catch(() => setCategories([]));
  }, [visible, rows]);

  const patch = (index: number, next: Partial<Draft>) => {
    setDraft((prev) => prev.map((d, i) => (i === index ? { ...d, ...next } : d)));
  };

  const toggleRemoved = (index: number) => {
    setDraft((prev) => prev.map((d, i) => (i === index ? { ...d, removed: !d.removed } : d)));
  };

  const keptCount = draft.filter((d) => !d.removed).length;

  /** 入力内容を ExpenseRow に戻す。不正があれば理由を出して null */
  const buildRows = (): { kept: ExpenseRow[]; removed: ExpenseRow[] } | null => {
    const kept: ExpenseRow[] = [];
    const removed: ExpenseRow[] = [];

    for (const d of draft) {
      if (d.removed) {
        removed.push(d.row);
        continue;
      }

      const label  = d.store.trim() || '(店名なし)';
      const amount = Number(d.amount.replace(/[^\d]/g, ''));
      if (!Number.isFinite(amount) || amount <= 0) {
        Alert.alert('入力エラー', `${label} の金額が不正です`);
        return null;
      }

      const timestamp = normalizeTimestampInput(d.timestamp);
      if (!timestamp) {
        Alert.alert('入力エラー', `${label} の日時が不正です。「2026/08/07 12:34」の形式で入力してください`);
        return null;
      }

      // 一部計上していない行は計上金額も金額に合わせる（比率を触っている行は据え置き）
      const counted = d.row.countedAmount === d.row.amount ? amount : d.row.countedAmount;

      kept.push({
        ...d.row,
        timestamp,
        store:         d.store.trim(),
        category:      d.category,
        amount,
        memo:          d.memo,
        countedAmount: counted,
      });
    }

    return { kept, removed };
  };

  const handleCommit = () => {
    const built = buildRows();
    if (!built) return;

    // 登録済みの行を消すのは取り消せないので、ここで一度だけ確認する
    if (mode === 'edit' && built.removed.length > 0) {
      Alert.alert(
        `${built.removed.length}件を削除しますか？`,
        'アプリ上からは復活できません。',
        [
          { text: 'キャンセル', style: 'cancel' },
          { text: '削除して保存', style: 'destructive', onPress: () => onCommit(built.kept, built.removed) },
        ],
      );
      return;
    }
    onCommit(built.kept, built.removed);
  };

  const commitLabel = busy
    ? '保存中...'
    : mode === 'confirm'
      ? keptCount > 0 ? `${keptCount}件を登録する` : '登録せずに閉じる'
      : '変更を保存する';

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <SafeAreaView style={styles.container}>
        <View style={styles.header}>
          <Text style={styles.headerTitle}>{title}</Text>
          <Button title="閉じる" onPress={onClose} disabled={busy} />
        </View>

        <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
          <Text style={styles.lead}>
            {mode === 'confirm'
              ? `${draft.length}件を読み取りました。内容を確認してください。`
              : '直した内容はスプレッドシートに反映されます。日時の月を変えても行は元のシートに残ります。'}
          </Text>

          {draft.map((d, i) => (
            <View key={`${d.row.sheetName ?? ''}:${d.row.rowIndex ?? i}`} style={[styles.card, d.removed && styles.cardRemoved]}>
              <View style={styles.cardHead}>
                <Text style={styles.cardIndex}>{i + 1}件目</Text>
                <TouchableOpacity style={styles.removeBtn} onPress={() => toggleRemoved(i)}>
                  <Text style={[styles.removeBtnText, d.removed && styles.restoreBtnText]}>
                    {d.removed ? '戻す' : mode === 'confirm' ? '登録しない' : '削除する'}
                  </Text>
                </TouchableOpacity>
              </View>

              {d.removed ? (
                <Text style={styles.removedNote}>
                  {mode === 'confirm' ? 'この明細は登録しません' : 'この明細を削除します'}
                  {'  '}
                  {d.store || '(店名なし)'} ¥{d.row.amount.toLocaleString()}
                </Text>
              ) : (
                <>
                  <Field
                    label="日時"
                    value={d.timestamp}
                    onChangeText={(v) => patch(i, { timestamp: v })}
                    placeholder="2026/08/07 12:34"
                  />
                  <Field label="店舗" value={d.store} onChangeText={(v) => patch(i, { store: v })} />

                  <View style={styles.fieldBox}>
                    <Text style={styles.fieldLabel}>カテゴリ</Text>
                    <TouchableOpacity style={styles.pickerBtn} onPress={() => setPickerFor(i)}>
                      <Text style={styles.pickerBtnText}>{d.category || '(未選択)'} ▾</Text>
                    </TouchableOpacity>
                  </View>

                  <Field
                    label="金額"
                    value={d.amount}
                    onChangeText={(v) => patch(i, { amount: v })}
                    keyboardType="number-pad"
                  />
                  <Field
                    label="メモ"
                    value={d.memo}
                    onChangeText={(v) => patch(i, { memo: v })}
                    multiline
                  />
                </>
              )}
            </View>
          ))}
        </ScrollView>

        <View style={styles.footer}>
          <TouchableOpacity
            style={[styles.primaryBtn, busy && styles.primaryBtnDisabled]}
            onPress={handleCommit}
            disabled={busy}
          >
            <Text style={styles.primaryBtnText}>{commitLabel}</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>

      {/* カテゴリ選択 */}
      <Modal
        visible={pickerFor !== null}
        transparent
        animationType="fade"
        onRequestClose={() => setPickerFor(null)}
      >
        <Pressable style={styles.backdrop} onPress={() => setPickerFor(null)}>
          <Pressable style={styles.sheet} onPress={(e) => e.stopPropagation()}>
            <Text style={styles.sheetTitle}>カテゴリを選択</Text>
            <FlatList
              data={categories}
              keyExtractor={(c) => c}
              renderItem={({ item }) => (
                <TouchableOpacity
                  style={styles.sheetItem}
                  onPress={() => {
                    if (pickerFor !== null) patch(pickerFor, { category: item });
                    setPickerFor(null);
                  }}
                >
                  <Text style={styles.sheetItemText}>{item}</Text>
                </TouchableOpacity>
              )}
            />
          </Pressable>
        </Pressable>
      </Modal>
    </Modal>
  );
}

// ─── 部品 ────────────────────────────────────────────────────────────────────

function Field({
  label,
  value,
  onChangeText,
  keyboardType,
  multiline,
  placeholder,
}: {
  label:         string;
  value:         string;
  onChangeText:  (v: string) => void;
  keyboardType?: 'default' | 'number-pad';
  multiline?:    boolean;
  placeholder?:  string;
}) {
  return (
    <View style={styles.fieldBox}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TextInput
        style={[styles.fieldInput, multiline && styles.fieldInputMultiline]}
        value={value}
        onChangeText={onChangeText}
        keyboardType={keyboardType ?? 'default'}
        multiline={multiline}
        placeholder={placeholder}
      />
    </View>
  );
}

// ─── utils ───────────────────────────────────────────────────────────────────

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/**
 * 入力された日時を 'YYYY/MM/DD HH:MM:SS' に整える。解釈できなければ null。
 * 区切りとゼロ埋めの揺れ、秒の省略を許す（new Date() には渡さない。Hermes で壊れるため）。
 */
export function normalizeTimestampInput(input: string): string | null {
  const m = String(input ?? '')
    .trim()
    .match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[ T]+(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?$/);
  if (!m) return null;

  const year  = Number(m[1]);
  const month = Number(m[2]);
  const day   = Number(m[3]);
  const hour  = Number(m[4] ?? 0);
  const min   = Number(m[5] ?? 0);
  const sec   = Number(m[6] ?? 0);

  if (month < 1 || month > 12) return null;
  // 数値引数の Date は Hermes でも安全
  if (day < 1 || day > new Date(year, month, 0).getDate()) return null;
  if (hour > 23 || min > 59 || sec > 59) return null;

  return `${year}/${pad2(month)}/${pad2(day)} ${pad2(hour)}:${pad2(min)}:${pad2(sec)}`;
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
  headerTitle: { fontSize: 17, fontWeight: 'bold', color: '#1a1a1a' },

  body: { padding: 16, paddingBottom: 32 },
  lead: { fontSize: 13, color: '#6b7280', marginBottom: 12 },

  card: {
    backgroundColor: '#fff',
    borderRadius: 16,
    padding: 16,
    marginBottom: 12,
  },
  cardRemoved: { opacity: 0.55 },
  cardHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  cardIndex: { fontSize: 13, fontWeight: '700', color: '#2e7d32' },
  removeBtn: {
    borderWidth: 1,
    borderColor: '#ef4444',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 5,
  },
  removeBtnText: { color: '#ef4444', fontSize: 12, fontWeight: '600' },
  restoreBtnText: { color: '#2e7d32' },
  removedNote: { fontSize: 13, color: '#6b7280', paddingVertical: 6 },

  fieldBox: { marginTop: 10 },
  fieldLabel: { fontSize: 12, color: '#6b7280', marginBottom: 4 },
  fieldInput: {
    borderWidth: 1,
    borderColor: '#e5e7eb',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
    color: '#1a1a1a',
    backgroundColor: '#fff',
  },
  fieldInputMultiline: { minHeight: 60, textAlignVertical: 'top' },
  pickerBtn: {
    borderWidth: 1,
    borderColor: '#e5e7eb',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 11,
    backgroundColor: '#fff',
  },
  pickerBtnText: { fontSize: 15, color: '#1a1a1a' },

  footer: {
    padding: 16,
    backgroundColor: '#fff',
    borderTopWidth: 1,
    borderTopColor: '#eee',
  },
  primaryBtn: {
    backgroundColor: '#2e7d32',
    borderRadius: 16,
    paddingVertical: 15,
    alignItems: 'center',
  },
  primaryBtnDisabled: { backgroundColor: '#9ca3af' },
  primaryBtnText: { color: '#fff', fontSize: 16, fontWeight: 'bold' },

  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: '#fff',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    padding: 20,
    maxHeight: '70%',
  },
  sheetTitle: { fontSize: 16, fontWeight: 'bold', marginBottom: 12, color: '#1a1a1a' },
  sheetItem: { paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: '#f0f0f0' },
  sheetItemText: { fontSize: 15, color: '#1a1a1a' },
});
