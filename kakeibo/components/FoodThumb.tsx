import { useEffect, useState } from 'react';
import { Image, StyleSheet } from 'react-native';
import { foodKey, loadFoods } from '../services/FoodService';
import { downloadFoodImage } from '../services/FoodImages';

/** 品目のパッケージ画像（食品データに画像が無ければ何も出さない） */
export default function FoodThumb({ name, size = 40 }: { name: string; size?: number }) {
  const [uri, setUri] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    loadFoods()
      .then((foods) => {
        const food = foods.get(foodKey(name));
        return food ? downloadFoodImage(food) : null;
      })
      .then((u) => { if (alive) setUri(u); })
      .catch(() => { /* 画像が出ないだけ */ });
    return () => { alive = false; };
  }, [name]);

  if (!uri) return null;
  return <Image source={{ uri }} style={[styles.img, { width: size, height: size }]} resizeMode="contain" />;
}

const styles = StyleSheet.create({
  img: { borderRadius: 8, backgroundColor: '#fff' },
});
