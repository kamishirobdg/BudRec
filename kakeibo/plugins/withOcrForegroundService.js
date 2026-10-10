// react-native-background-actions のサービスに foregroundServiceType を宣言する。
// ライブラリ側のマニフェストには型が無く、Android 14 以降は宣言の無い型で
// startForeground するとアプリが落ちる。
const { withAndroidManifest, AndroidConfig } = require('expo/config-plugins');

const SERVICE_NAME = 'com.asterinet.react.bgactions.RNBackgroundActionsTask';
const PERMISSIONS = [
  'android.permission.FOREGROUND_SERVICE',
  'android.permission.FOREGROUND_SERVICE_DATA_SYNC',
];

module.exports = function withOcrForegroundService(config) {
  config = AndroidConfig.Permissions.withPermissions(config, PERMISSIONS);
  return withAndroidManifest(config, (cfg) => {
    const app = AndroidConfig.Manifest.getMainApplicationOrThrow(cfg.modResults);
    app.service = (app.service ?? []).filter((s) => s.$['android:name'] !== SERVICE_NAME);
    app.service.push({
      $: {
        'android:name': SERVICE_NAME,
        'android:exported': 'false',
        'android:foregroundServiceType': 'dataSync',
      },
    });
    return cfg;
  });
};
