import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: '/OptiCode-Studio/',
  build: {
    // Keep a deterministic build manifest so the service worker can
    // precache every generated JS/CSS/worker asset for true offline startup.
    manifest: 'manifest.json',
  },
});
