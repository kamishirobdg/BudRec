import { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  KeyboardAvoidingView,
  Modal,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import MealPhotos from '../components/MealPhotos';
import {
  Correction, HistoryEntry, ItemChoice, MealConflictError, MealKind, MealRow,
  deleteMeal, getMeal, getMealHistory, logCorrections, mealRev, mealsSheetName, newMealId, saveMeal,
} from '../services/MealService';
import { Nutrients, scaleNutrients, sanitizeNutrients } from '../services/Nutrients';
import { lookupNutrition } from '../providers/GeminiMeal';
import { getCurrentUser } from '../services/UserService';
import { getUniqueUsers } from '../services/SheetsService';
import { epochToTimestamp } from '../services/MealProcessing';
import { archiveMealPhoto, mealPhotoRef } from '../services/PhotoStore';
import { ensureMealShared, markSettled } from '../services/SharedPhotos';
import { findFood, loadFoods, researchNow, saveResearched } from '../services/FoodService';
import { NutritionLabel, readNutritionLabel } from '../services/LabelReader';
import NutrientEditModal from '../components/NutrientEditModal';
import * as ImagePicker from 'expo-image-picker';
import { consume, listInventory, restoreEntryItems } from '../services/InventoryService';
import FoodThumb from '../components/FoodThumb';

export type MealTarget =
  | { mode: 'edit'; sheetName: string; mealId: string }
  /** 判別できなかった写真から手で記録する */
  | { mode: 'new'; photoUri: string; shotAt: number; proxyUser?: string };

interface Props {
  target:  MealTarget | null;
  onClose: () => void;
  /** 保存・削除できたとき。new のときは写真を片付けてよい */
  onSaved: () => void;
}

interface Eater {
  user:    string;
  portion: number;
}

interface DishDraft {
  dishId:         string;
  dish:           string;
  originalDish:   string;
  kind:           MealKind;
  store:          string;
  eaters:         Eater[];
  originalEaters: Eater[];
  /** 一品全体の栄養 */
  whole:          Nutrients;
  nutrientSource: MealRow['nutrientSource'];
  confidence:     MealRow['confidence'];
  entryId:        string;
  itemRefs:       MealRow['itemRefs'];
  sources:        string[];
  assignedBy:     MealRow['assignedBy'];
  isNew:          boolean;
  /** 在庫のどれか見分けられなかった候補。選ぶまで在庫は減らしていない */
  choices:        ItemChoice[];
  /** 候補から選んだ在庫（'none' は「どれでもない」） */
  chosen:         string | null;
  /** 「栄養を調べ直す」で栄養を差し替えた */
  refreshed:      boolean;
  /** 栄養を手で直した・包装の表示から入れた（名前を変えても調べ直して上書きしない） */
  manualNutrition: boolean;
  /** この編集で包装の表示から入れた（保存できたら食品データにも入れる） */
  label?: NutritionLabel;
}

const RATIOS = [0.5, 0.6, 0.7, 0.4, 0.3];

function eatersKey(e: Eater[]): string {
  return e.map((x) => `${x.user}:${x.portion}`).sort().join(',');
}

function toDrafts(rows: MealRow[]): DishDraft[] {
  const byDish = new Map<string, MealRow[]>();
  for (const r of rows) byDish.set(r.dishId, [...(byDish.get(r.dishId) ?? []), r]);
  return [...byDish.values()].map((list) => {
    const first = list[0];
    const ref = list.find((r) => r.portion > 0) ?? first;
    const eaters = list.map((r) => ({ user: r.user, portion: r.portion }));
    return {
      dishId: first.dishId,
      dish: first.dish,
      originalDish: first.dish,
      kind: first.kind,
      store: first.store,
      eaters,
      originalEaters: eaters,
      whole: ref.portion > 0 ? scaleNutrients(ref.nutrients, 1 / ref.portion) : ref.nutrients,
      nutrientSource: first.nutrientSource,
      confidence: first.confidence,
      entryId: first.entryId,
      itemRefs: first.itemRefs,
      sources: first.sources,
      assignedBy: first.assignedBy,
      isNew: false,
      choices: first.choices ?? [],
      chosen: null,
      refreshed: false,
      manualNutrition: first.nutrientSource === 'manual' || first.nutrientSource === 'label',
    };
  });
}

function kcal(n: Nutrients): string {
  const v = n['ENERC_KCAL'];
  return v === null || v === undefined ? '— kcal' : `${Math.round(v)} kcal`;
}

export default function MealEditModal({ target, onClose, onSaved }: Props) {
  const [loading, setLoading] = useState(false);
  const [saving, setSaving]   = useState(false);
  const [drafts, setDrafts]   = useState<DishDraft[]>([]);
  const [loaded, setLoaded]   = useState<MealRow[]>([]);
  const [baseRev, setBaseRev] = useState(0);
  const [me, setMe]           = useState('');
  const [partner, setPartner] = useState<string | null>(null);
  const [newDish, setNewDish] = useState('');
  const [history, setHistory] = useState<HistoryEntry[] | null>(null);
  // 「相手と共有」を触ったときの値（null = 触っていない。二人で食べた食事なら共有）
  const [sharedFlag, setSharedFlag] = useState<boolean | null>(null);
  // 栄養を直す画面（label があれば包装の表示から）
  const [nutEdit, setNutEdit] = useState<{ dishId: string; label: NutritionLabel | null } | null>(null);
  const [readingLabel, setReadingLabel] = useState<string | null>(null);

  const isNewMeal = target?.mode === 'new';
  const sheetName = target?.mode === 'edit' ? target.sheetName : null;
  const mealId = useMemo(
    () => (target?.mode === 'edit' ? target.mealId : newMealId()),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [target],
  );

  useEffect(() => {
    if (!target) return;
    let alive = true;
    (async () => {
      setLoading(true);
      setHistory(null);
      setNewDish('');
      setSharedFlag(null);
      try {
        const user = await getCurrentUser();
        const others = (await getUniqueUsers()).filter((u) => u !== user);
        if (!alive) return;
        setMe(target.mode === 'new' && target.proxyUser ? target.proxyUser : user);
        setPartner(target.mode === 'new' && target.proxyUser ? user : others[0] ?? null);
        if (target.mode === 'edit') {
          const rows = await getMeal(target.sheetName, target.mealId);
          if (!alive) return;
          setLoaded(rows);
          setDrafts(toDrafts(rows));
          setBaseRev(mealRev(rows));
        } else {
          setLoaded([]);
          setDrafts([]);
          setBaseRev(0);
        }
      } catch (e) {
        Alert.alert('読み込み失敗', e instanceof Error ? e.message : String(e));
        onClose();
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target]);

  if (!target) return null;

  const eatenAt = target.mode === 'edit'
    ? loaded[0]?.eatenAt ?? ''
    : epochToTimestamp(target.shotAt);
  const photoRefs = [...new Set(loaded.flatMap((r) => r.photoRefs))];
  const entryIds = [...new Set(loaded.map((r) => r.entryId).filter(Boolean))];
  // 共有の既定: 前に決めた値があればそれ、無ければ食べた人が 2 人以上なら共有
  const autoShared = loaded.find((r) => r.shared !== undefined)?.shared
    ?? new Set(drafts.flatMap((d) => d.eaters.map((e) => e.user))).size > 1;
  const shared = sharedFlag ?? autoShared;
  const shareChanged = sharedFlag !== null && sharedFlag !== autoShared;
  const contentChanged =
    drafts.length !== toDrafts(loaded).length ||
    drafts.some((d) => d.isNew || d.refreshed || d.chosen !== null || d.dish.trim() !== d.originalDish
      || eatersKey(d.eaters) !== eatersKey(d.originalEaters));
  const changed = shareChanged || contentChanged;
  const needsReview = loaded.some((r) => r.status === 'needs_review');

  const update = (dishId: string, patch: Partial<DishDraft>) =>
    setDrafts((prev) => prev.map((d) => (d.dishId === dishId ? { ...d, ...patch } : d)));

  const addDish = () => {
    const name = newDish.trim();
    if (!name) return;
    setDrafts((prev) => [...prev, {
      dishId: newMealId(), dish: name, originalDish: '', kind: prev[0]?.kind ?? 'home', store: prev[0]?.store ?? '',
      eaters: [{ user: me, portion: 1 }], originalEaters: [], whole: sanitizeNutrients({}),
      nutrientSource: 'estimate', confidence: 'low', entryId: prev[0]?.entryId ?? '', itemRefs: [], sources: [],
      assignedBy: 'manual', isNew: true, choices: [], chosen: null, refreshed: false, manualNutrition: false,
    }]);
    setNewDish('');
  };

  /** 名前を変えた・足した品の栄養を引き直す。取れなければ不明（null）のまま保存する */
  const refreshNutrition = async (list: DishDraft[]): Promise<DishDraft[]> => {
    const targets = list.filter((d) => !d.manualNutrition && (d.isNew || d.dish.trim() !== d.originalDish));
    if (targets.length === 0) return list;
    try {
      const { results, sources } = await lookupNutrition(
        targets.map((d) => ({ store: d.kind === 'home' ? '' : d.store, name: d.dish.trim(), kind: d.kind })),
      );
      return list.map((d) => {
        const i = targets.indexOf(d);
        if (i < 0) return d;
        const r = results[i];
        return {
          ...d,
          whole: r.nutrients,
          nutrientSource: r.official ? 'grounding' : r.tableSources ? 'food_table' : 'estimate',
          confidence: r.official ? 'high' : r.tableSources ? 'medium' : 'low',
          sources: r.tableSources ?? sources,
        };
      });
    } catch (e) {
      Alert.alert('栄養を取得できませんでした', '料理名だけ保存します。\n' + (e instanceof Error ? e.message : String(e)));
      return list.map((d) => (targets.includes(d) ? { ...d, whole: sanitizeNutrients({}), confidence: 'low' } : d));
    }
  };

  const buildRows = (list: DishDraft[], photoRef: string | null): MealRow[] =>
    list.flatMap((d) => {
      const manual = d.isNew || eatersKey(d.eaters) !== eatersKey(d.originalEaters) || d.dish.trim() !== d.originalDish;
      const resolved = resolveChoice(d);
      return d.eaters.map((e): MealRow => ({
        mealId, dishId: d.dishId, eatenAt, user: e.user, kind: d.kind, store: d.store,
        dish: d.dish.trim(), portion: e.portion, nutrients: scaleNutrients(d.whole, e.portion),
        nutrientSource: d.nutrientSource, confidence: d.confidence, entryId: d.entryId, itemRefs: resolved.itemRefs,
        // 見分けられなかった在庫を選ぶまでは確認待ちのまま
        // レシートから登録した印は、食べた人を直しても残す（「食べていない（在庫に戻す）」を出し続けるため）
        status: resolved.choices.length > 0 ? 'needs_review' : 'edited',
        assignedBy: d.assignedBy === 'receipt' ? 'receipt' : manual ? 'manual' : d.assignedBy,
        photoRefs: photoRef ? [photoRef] : photoRefs, rev: 0, sources: d.sources, updatedBy: me, updatedAt: '',
        choices: resolved.choices,
        // 触っていなければ前の値のまま（未設定なら食べた人の数で決まる）
        shared: sharedFlag ?? loaded.find((r) => r.shared !== undefined)?.shared,
      }));
    });

  /** 使った在庫のうち、見分けられなかった候補にあたるもの（量は推定のまま） */
  const pendingRef = (d: DishDraft) =>
    d.itemRefs.find((r) => d.choices.some((c) => c.itemId === r.itemId));

  /**
   * 候補から選んだら、候補にあたる在庫だけを選んだものに差し替える（ほかの食材はそのまま）。
   * 「どれでもない」なら候補にあたる在庫を外す。
   */
  const resolveChoice = (d: DishDraft): { itemRefs: MealRow['itemRefs']; choices: ItemChoice[] } => {
    if (!d.chosen) return { itemRefs: d.itemRefs, choices: d.choices };
    const pending = pendingRef(d);
    const others = d.itemRefs.filter((r) => r !== pending);
    if (d.chosen === 'none') return { itemRefs: others, choices: [] };
    return { itemRefs: [...others, { ...(pending ?? {}), itemId: d.chosen }], choices: [] };
  };

  /** 包装の栄養成分表示を撮って読む。読めたら食べた量を入れる画面を出す */
  const shootLabel = async (d: DishDraft) => {
    try {
      const perm = await ImagePicker.requestCameraPermissionsAsync();
      if (!perm.granted) return;
      const res = await ImagePicker.launchCameraAsync({ base64: true, quality: 0.85, mediaTypes: ['images'] });
      const base64 = res.canceled ? null : res.assets[0]?.base64;
      if (!base64) return;
      setReadingLabel(d.dishId);
      const label = await readNutritionLabel(base64);
      setNutEdit({ dishId: d.dishId, label });
    } catch (e) {
      Alert.alert('読み取れませんでした', e instanceof Error ? e.message : String(e));
    } finally {
      setReadingLabel(null);
    }
  };

  /** 栄養を直した値にする。包装の表示から入れたときは、保存できたら食品データにも入れる（次からはその値を使う） */
  const applyNutrients = (dishId: string, nutrients: Nutrients, label: NutritionLabel | null) => {
    update(dishId, {
      whole: nutrients,
      nutrientSource: label ? 'label' : 'manual',
      confidence: 'high',
      refreshed: true,
      manualNutrition: true,
      label: label ?? undefined,
    });
    setNutEdit(null);
  };

  /**
   * 包装の表示から入れた品を食品データに入れる（保存できた後に呼ぶ。失敗しても投げない）。
   * 品名の鍵に加えて、在庫の品目を食べた品なら在庫の品名（店のオリジナル商品はチェーン付き）の鍵にも入れる
   */
  const saveLabels = async (list: DishDraft[]) => {
    const withLabel = list.filter((d) => d.label);
    if (withLabel.length === 0) return;
    try {
      const [inventory, foods] = await Promise.all([listInventory(true).catch(() => []), loadFoods()]);
      const entries = withLabel.flatMap((d) => {
        const names = [{ name: d.dish.trim(), chain: '' }];
        for (const ref of d.itemRefs) {
          const item = inventory.find((i) => i.itemId === ref.itemId);
          if (item) names.push({ name: item.name, chain: findFood(foods, item.name, item.store)?.chain ?? '' });
        }
        const unique = [...new Map(names.map((n) => [`${n.chain}|${n.name}`, n])).values()];
        return unique.map((n) => ({
          query: { name: n.name, chain: n.chain, kind: 'packaged' as const, content: d.label!.content },
          result: { nutrients: d.label!.nutrients, basis: d.label!.basis, official: true },
          sources: [],
        }));
      });
      await saveResearched(entries);
    } catch (e) {
      console.warn('[Meal] 食品データに入れられなかった:', e instanceof Error ? e.message : e);
    }
  };

  /** 栄養を調べ直す（リニューアルなどで明らかに違うとき） */
  const reresearch = async (d: DishDraft) => {
    try {
      const food = await researchNow({
        name: d.dish.trim(), chain: d.kind === 'eat_out' ? d.store : '', kind: d.kind, content: '',
      });
      if (!food || !Object.values(food.nutrients).some((v) => v !== null)) {
        Alert.alert('見つかりませんでした');
        return;
      }
      update(d.dishId, {
        whole: food.nutrients,
        nutrientSource: food.source === 'grounding' || food.source === 'food_table' ? food.source : 'estimate',
        confidence: food.source === 'grounding' ? 'high' : food.source === 'food_table' ? 'medium' : 'low',
        sources: food.sources,
        refreshed: true,
        manualNutrition: false,
      });
    } catch (e) {
      Alert.alert('調べられませんでした', e instanceof Error ? e.message : String(e));
    }
  };

  const corrections = (list: DishDraft[]): Correction[] =>
    list.flatMap((d): Correction[] => {
      if (d.isNew) return [];
      const ctx = `${d.store || '自炊'} ${d.dish}`;
      const out: Correction[] = [];
      if (d.dish.trim() !== d.originalDish) {
        out.push({ mealId, dishId: d.dishId, field: 'dish', before: d.originalDish, after: d.dish.trim(), context: ctx });
      }
      if (eatersKey(d.eaters) !== eatersKey(d.originalEaters)) {
        const fmt = (e: Eater[]) => e.map((x) => `${x.user}${Math.round(x.portion * 10)}`).join('・');
        const field = d.eaters.length !== d.originalEaters.length || d.eaters[0]?.user !== d.originalEaters[0]?.user
          ? 'user' : 'portion';
        out.push({ mealId, dishId: d.dishId, field, before: fmt(d.originalEaters), after: fmt(d.eaters), context: ctx });
      }
      return out;
    });

  /** 保存する。相手が先に保存していたら選ばせる */
  const persist = async (rows: MealRow[], rev: number, force = false): Promise<MealRow[] | null> => {
    const sheet = sheetName ?? mealsSheetName(eatenAt);
    try {
      return await saveMeal(sheet, mealId, rows, rev, me, { force });
    } catch (e) {
      if (!(e instanceof MealConflictError)) throw e;
      return new Promise((resolve, reject) => {
        Alert.alert(
          'ほかの端末で先に保存されています',
          `${e.savedBy || '相手'}さんが先にこの食事を保存しました。`,
          [
            {
              text: '相手の内容を残す',
              onPress: () => {
                setLoaded(e.current);
                setDrafts(toDrafts(e.current));
                setBaseRev(mealRev(e.current));
                resolve(null);
              },
            },
            {
              text: '自分の内容で上書き',
              style: 'destructive',
              onPress: () => { persist(rows, mealRev(e.current), true).then(resolve, reject); },
            },
          ],
          { cancelable: false },
        );
      });
    }
  };

  const handleSave = async () => {
    if (saving) return;
    if (drafts.length === 0) {
      Alert.alert('入力エラー', '料理を 1 品以上入れてください');
      return;
    }
    if (drafts.some((d) => !d.dish.trim())) {
      Alert.alert('入力エラー', '料理名が空の品があります');
      return;
    }
    setSaving(true);
    try {
      // 変えていなければ「確定」だけ（共有写真を消すまでの 7 日をここから数える）
      if (!changed && !needsReview && !isNewMeal) {
        await markSettled(mealId);
        onSaved();
        return;
      }
      // 共有の切り替えだけなら、中身（状態・推定の印）はそのままにする。手で直した扱い（edited）にすると、
      // 後から撮ったレシートとのひも付けの対象から外れてしまう
      if (shareChanged && !contentChanged && !needsReview && !isNewMeal) {
        const saved = await persist(loaded.map((r) => ({ ...r, shared: sharedFlag! })), baseRev);
        if (!saved) return;
        setLoaded(saved);
        setBaseRev(mealRev(saved));
        await ensureMealShared(saved, me);
        await markSettled(mealId);
        onSaved();
        return;
      }
      const list = await refreshNutrition(drafts);
      // 写真は保存できてから移す（失敗したときに画像が消えないように）
      const photoRef = target.mode === 'new' ? mealPhotoRef(target.photoUri) : null;
      const saved = await persist(buildRows(list, photoRef), baseRev);
      if (!saved) return;
      if (target.mode === 'new') archiveMealPhoto(target.photoUri);
      // 保存できた内容を手元にも反映する（この後の処理が失敗して保存し直したとき、自分の保存と競合したり、
      // 在庫を二重に減らしたりしないように）
      setLoaded(saved);
      setDrafts(toDrafts(saved));
      setBaseRev(mealRev(saved));
      // 候補から選んだ在庫の残りを、ここで初めて減らす
      await consume(list
        .filter((d) => d.chosen && d.chosen !== 'none')
        .map((d) => {
          const ref = pendingRef(d);
          return { itemId: d.chosen!, pieces: ref?.usedPieces, ratio: ref?.usedRatio };
        }));
      await logCorrections(corrections(list));
      await saveLabels(list);
      // 共有してから確定日時を書く（この保存で新しく共有した写真にも 7 日の期限を付ける）
      await ensureMealShared(saved, me);
      await markSettled(mealId);
      onSaved();
    } catch (e) {
      Alert.alert('保存失敗', e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  /** レシートから直後の食事として登録したもの（§5.7）。外すときは買った品を在庫に戻す */
  const fromReceipt = loaded.length > 0 && loaded.every((r) => r.assignedBy === 'receipt');

  const handleDelete = () => {
    Alert.alert(fromReceipt ? '食べていない食事として外しますか？' : 'この食事を削除しますか？', fromReceipt ? '買った品は在庫に戻ります' : undefined, [
      { text: 'キャンセル', style: 'cancel' },
      {
        text: fromReceipt ? '外す' : '削除する',
        style: 'destructive',
        onPress: async () => {
          if (!sheetName) { onSaved(); return; }
          setSaving(true);
          try {
            await deleteMeal(sheetName, mealId, baseRev, me);
            if (fromReceipt && loaded[0].entryId) {
              await restoreEntryItems(
                loaded[0].entryId, loaded[0].eatenAt.slice(0, 7).replace('/', '-'), [...new Set(loaded.map((r) => r.dish))],
              ).catch((e) =>
                console.warn('[Meal] 在庫に戻せなかった:', e instanceof Error ? e.message : e));
            }
            onSaved();
          } catch (e) {
            if (e instanceof MealConflictError) {
              Alert.alert('ほかの端末で先に保存されています', '内容を確認してから削除してください。');
              setLoaded(e.current);
              setDrafts(toDrafts(e.current));
              setBaseRev(mealRev(e.current));
            } else {
              Alert.alert('削除失敗', e instanceof Error ? e.message : String(e));
            }
          } finally {
            setSaving(false);
          }
        },
      },
    ]);
  };

  const openHistory = async () => {
    try {
      setHistory(await getMealHistory(mealId));
    } catch (e) {
      Alert.alert('読み込み失敗', e instanceof Error ? e.message : String(e));
    }
  };

  const restore = (entry: HistoryEntry) => {
    Alert.alert('この内容に戻しますか？', `${entry.rows[0]?.updatedAt || entry.savedAt} に${entry.rows[0]?.updatedBy || '不明'}が保存した内容`, [
      { text: 'キャンセル', style: 'cancel' },
      {
        text: '戻す',
        onPress: async () => {
          setSaving(true);
          try {
            const rows = entry.rows.map(({ rowIndex: _r, sheetName: _s, ...r }) => ({ ...r, deleted: false }));
            const saved = await persist(rows, baseRev);
            if (saved) {
              setHistory(null);
              onSaved();
            }
          } catch (e) {
            Alert.alert('戻せませんでした', e instanceof Error ? e.message : String(e));
          } finally {
            setSaving(false);
          }
        },
      },
    ]);
  };

  const people = partner ? [me, partner] : [me];

  return (
    <Modal visible animationType="slide" onRequestClose={onClose}>
      <SafeAreaView style={styles.container}>
        <View style={styles.header}>
          <Text style={styles.title}>{isNewMeal ? '食事を記録' : '食事'}</Text>
          <TouchableOpacity onPress={onClose}>
            <Text style={styles.headerBtn}>閉じる</Text>
          </TouchableOpacity>
        </View>

        {loading ? (
          <View style={styles.center}><ActivityIndicator /></View>
        ) : target.mode === 'edit' && loaded.length === 0 ? (
          // 推定は済んだが、記録がまだ未送信キューにあってシートに届いていない
          <View style={styles.center}>
            <Text style={styles.meta}>送信待ちです。通信が戻って送信されてから開いてください</Text>
          </View>
        ) : (
          <KeyboardAvoidingView style={styles.fill} behavior="height">
            <View style={styles.photoBox}>
              <MealPhotos
                mealId={mealId}
                photoRefs={photoRefs}
                entryIds={entryIds}
                height={200}
                extraUri={target.mode === 'new' ? target.photoUri : null}
              />
            </View>
            <ScrollView style={styles.fill} contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
              <Text style={styles.meta}>
                {eatenAt}{loaded[0]?.store ? `　${loaded[0].store}` : ''}
              </Text>
              {needsReview && <Text style={styles.reviewNote}>内容を確認して保存してください</Text>}
              {partner && (
                <View style={styles.shareRow}>
                  <Text style={styles.shareLabel}>{partner} と共有</Text>
                  <Switch
                    value={shared}
                    onValueChange={(v) => setSharedFlag(v)}
                    trackColor={{ false: '#ccc', true: '#a5d6a7' }}
                    thumbColor={shared ? '#2e7d32' : '#f4f3f4'}
                  />
                </View>
              )}

              {drafts.map((d) => {
                const shared = d.eaters.length > 1;
                const ratio = shared ? d.eaters.find((e) => e.user === me)?.portion ?? 0.5 : 1;
                return (
                  <View key={d.dishId} style={styles.card}>
                    <View style={styles.cardTop}>
                      <TextInput
                        style={styles.dishInput}
                        value={d.dish}
                        onChangeText={(t) => update(d.dishId, { dish: t })}
                      />
                      <TouchableOpacity onPress={() => setDrafts((prev) => prev.filter((x) => x.dishId !== d.dishId))}>
                        <Text style={styles.remove}>削除</Text>
                      </TouchableOpacity>
                    </View>
                    {d.choices.length > 0 && (
                      <View style={styles.choiceBox}>
                        <Text style={styles.choiceTitle}>どれですか？</Text>
                        <View style={styles.chips}>
                          {d.choices.map((c) => (
                            <View key={c.itemId} style={styles.choiceItem}>
                              <FoodThumb name={c.name} store={c.store} size={32} />
                              <Chip
                                small
                                label={`${c.name}（${c.store} ${c.bought}）`}
                                active={d.chosen === c.itemId}
                                onPress={() => update(d.dishId, { chosen: c.itemId })}
                              />
                            </View>
                          ))}
                          <Chip
                            small
                            label="どれでもない"
                            active={d.chosen === 'none'}
                            onPress={() => update(d.dishId, { chosen: 'none' })}
                          />
                        </View>
                      </View>
                    )}
                    <View style={styles.nutActions}>
                      {!d.isNew && (
                        <TouchableOpacity onPress={() => reresearch(d)}>
                          <Text style={styles.reresearch}>栄養を調べ直す</Text>
                        </TouchableOpacity>
                      )}
                      <TouchableOpacity onPress={() => setNutEdit({ dishId: d.dishId, label: null })}>
                        <Text style={styles.reresearch}>栄養を直す</Text>
                      </TouchableOpacity>
                      <TouchableOpacity onPress={() => shootLabel(d)} disabled={readingLabel !== null}>
                        <Text style={styles.reresearch}>{readingLabel === d.dishId ? '読み取り中...' : '表示を撮る'}</Text>
                      </TouchableOpacity>
                    </View>
                    {d.isNew ? (
                      <View style={styles.chips}>
                        {(['eat_out', 'packaged', 'home'] as const).map((k) => (
                          <Chip
                            key={k}
                            small
                            label={k === 'eat_out' ? '外食' : k === 'packaged' ? '商品' : '自炊'}
                            active={d.kind === k}
                            onPress={() => update(d.dishId, { kind: k })}
                          />
                        ))}
                      </View>
                    ) : (
                      <Text style={styles.sub}>
                        {kcal(d.whole)}（1品）
                        {d.nutrientSource === 'grounding' ? '・公式'
                          : d.nutrientSource === 'food_table' ? '・成分表'
                          : d.nutrientSource === 'label' ? '・表示'
                            : d.nutrientSource === 'manual' ? '・手入力' : '・推定'}
                      </Text>
                    )}

                    <View style={styles.chips}>
                      {people.map((p) => (
                        <Chip
                          key={p}
                          label={p}
                          active={!shared && d.eaters[0]?.user === p}
                          onPress={() => update(d.dishId, { eaters: [{ user: p, portion: 1 }] })}
                        />
                      ))}
                      {partner && (
                        <Chip
                          label="二人で"
                          active={shared}
                          onPress={() => update(d.dishId, {
                            eaters: [{ user: me, portion: 0.5 }, { user: partner, portion: 0.5 }],
                          })}
                        />
                      )}
                    </View>
                    {shared && partner && (
                      <View style={styles.chips}>
                        {RATIOS.map((r) => (
                          <Chip
                            key={r}
                            small
                            label={`${Math.round(r * 10)}:${Math.round((1 - r) * 10)}`}
                            active={Math.abs(ratio - r) < 0.01}
                            onPress={() => update(d.dishId, {
                              eaters: [{ user: me, portion: r }, { user: partner, portion: Math.round((1 - r) * 100) / 100 }],
                            })}
                          />
                        ))}
                        <Text style={styles.ratioLegend}>（{me}:{partner}）</Text>
                      </View>
                    )}
                  </View>
                );
              })}

              <View style={styles.addRow}>
                <TextInput
                  style={styles.addInput}
                  value={newDish}
                  onChangeText={setNewDish}
                  placeholder="品を追加"
                  onSubmitEditing={addDish}
                  returnKeyType="done"
                />
                <TouchableOpacity style={styles.addBtn} onPress={addDish}>
                  <Text style={styles.addBtnText}>追加</Text>
                </TouchableOpacity>
              </View>

              <TouchableOpacity
                style={[styles.saveBtn, saving && styles.disabled]}
                onPress={handleSave}
                disabled={saving}
              >
                {saving
                  ? <ActivityIndicator color="#fff" />
                  : <Text style={styles.saveText}>{changed || needsReview || isNewMeal ? '保存' : '確定'}</Text>}
              </TouchableOpacity>

              {!isNewMeal && (
                <View style={styles.footer}>
                  <TouchableOpacity onPress={openHistory}>
                    <Text style={styles.link}>以前の内容に戻す</Text>
                  </TouchableOpacity>
                  <TouchableOpacity onPress={handleDelete}>
                    <Text style={styles.danger}>{fromReceipt ? '食べていない（在庫に戻す）' : 'この食事を削除'}</Text>
                  </TouchableOpacity>
                </View>
              )}
            </ScrollView>
          </KeyboardAvoidingView>
        )}

        {/* 以前の内容 */}
        <Modal visible={history !== null} transparent animationType="fade" onRequestClose={() => setHistory(null)}>
          <View style={styles.backdrop}>
            <View style={styles.sheet}>
              <Text style={styles.sheetTitle}>以前の内容</Text>
              {history && history.length === 0 && <Text style={styles.sheetEmpty}>以前の内容はありません</Text>}
              <FlatList
                data={history ?? []}
                keyExtractor={(_h, i) => String(i)}
                renderItem={({ item }) => (
                  <TouchableOpacity style={styles.sheetItem} onPress={() => restore(item)}>
                    <Text style={styles.sheetItemTitle}>
                      {item.rows[0]?.updatedAt || item.savedAt}（{item.rows[0]?.updatedBy || '不明'}）
                    </Text>
                    <Text style={styles.sheetItemSub} numberOfLines={2}>
                      {[...new Set(item.rows.map((r) => r.dish))].join('・')}
                    </Text>
                  </TouchableOpacity>
                )}
              />
              <TouchableOpacity style={styles.sheetClose} onPress={() => setHistory(null)}>
                <Text style={styles.link}>閉じる</Text>
              </TouchableOpacity>
            </View>
          </View>
        </Modal>

        {/* 栄養を直す（包装の表示を読んだときは、食べた量を入れる） */}
        <NutrientEditModal
          visible={nutEdit !== null}
          title={drafts.find((d) => d.dishId === nutEdit?.dishId)?.dish ?? ''}
          initial={drafts.find((d) => d.dishId === nutEdit?.dishId)?.whole ?? sanitizeNutrients({})}
          label={nutEdit?.label ?? null}
          onClose={() => setNutEdit(null)}
          onSave={(n) => nutEdit && applyNutrients(nutEdit.dishId, n, nutEdit.label)}
        />
      </SafeAreaView>
    </Modal>
  );
}

function Chip({ label, active, onPress, small }: { label: string; active: boolean; onPress: () => void; small?: boolean }) {
  return (
    <TouchableOpacity style={[styles.chip, small && styles.chipSmall, active && styles.chipActive]} onPress={onPress}>
      <Text style={[styles.chipText, active && styles.chipTextActive]}>{label}</Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f2f4f7' },
  fill:      { flex: 1 },
  center:    { flex: 1, alignItems: 'center', justifyContent: 'center' },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 16, paddingVertical: 12, backgroundColor: '#fff',
    borderBottomWidth: 1, borderBottomColor: '#eee',
  },
  title:     { fontSize: 18, fontWeight: 'bold', color: '#222' },
  headerBtn: { fontSize: 15, color: '#2563eb', fontWeight: '600' },
  photoBox:  { paddingHorizontal: 16, paddingTop: 12 },
  body:      { padding: 16, gap: 12, paddingBottom: 40 },
  meta:      { fontSize: 13, color: '#6b7280' },
  reviewNote: { fontSize: 13, color: '#b45309', fontWeight: '600' },
  card:      { backgroundColor: '#fff', borderRadius: 16, padding: 14, gap: 8 },
  cardTop:   { flexDirection: 'row', alignItems: 'center', gap: 8 },
  dishInput: {
    flex: 1, fontSize: 16, fontWeight: '600', color: '#111',
    borderBottomWidth: 1, borderBottomColor: '#e5e7eb', paddingVertical: 4,
  },
  remove:    { color: '#dc2626', fontSize: 13, fontWeight: '600' },
  sub:       { fontSize: 12, color: '#6b7280' },
  chips:     { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8 },
  chip: {
    paddingHorizontal: 14, paddingVertical: 6, borderRadius: 16,
    borderWidth: 1, borderColor: '#d1d5db', backgroundColor: '#fff',
  },
  chipSmall:      { paddingHorizontal: 10, paddingVertical: 4 },
  chipActive:     { backgroundColor: '#2e7d32', borderColor: '#2e7d32' },
  chipText:       { fontSize: 13, color: '#374151', fontWeight: '600' },
  chipTextActive: { color: '#fff' },
  ratioLegend:    { fontSize: 12, color: '#6b7280' },
  choiceBox:      { gap: 6, backgroundColor: '#fffbeb', borderRadius: 10, padding: 10 },
  choiceTitle:    { fontSize: 13, color: '#b45309', fontWeight: '700' },
  shareRow:       { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: '#fff', borderRadius: 12, paddingHorizontal: 12, paddingVertical: 4 },
  shareLabel:     { fontSize: 14, color: '#1f2937' },
  choiceItem:     { flexDirection: 'row', alignItems: 'center', gap: 4 },
  reresearch:     { fontSize: 12, color: '#2563eb', fontWeight: '600' },
  nutActions:     { flexDirection: 'row', gap: 16, flexWrap: 'wrap' },
  addRow:    { flexDirection: 'row', gap: 8 },
  addInput: {
    flex: 1, backgroundColor: '#fff', borderRadius: 12, paddingHorizontal: 14, paddingVertical: 10,
    fontSize: 15, borderWidth: 1, borderColor: '#e5e7eb',
  },
  addBtn:     { backgroundColor: '#fff', borderRadius: 12, paddingHorizontal: 16, justifyContent: 'center', borderWidth: 1, borderColor: '#2e7d32' },
  addBtnText: { color: '#2e7d32', fontWeight: '600' },
  saveBtn:   { backgroundColor: '#2e7d32', borderRadius: 12, paddingVertical: 14, alignItems: 'center', marginTop: 8 },
  saveText:  { color: '#fff', fontSize: 16, fontWeight: '600' },
  disabled:  { opacity: 0.6 },
  footer:    { flexDirection: 'row', justifyContent: 'space-between', marginTop: 8 },
  link:      { color: '#2563eb', fontSize: 14, fontWeight: '600' },
  danger:    { color: '#dc2626', fontSize: 14, fontWeight: '600' },
  backdrop:  { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'center', alignItems: 'center' },
  sheet:     { backgroundColor: '#fff', borderRadius: 16, width: '85%', maxHeight: '70%', paddingVertical: 12 },
  sheetTitle: { fontSize: 16, fontWeight: 'bold', paddingHorizontal: 16, paddingBottom: 8 },
  sheetEmpty: { paddingHorizontal: 16, color: '#6b7280' },
  sheetItem:  { paddingHorizontal: 16, paddingVertical: 10, borderTopWidth: 1, borderTopColor: '#f3f4f6' },
  sheetItemTitle: { fontSize: 14, color: '#111', fontWeight: '600' },
  sheetItemSub:   { fontSize: 12, color: '#6b7280', marginTop: 2 },
  sheetClose: { alignItems: 'center', paddingTop: 10 },
});
