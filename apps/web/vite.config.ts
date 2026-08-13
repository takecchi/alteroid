import { reactRouter } from '@react-router/dev/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

/** 開発時に画面が繋ぎに行くデーモン。既定はデーモンの既定ポート。 */
const daemonUrl = process.env.ALTEROID_API_URL ?? 'http://127.0.0.1:4517';

export default defineConfig({
  // `tailwindcss()` は `reactRouter()` より前（CSS の変換が先に要る）。
  plugins: [tailwindcss(), reactRouter()],
  // `~/*` を tsconfig の paths から解く（vite 8 の native 解決。専用プラグインは要らない）。
  resolve: { tsconfigPaths: true },
  server: {
    port: 5173,
    /**
     * 開発中は同一オリジンに見せる。
     *
     * こうしておくと**開発のためだけにデーモンへ CORS を開ける必要がなくなる**。
     * 既定の接続先が同一オリジンの `/api`（`app/lib/config.ts`）なので、ここを
     * 通せば素の `alteroid daemon start` に対してそのまま開発できる。
     */
    proxy: {
      '/api': {
        target: daemonUrl,
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ''),
        // SSE（`POST /chat` と `GET /journal/stream`）を溜め込ませない。
        configure: (proxy) => {
          proxy.on('proxyRes', (proxyRes) => {
            if (proxyRes.headers['content-type']?.includes('text/event-stream')) {
              proxyRes.headers['cache-control'] = 'no-cache, no-transform';
            }
          });
        },
      },
    },
  },
});
