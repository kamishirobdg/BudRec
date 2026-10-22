/**
 * 画面をまたぐ小さな通知。設定はどのタブからでも開けるので、閉じたときに一覧を読み直す
 * （デモモードの切り替えなどを反映するため）。
 */

const settingsClosedListeners = new Set<() => void>();

export function emitSettingsClosed(): void {
  for (const l of settingsClosedListeners) l();
}

export function onSettingsClosed(listener: () => void): () => void {
  settingsClosedListeners.add(listener);
  return () => { settingsClosedListeners.delete(listener); };
}
