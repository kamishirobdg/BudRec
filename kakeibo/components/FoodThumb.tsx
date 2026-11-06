import { useEffect, useState } from 'react';
import { Image, StyleSheet } from 'react-native';
import { findFood, loadFoods } from '../services/FoodService';
import { downloadFoodImage } from '../services/FoodImages';

/** 品目のパッケージ画像（食品データに画像が無ければ何も出さない） */
export default function FoodThumb({ name, store = '', size = 40 }: { name: string; store?: string; size?: number }) {
  const [uri, setUri] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    loadFoods()
      .then((foods) => {
        const food = findFood(foods, name, store);
        return food ? downloadFoodImage(food) : null;
      })
      .then((u) => { if (alive) setUri(u); })
      .catch(() => { /* 画像が出ないだけ */ });
    return () => { alive = false; };
  }, [name, store]);

  if (!uri) return null;
  return <Image source={{ uri }} style={[styles.img, { width: size, height: size }]} resizeMode="contain" />;
}

const styles = StyleSheet.create({
  img: { borderRadius: 8, backgroundColor: '#fff' },
});
