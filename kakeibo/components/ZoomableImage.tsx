import { useEffect, useState } from 'react';
import { Image, LayoutChangeEvent, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';

const ZOOM_LEVELS = [1, 2, 3, 4];

interface Props {
  uri:    string;
  height: number;
}

/**
 * 枠内で拡大・スクロールできる画像。
 * Android の ScrollView はピンチズームに対応していないので、＋/− ボタンで倍率を切り替え、
 * 縦横の ScrollView を入れ子にして拡大後の画像を動かす。
 */
export default function ZoomableImage({ uri, height }: Props) {
  const [boxWidth, setBoxWidth] = useState(0);
  const [aspect, setAspect]     = useState<number | null>(null);
  const [zoomIndex, setZoomIndex] = useState(0);

  useEffect(() => {
    setZoomIndex(0);
    setAspect(null);
    Image.getSize(uri, (w, h) => { if (w > 0 && h > 0) setAspect(w / h); }, () => setAspect(null));
  }, [uri]);

  const onLayout = (e: LayoutChangeEvent) => setBoxWidth(e.nativeEvent.layout.width);

  const zoom = ZOOM_LEVELS[zoomIndex];
  let fitW = boxWidth;
  let fitH = height;
  if (aspect && boxWidth > 0) {
    if (aspect > boxWidth / height) fitH = boxWidth / aspect;
    else fitW = height * aspect;
  }
  const imgW = fitW * zoom;
  const imgH = fitH * zoom;

  return (
    <View style={[styles.box, { height }]} onLayout={onLayout}>
      {boxWidth > 0 && (
        <ScrollView
          nestedScrollEnabled
          contentContainerStyle={{ minHeight: height, justifyContent: 'center' }}
        >
          <ScrollView
            horizontal
            nestedScrollEnabled
            contentContainerStyle={{ minWidth: boxWidth, justifyContent: 'center', alignItems: 'center' }}
          >
            <Image source={{ uri }} style={{ width: imgW, height: imgH }} resizeMode="contain" />
          </ScrollView>
        </ScrollView>
      )}
      <View style={styles.controls}>
        <TouchableOpacity
          style={[styles.zoomBtn, zoomIndex === 0 && styles.zoomBtnDisabled]}
          onPress={() => setZoomIndex((i) => Math.max(0, i - 1))}
          disabled={zoomIndex === 0}
        >
          <Text style={styles.zoomBtnText}>−</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.zoomBtn, zoomIndex === ZOOM_LEVELS.length - 1 && styles.zoomBtnDisabled]}
          onPress={() => setZoomIndex((i) => Math.min(ZOOM_LEVELS.length - 1, i + 1))}
          disabled={zoomIndex === ZOOM_LEVELS.length - 1}
        >
          <Text style={styles.zoomBtnText}>＋</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  box: {
    width: '100%',
    backgroundColor: '#f3f4f6',
    borderRadius: 8,
    overflow: 'hidden',
  },
  controls: {
    position: 'absolute',
    right: 8,
    bottom: 8,
    flexDirection: 'row',
    gap: 8,
  },
  zoomBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: 'rgba(0,0,0,0.55)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  zoomBtnDisabled: { backgroundColor: 'rgba(0,0,0,0.2)' },
  zoomBtnText:     { color: '#fff', fontSize: 22, fontWeight: '600', lineHeight: 26 },
});
