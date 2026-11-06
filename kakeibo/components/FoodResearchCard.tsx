/**
 * 設定画面の「食品データの一括調査」。調査用の文面を AI アプリへ共有し、答えを貼り付けて取り込む。
 * 仕様は docs/meal-nutrition-spec.md §8.8.1（方式 A）。
 */

import { useState } from 'react';
import {
  ActivityIndicator, Alert, KeyboardAvoidingView, Modal, Share, StyleSheet, Text, TextInput, TouchableOpacity, View,
} from 'react-native';
import { buildResearchRequest, importResearchTable } from '../services/FoodResearchService';

export default function FoodResearchCard() {
  const [busy, setBusy] = useState(false);
  const [remaining, setRemaining] = useState<number | null>(null);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasted, setPasted] = useState('');

  const handleBuild = async () => {
    setBusy(true);
    try {
      const { text, count, remaining: rest } = await buildResearchRequest();
      setRemaining(rest);
      if (count === 0) {
        Alert.alert('対象なし', 'まだ調べていない品目はありません');
        return;
      }
      await Share.share({ message: text });
    } catch (e) {
      Alert.alert('作成失敗', e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const handleImport = async () => {
    setBusy(true);
    try {
      const { imported, skipped } = await importResearchTable(pasted);
      setPasteOpen(false);
      setPasted('');
      Alert.alert('取り込みました', `${imported} 件${skipped > 0 ? `（読めなかった行 ${skipped} 件）` : ''}`);
    } catch (e) {
      Alert.alert('取り込み失敗', e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Text style={styles.sectionLabel}>食品データの一括調査</Text>
      <View style={styles.card}>
        <Text style={styles.hint}>
          ① 文面を作って AI アプリ（Gemini・Claude など）に送る{'\n'}
          ② AI の答えをまるごとコピーして、ここに貼り付ける
        </Text>
        <TouchableOpacity style={[styles.primaryBtn, busy && styles.disabled]} onPress={handleBuild} disabled={busy}>
          {busy && !pasteOpen
            ? <ActivityIndicator color="#fff" />
            : <Text style={styles.primaryBtnText}>調査用の文面を作る</Text>}
        </TouchableOpacity>
        <TouchableOpacity style={styles.outlineBtn} onPress={() => setPasteOpen(true)} disabled={busy}>
          <Text style={styles.outlineBtnText}>答えを貼り付けて取り込む</Text>
        </TouchableOpacity>
        {remaining !== null && remaining > 0 && <Text style={styles.meta}>続き {remaining} 件</Text>}
      </View>

      <Modal visible={pasteOpen} animationType="slide" onRequestClose={() => setPasteOpen(false)}>
        {/* Android のモーダルは adjustResize が効かないので、キーボードぶん縮める */}
        <KeyboardAvoidingView style={styles.modal} behavior="height">
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>答えを貼り付け</Text>
            <TouchableOpacity onPress={() => setPasteOpen(false)}>
              <Text style={styles.modalClose}>✕</Text>
            </TouchableOpacity>
          </View>
          <TextInput
            style={styles.pasteInput}
            value={pasted}
            onChangeText={setPasted}
            multiline
            textAlignVertical="top"
            autoCorrect={false}
            autoCapitalize="none"
          />
          <TouchableOpacity
            style={[styles.primaryBtn, styles.modalBtn, (busy || !pasted.trim()) && styles.disabled]}
            onPress={handleImport}
            disabled={busy || !pasted.trim()}
          >
            {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.primaryBtnText}>取り込む</Text>}
          </TouchableOpacity>
        </KeyboardAvoidingView>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  sectionLabel: { fontSize: 12, fontWeight: '600', color: '#888', letterSpacing: 0.5, marginBottom: 8, marginTop: 4, paddingHorizontal: 4 },
  card: { backgroundColor: '#fff', borderRadius: 16, overflow: 'hidden', marginBottom: 16, paddingHorizontal: 16, paddingTop: 4 },
  hint: { fontSize: 12, color: '#6b7280', lineHeight: 18, paddingTop: 8 },
  primaryBtn: { backgroundColor: '#2e7d32', borderRadius: 12, paddingVertical: 13, alignItems: 'center', marginTop: 10 },
  primaryBtnText: { color: '#fff', fontSize: 14, fontWeight: 'bold' },
  disabled: { backgroundColor: '#9ca3af' },
  outlineBtn: { borderWidth: 1, borderColor: '#9ca3af', borderRadius: 10, paddingVertical: 10, alignItems: 'center', marginVertical: 10 },
  outlineBtnText: { color: '#374151', fontSize: 13, fontWeight: '600' },
  meta: { fontSize: 12, color: '#888', marginBottom: 10 },
  modal: { flex: 1, backgroundColor: '#f2f4f7', padding: 16 },
  modalHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 },
  modalTitle: { fontSize: 16, fontWeight: 'bold', color: '#1a1a1a' },
  modalClose: { fontSize: 20, color: '#666', paddingHorizontal: 8 },
  pasteInput: { flex: 1, backgroundColor: '#fff', borderRadius: 12, padding: 12, fontSize: 12, color: '#1a1a1a' },
  modalBtn: { marginBottom: 8 },
});
