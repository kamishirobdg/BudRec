/**
 * アプリを開いていない間も、推定待ち（無料枠切れ）の画像を処理し直すための定期実行。
 *
 * Android の WorkManager（expo-background-task）で動く。**最短 15 分間隔で、正確な時刻には
 * 動かない**（端末がスリープしていると数時間遅れることもある）。アプリを開いたときにも
 * 同じ処理が走るので、こちらは「開かなくても進む」ための補助。
 *
 * タスクの定義はアプリの JS が読み込まれた直後（index.ts）に済ませておく必要がある。
 * 裏で起こされたときは画面を描画せずにこのファイルの定義だけが使われるため。
 */

import * as BackgroundTask from 'expo-background-task';
import * as TaskManager from 'expo-task-manager';
import * as OcrWorker from './OcrWorker';
import { isSignedIn } from './AuthService';
import { isUserNameSet } from './UserService';

const TASK_NAME = 'budrec-deferred-ocr';

TaskManager.defineTask(TASK_NAME, async () => {
  try {
    // サインイン前・ユーザー名の設定前は、App と同じく処理しない
    if (!(await isSignedIn()) || !(await isUserNameSet())) return BackgroundTask.BackgroundTaskResult.Success;
    await OcrWorker.runPending();
    return BackgroundTask.BackgroundTaskResult.Success;
  } catch (e) {
    console.warn('[BackgroundOcr] 失敗:', e instanceof Error ? e.message : e);
    return BackgroundTask.BackgroundTaskResult.Failed;
  }
});

/** 定期実行を登録する（登録済みなら何もしない）。失敗しても投げない */
export async function registerBackgroundOcr(): Promise<void> {
  try {
    const status = await BackgroundTask.getStatusAsync();
    if (status !== BackgroundTask.BackgroundTaskStatus.Available) return;
    if (await TaskManager.isTaskRegisteredAsync(TASK_NAME)) return;
    await BackgroundTask.registerTaskAsync(TASK_NAME, { minimumInterval: 15 });
  } catch (e) {
    console.warn('[BackgroundOcr] 定期実行を登録できなかった:', e instanceof Error ? e.message : e);
  }
}
