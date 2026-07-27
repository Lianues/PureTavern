import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.puretavern.app',
  appName: 'PureTavern',
  webDir: '../web/dist',
  ios: {
    contentInset: 'always',
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
