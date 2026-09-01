import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dev: panel-api działa na hoście (npm run dev -w apps/panel-api, port 8080) —
// proxy przekazuje API/auth, żeby cookie sesyjne było same-origin.
const apiOrigin = process.env['PANEL_API_ORIGIN'] ?? 'http://localhost:8080';

export default defineConfig({
  plugins: [react()],
  base: './',
  build: { outDir: 'dist' },
  server: {
    proxy: {
      '/api': apiOrigin,
      '/auth': apiOrigin,
      '/healthz': apiOrigin,
    },
  },
});
