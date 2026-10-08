import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator, Alert, KeyboardAvoidingView, Modal, SectionList, StyleSheet, Switch, Text, TextInput,
  TouchableOpacity, View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
  Chain, getSuggestConditions, loadChains, saveChains, suggestChains,
} from '../services/ChainService';
import { menuChainCounts } from '../services/FoodService';

interface Props {
  visible: boolean;
  onClose: () => void;
}

const GENRE_ORDER = ['寿司', '焼肉', 'ラーメン', 'ハンバーガー', 'ピザ', '焼き鳥', 'カフェ', '定食・丼', 'ファミレス', 'その他'];

/**
 * チェーン店の一覧。取り込み済みのチェーンは照合に使うかを ON/OFF し、候補は「調べる」を ON にすると
 * 調査待ちになる（Claude Code か一括調査でメニューを取り込む）。下で、行った店・駅・好きなものから候補を探す。
 */
export default function ChainsModal({ visible, onClose }: Props) {
  const [chains, setChains]   = useState<Chain[]>([]);
  const [counts, setCounts]   = useState<Map<string, number>>(new Map());
  const [loading, setLoading] = useState(false);
  const [busy, setBusy]       = useState(false);
  // 保存中のチェーン（続けて押すと行が二重に足されるので、保存が終わるまで押せなくする）
  const [saving, setSaving]   = useState<string | null>(null);
  const [stations, setStations] = useState('');
  const [likes, setLikes]       = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [list, menuCounts, cond] = await Promise.all([
        loadChains(true), menuChainCounts().catch(() => new Map<string, number>()), getSuggestConditions().catch(() => null),
      ]);
      // メニューはあるのに一覧に無いチェーン（取り込んだばかりなど）は、取り込み済みとして出す
      const known = new Set(list.map((c) => c.chain));
      const extra: Chain[] = [...menuCounts.keys()]
        .filter((name) => !known.has(name))
        .map((chain) => ({ chain, genre: 'その他', status: 'collected', enabled: true, aliases: [], note: '', rowIndex: 0 }));
      // 調査待ち・候補でも、メニューを取り込んだ後なら取り込み済みとして出す
      const promoted = list.map((c): Chain =>
        menuCounts.has(c.chain) && c.status !== 'collected' ? { ...c, status: 'collected', enabled: true } : c);
      setChains([...promoted, ...extra]);
      setCounts(menuCounts);
      if (cond) {
        setStations(cond.stations);
        setLikes(cond.likes);
      }
    } catch (e) {
      Alert.alert('読み込み失敗', e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { if (visible) load(); }, [visible, load]);

  const sections = useMemo(() => {
    const byGenre = new Map<string, Chain[]>();
    for (const c of chains) {
      const g = GENRE_ORDER.includes(c.genre) ? c.genre : 'その他';
      byGenre.set(g, [...(byGenre.get(g) ?? []), c]);
    }
    const rank = (c: Chain) => ({ collected: 0, requested: 1, candidate: 2, none: 3 }[c.status]);
    return GENRE_ORDER
      .filter((g) => byGenre.has(g))
      .map((g) => ({ title: g, data: byGenre.get(g)!.sort((a, b) => rank(a) - rank(b) || a.chain.localeCompare(b.chain, 'ja')) }));
  }, [chains]);

  const toggle = async (c: Chain) => {
    if (saving) return;
    setSaving(c.chain);
    const next: Chain = c.status === 'collected'
      ? { ...c, enabled: !c.enabled }
      : { ...c, status: c.status === 'requested' ? 'candidate' : 'requested' };
    setChains((prev) => prev.map((x) => (x.chain === c.chain ? next : x)));
    try {
      await saveChains([next]);
      // 行番号を取り直す（足した行を次に書き換えるときに使う）
      if (next.rowIndex <= 0) {
        const fresh = await loadChains(true);
        const row = fresh.find((x) => x.chain === c.chain);
        if (row) setChains((prev) => prev.map((x) => (x.chain === c.chain ? row : x)));
      }
    } catch (e) {
      setChains((prev) => prev.map((x) => (x.chain === c.chain ? c : x)));
      Alert.alert('保存失敗', e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(null);
    }
  };

  const handleSuggest = async () => {
    setBusy(true);
    try {
      const n = await suggestChains(stations.trim(), likes.trim(), [...counts.keys()]);
      await load();
      Alert.alert(n > 0 ? `候補を ${n} 件足しました` : '新しい候補はありませんでした');
    } catch (e) {
      Alert.alert('候補を探せませんでした', e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const statusLabel = (c: Chain) =>
    c.status === 'collected' ? `${counts.get(c.chain) ?? 0} 品`
      : c.status === 'requested' ? '調査待ち'
        : c.status === 'none' ? '栄養表示なし'
          : '候補';

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <SafeAreaView style={styles.container}>
        {/* Android のモーダルは adjustResize が効かないので、キーボードぶん縮める */}
        <KeyboardAvoidingView style={styles.fill} behavior="height">
          <View style={styles.header}>
            <Text style={styles.title}>チェーン店</Text>
            <TouchableOpacity onPress={onClose}>
              <Text style={styles.close}>✕</Text>
            </TouchableOpacity>
          </View>
          <SectionList
            sections={sections}
            keyExtractor={(c) => c.chain}
            stickySectionHeadersEnabled={false}
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={styles.list}
            ListHeaderComponent={
              <Text style={styles.hint}>候補を ON にすると、次の調査でメニューを取り込みます</Text>
            }
            ListEmptyComponent={loading ? <ActivityIndicator style={{ marginTop: 24 }} /> : null}
            renderSectionHeader={({ section }) => <Text style={styles.section}>{section.title}</Text>}
            renderItem={({ item }) => (
              <View style={styles.row}>
                <View style={styles.rowBody}>
                  <Text style={styles.name}>{item.chain}</Text>
                  {!!item.note && item.status !== 'collected' && <Text style={styles.note} numberOfLines={1}>{item.note}</Text>}
                </View>
                <Text style={[styles.status, item.status === 'requested' && styles.statusRequested]}>{statusLabel(item)}</Text>
                {item.status === 'none' ? (
                  <View style={styles.switchSpace} />
                ) : (
                  <Switch
                    value={item.status === 'collected' ? item.enabled : item.status === 'requested'}
                    onValueChange={() => toggle(item)}
                    disabled={saving !== null}
                    trackColor={{ false: '#ccc', true: '#a5d6a7' }}
                    thumbColor={(item.status === 'collected' ? item.enabled : item.status === 'requested') ? '#2e7d32' : '#f4f3f4'}
                  />
                )}
              </View>
            )}
            ListFooterComponent={
              <View style={styles.suggest}>
                <Text style={styles.section}>候補を探す</Text>
                <Text style={styles.label}>よく行く駅</Text>
                <TextInput style={styles.input} value={stations} onChangeText={setStations} placeholder="船橋日大前、秋葉原" />
                <Text style={styles.label}>好きなもの</Text>
                <TextInput style={styles.input} value={likes} onChangeText={setLikes} placeholder="寿司、ラーメン" />
                <TouchableOpacity style={[styles.suggestBtn, busy && styles.disabled]} onPress={handleSuggest} disabled={busy}>
                  {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.suggestText}>候補を探す</Text>}
                </TouchableOpacity>
              </View>
            }
          />
        </KeyboardAvoidingView>
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f2f4f7' },
  fill:      { flex: 1 },
  header: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingHorizontal: 16, paddingVertical: 12, backgroundColor: '#fff',
  },
  title:   { fontSize: 16, fontWeight: 'bold', color: '#1a1a1a' },
  close:   { fontSize: 20, color: '#666', paddingHorizontal: 8 },
  list:    { padding: 16, paddingBottom: 40 },
  hint:    { fontSize: 12, color: '#6b7280', marginBottom: 4 },
  section: { fontSize: 13, fontWeight: 'bold', color: '#374151', paddingTop: 12, paddingBottom: 6 },
  row: {
    flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: '#fff',
    borderRadius: 12, paddingHorizontal: 12, paddingVertical: 6, marginBottom: 6,
  },
  rowBody: { flex: 1 },
  name:    { fontSize: 14, color: '#1f2937', fontWeight: '600' },
  note:    { fontSize: 11, color: '#9ca3af', marginTop: 1 },
  status:  { fontSize: 12, color: '#6b7280' },
  statusRequested: { color: '#2e7d32', fontWeight: '700' },
  switchSpace: { width: 50 },
  suggest: { marginTop: 8 },
  label:   { fontSize: 12, color: '#6b7280', marginTop: 6, marginBottom: 4 },
  input: {
    backgroundColor: '#fff', borderRadius: 10, borderWidth: 1, borderColor: '#e5e7eb',
    paddingHorizontal: 12, paddingVertical: 8, fontSize: 14, color: '#1f2937',
  },
  suggestBtn:  { backgroundColor: '#2e7d32', borderRadius: 12, paddingVertical: 13, alignItems: 'center', marginTop: 12 },
  suggestText: { color: '#fff', fontSize: 14, fontWeight: 'bold' },
  disabled:    { opacity: 0.6 },
});
