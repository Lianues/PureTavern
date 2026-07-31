import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.puretavern.app',
  appName: 'PureTavern',
  webDir: '../web/dist',
  backgroundColor: '#171717',
  android: {
    allowMixedContent: true,
  },
  ios: {
    contentInset: 'never',
  },
  server: {
    androidScheme: 'https',
    cleartext: true,
  },
  plugins: {
    SystemBars: {
      hidden: true,
    },
  },
};

export default config;
