import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Dev: panel-api działa na hoście (npm run dev -w apps/panel-api, port 8080) —
// proxy przekazuje API/auth, żeby cookie sesyjne było same-origin.
const apiOrigin = process.env['PANEL_API_ORIGIN'] ?? 'http://localhost:8080';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  // Panel jest ZAWSZE serwowany z korzenia domeny (kag.…/), a panel-api ma
  // fallback SPA na dowolną ścieżkę nie-API. Przy relatywnym base wejście pod
  // adres z końcowym ukośnikiem (np. /inbox/) kazało przeglądarce szukać
  // assets/index-*.js pod /inbox/assets/… — fallback zwracał index.html
  // z content-type text/html, moduł leciał na kontroli MIME i renderowała się
  // BIAŁA STRONA. Bezwzględny base usuwa problem u źródła.
  base: '/',
  build: { outDir: 'dist' },
  server: {
    proxy: {
      '/api': apiOrigin,
      '/auth': apiOrigin,
      '/healthz': apiOrigin,
    },
  },
});
