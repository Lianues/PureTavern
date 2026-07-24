import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.puretavern.app',
  appName: 'PureTavern',
  webDir: '../web/dist',
  server: {
    androidScheme: 'https',
  },
};

export default config;
