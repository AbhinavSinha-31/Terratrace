import net from 'node:net';
import { defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Dev server: /api is proxied to the TERRATRACE backend (default 127.0.0.1:8001).
// Override with TT_API_PROXY; it is read here only (not a VITE_ variable), so it never reaches the browser.
const apiTarget = process.env.TT_API_PROXY || 'http://127.0.0.1:8001';
const DEV_PORT = 5173;

/**
 * "localhost" resolves to ::1 first on Windows, but the dev server binds only 127.0.0.1 (binding "::" or 0.0.0.0
 * would expose it to the LAN). This forwards [::1]:5173 to 127.0.0.1:5173 at the TCP level (HMR websockets
 * included), so http://localhost:5173 and http://127.0.0.1:5173 both work and the server stays loopback-only.
 */
function ipv6LoopbackForward(): Plugin {
  return {
    name: 'tt-ipv6-loopback-forward',
    apply: 'serve',
    configureServer(server) {
      const fwd = net.createServer((client) => {
        const upstream = net.connect(DEV_PORT, '127.0.0.1');
        client.pipe(upstream).pipe(client);
        client.on('error', () => upstream.destroy());
        upstream.on('error', () => client.destroy());
      });
      fwd.on('error', (e: NodeJS.ErrnoException) => {
        // IPv6 disabled, or ::1:5173 already taken: 127.0.0.1 still works, so warn and carry on.
        server.config.logger.warn(`[::1]:${DEV_PORT} forward unavailable (${e.code}); use http://127.0.0.1:${DEV_PORT}`);
      });
      fwd.listen(DEV_PORT, '::1');
      server.httpServer?.once('close', () => fwd.close());
    },
  };
}

/**
 * Production builds: link-preview tags need ABSOLUTE URLs, so "/og-image.png" in index.html becomes VITE_SITE_URL +
 * "/og-image.png" (left relative when VITE_SITE_URL is unset). Also warns when no backend URL is configured: the
 * bundle then calls "/api" on its own host, which only works when the backend serves the frontend (single-port mode).
 */
function productionSiteConfig(env: Record<string, string>): Plugin {
  const site = (env.VITE_SITE_URL || '').replace(/\/+$/, '');
  return {
    name: 'tt-production-site-config',
    apply: 'build',
    configResolved(cfg) {
      if (!env.VITE_API_URL && !env.VITE_API_BASE) {
        cfg.logger.warn('[terratrace] VITE_API_URL is not set: the build will call /api on its own host. On Vercel, set VITE_API_URL to the backend URL.');
      }
    },
    transformIndexHtml(html) {
      if (!site) return html;
      return html
        .replaceAll('content="/og-image.png"', `content="${site}/og-image.png"`)
        .replace('<meta property="og:type"', `<meta property="og:url" content="${site}/" />\n    <meta property="og:type"`);
    },
  };
}

export default defineConfig(({ mode }) => ({
  plugins: [react(), tailwindcss(), ipv6LoopbackForward(), productionSiteConfig(loadEnv(mode, process.cwd(), 'VITE_'))],
  server: {
    // IPv4 loopback: Node's default "localhost" can bind only ::1, which refuses http://127.0.0.1:5173.
    host: '127.0.0.1',
    port: DEV_PORT,
    strictPort: true,   // fail loudly if 5173 is taken instead of silently moving to another port
    proxy: {
      '/api': { target: apiTarget, changeOrigin: true },
    },
  },
  build: {
    chunkSizeWarningLimit: 1600,
    rollupOptions: {
      output: {
        // Only the libraries' own modules go into these chunks. Rollup's shared CommonJS helper gets a tiny chunk of
        // its own: otherwise it lands in the maplibre chunk and the entry imports (and preloads) all of MapLibre.
        manualChunks(id) {
          if (id.includes('commonjsHelpers')) return 'cjs-helpers';
          if (id.includes('/node_modules/maplibre-gl/')) return 'maplibre';
          if (id.includes('/node_modules/echarts/') || id.includes('/node_modules/zrender/')) return 'echarts';
          return undefined;
        },
      },
    },
  },
}));
