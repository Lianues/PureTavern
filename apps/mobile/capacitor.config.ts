import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.puretavern.app',
  appName: 'PureTavern',
  webDir: '../web/dist',
  backgroundColor: '#171717',
  ios: {
    contentInset: 'never',
  },
  server: {
    androidScheme: 'https',
  },
  plugins: {
    SystemBars: {
      hidden: true,
    },
  },
};

export default config;
