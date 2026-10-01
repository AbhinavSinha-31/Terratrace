import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Dev server: /api is proxied to the TERRATRACE backend (default 127.0.0.1:8001).
// Override with TT_API_PROXY; it is read here only (not a VITE_ variable), so it never reaches the browser.
const apiTarget = process.env.TT_API_PROXY || 'http://127.0.0.1:8001';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    // IPv4 loopback: Node's default "localhost" can bind only ::1, which refuses http://127.0.0.1:5173.
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,   // fail loudly if 5173 is taken instead of silently moving to another port
    proxy: {
      '/api': { target: apiTarget, changeOrigin: true },
    },
  },
  build: {
    chunkSizeWarningLimit: 1600,
    rollupOptions: {
      output: {
        manualChunks: {
          maplibre: ['maplibre-gl'],
          echarts: ['echarts'],
        },
      },
    },
  },
});
