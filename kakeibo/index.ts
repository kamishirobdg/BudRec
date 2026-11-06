import { registerRootComponent } from 'expo';

import App from './App';
// 定期実行のタスク定義。裏で起こされたときにも定義済みである必要があるので、ここで読み込む
import './services/BackgroundOcr';

// registerRootComponent calls AppRegistry.registerComponent('main', () => App);
// It also ensures that whether you load the app in Expo Go or in a native build,
// the environment is set up appropriately
registerRootComponent(App);
