// The Android app around the web layer in dist/ (vite build). Package id: permanent once published; confirm with the owner first.
import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.sickofpdfs.reader',
  appName: 'sickofpdfs',
  webDir: 'dist',
  // The app's pages are served from https://localhost inside the phone; nothing is fetched from the network.
  server: { androidScheme: 'https', hostname: 'localhost' },
  android: { allowMixedContent: false },
  plugins: {
    // The system bars keep their own space; the pages never draw under them.
    SystemBars: { insetsHandling: 'css' },
  },
};

export default config;
