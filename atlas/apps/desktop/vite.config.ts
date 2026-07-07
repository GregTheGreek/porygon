import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Tauri expects a fixed dev port (see devUrl in tauri.conf.json); fail loudly
// if it's already in use rather than silently picking another.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
    watch: {
      ignored: ['**/target/**'],
    },
  },
});
