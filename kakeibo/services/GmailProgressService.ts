/**
 * Gmail 取り込み処理の進捗をグローバルに公開する簡易 pub-sub。
 * UI 側（SummaryScreen のバナー）が `useGmailProgress` で購読する。
 */

import { useEffect, useState } from 'react';

export interface GmailProgress {
  running:   boolean;
  current:   number;
  total:     number;
  phase:     string; // 表示用ラベル（例: "検索中..." "処理中 3/15"）
  // 完了後 3 秒間だけ true にして結果を出す
  finished:  boolean;
  result?: {
    imported: number;
    skipped:  number;
    failed:   number;
  };
}

const INITIAL: GmailProgress = {
  running:  false,
  current:  0,
  total:    0,
  phase:    '',
  finished: false,
};

let snapshot: GmailProgress = INITIAL;
const listeners = new Set<(p: GmailProgress) => void>();

function publish(next: GmailProgress) {
  snapshot = next;
  listeners.forEach((l) => l(snapshot));
}

/** 現在のスナップショットを返す */
export function getSnapshot(): GmailProgress {
  return snapshot;
}

/** 取り込み開始 */
export function begin(phase: string): void {
  publish({
    running:  true,
    current:  0,
    total:    0,
    phase,
    finished: false,
  });
}

/** 進捗更新 */
export function update(patch: Partial<GmailProgress>): void {
  publish({ ...snapshot, ...patch });
}

/** 完了通知: 3 秒間バナーに結果を残してからクリアする */
export function finish(result: GmailProgress['result']): void {
  publish({
    running:  false,
    current:  snapshot.current,
    total:    snapshot.total,
    phase:    '完了',
    finished: true,
    result,
  });
  setTimeout(() => {
    // 完了後に別のランが始まっていなければクリア
    if (!snapshot.running) publish(INITIAL);
  }, 3000);
}

/** 失敗時も finish と同じく 3 秒表示 */
export function fail(message: string): void {
  publish({
    running:  false,
    current:  snapshot.current,
    total:    snapshot.total,
    phase:    `失敗: ${message}`,
    finished: true,
  });
  setTimeout(() => {
    if (!snapshot.running) publish(INITIAL);
  }, 3000);
}

/** React フック: 現在の進捗を state として購読する */
export function useGmailProgress(): GmailProgress {
  const [state, setState] = useState<GmailProgress>(snapshot);
  useEffect(() => {
    const listener = (p: GmailProgress) => setState(p);
    listeners.add(listener);
    // マウント時点の最新値に同期
    setState(snapshot);
    return () => {
      listeners.delete(listener);
    };
  }, []);
  return state;
}
