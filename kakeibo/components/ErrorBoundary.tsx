/**
 * 描画中の例外を受け止めて、白画面ではなく復帰できる画面を出す。
 *
 * React はレンダリング中に例外が起きるとツリー全体をアンマウントする。
 * ErrorBoundary が無いと画面が真っ白になり、アプリを再起動するしか手が無い。
 *
 * 拾えないもの（React の仕様）:
 *  - イベントハンドラ内の例外（各画面の try/catch で処理している）
 *  - 非同期処理（Promise）の中の例外
 *  - このコンポーネント自身の描画エラー
 */

import { Component, ErrorInfo, ReactNode } from 'react';
import {
  Platform,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';

interface Props {
  children: ReactNode;
  /** 再試行が押されたときの後始末（キャッシュ破棄など）。省略可 */
  onReset?: () => void;
}

interface State {
  error:          Error | null;
  componentStack: string;
  showDetail:     boolean;
  /** 再試行のたびに増やして子ツリーを作り直す */
  resetKey:       number;
}

export default class ErrorBoundary extends Component<Props, State> {
  state: State = {
    error:          null,
    componentStack: '',
    showDetail:     false,
    resetKey:       0,
  };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // 実機ではこのログが唯一の手がかりになる（adb logcat / Metro のコンソール）
    console.error('[ErrorBoundary]', error, info.componentStack);
    this.setState({ componentStack: info.componentStack ?? '' });
  }

  private handleReset = (): void => {
    this.props.onReset?.();
    this.setState((prev) => ({
      error:          null,
      componentStack: '',
      showDetail:     false,
      resetKey:       prev.resetKey + 1,
    }));
  };

  private toggleDetail = (): void => {
    this.setState((prev) => ({ showDetail: !prev.showDetail }));
  };

  render(): ReactNode {
    const { error, componentStack, showDetail, resetKey } = this.state;

    if (!error) {
      // key を変えることで、再試行時に子ツリーを確実に作り直す
      return <View key={resetKey} style={styles.flex}>{this.props.children}</View>;
    }

    const message = error.message || String(error);

    return (
      <View style={styles.container}>
        <View style={styles.card}>
          <Text style={styles.icon}>⚠️</Text>
          <Text style={styles.title}>予期しないエラーが発生しました</Text>
          <Text style={styles.lead}>
            アプリを再起動しなくても、下のボタンでやり直せます。
            繰り返し出る場合はエラー内容を控えてください。
          </Text>

          <View style={styles.messageBox}>
            <Text style={styles.messageText} selectable>{message}</Text>
          </View>

          <TouchableOpacity style={styles.primaryBtn} onPress={this.handleReset}>
            <Text style={styles.primaryBtnText}>再試行</Text>
          </TouchableOpacity>

          <TouchableOpacity style={styles.detailToggle} onPress={this.toggleDetail}>
            <Text style={styles.detailToggleText}>
              {showDetail ? '詳細を隠す' : '詳細を表示'}
            </Text>
          </TouchableOpacity>

          {showDetail && (
            <ScrollView style={styles.detailBox} nestedScrollEnabled>
              <Text style={styles.detailText} selectable>
                {error.stack ?? '(スタックトレースなし)'}
                {componentStack ? `\n--- component stack ---${componentStack}` : ''}
              </Text>
            </ScrollView>
          )}
        </View>
      </View>
    );
  }
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  container: {
    flex:              1,
    backgroundColor:   '#f2f4f7',
    justifyContent:    'center',
    paddingHorizontal: 20,
    // SafeAreaProvider の外側で描画されるので自前でステータスバーを避ける
    paddingTop:        Platform.OS === 'android' ? StatusBar.currentHeight ?? 0 : 0,
  },
  card: {
    backgroundColor: '#fff',
    borderRadius:    20,
    padding:         24,
    elevation:       2,
    shadowColor:     '#000',
    shadowOpacity:   0.08,
    shadowRadius:    12,
    shadowOffset:    { width: 0, height: 4 },
  },
  icon: {
    fontSize:     40,
    textAlign:    'center',
    marginBottom: 12,
  },
  title: {
    fontSize:     18,
    fontWeight:   'bold',
    color:        '#111827',
    textAlign:    'center',
    marginBottom: 10,
  },
  lead: {
    fontSize:     14,
    lineHeight:   21,
    color:        '#4b5563',
    textAlign:    'center',
    marginBottom: 18,
  },
  messageBox: {
    backgroundColor: '#fef2f2',
    borderRadius:    12,
    padding:         14,
    marginBottom:    20,
  },
  messageText: {
    fontSize:   13,
    lineHeight: 19,
    color:      '#b91c1c',
  },
  primaryBtn: {
    backgroundColor: '#2e7d32',
    borderRadius:    16,
    paddingVertical: 14,
    alignItems:      'center',
  },
  primaryBtnText: {
    color:      '#fff',
    fontSize:   16,
    fontWeight: 'bold',
  },
  detailToggle: {
    alignItems: 'center',
    paddingVertical: 12,
  },
  detailToggleText: {
    fontSize: 13,
    color:    '#6b7280',
  },
  detailBox: {
    maxHeight:       220,
    backgroundColor: '#111827',
    borderRadius:    12,
    padding:         12,
  },
  detailText: {
    fontSize:   11,
    lineHeight: 16,
    color:      '#e5e7eb',
    fontFamily: Platform.OS === 'android' ? 'monospace' : 'Menlo',
  },
});
