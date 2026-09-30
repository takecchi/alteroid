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
  build: {
    /**
     * フォントのファイルだけは CSS へ base64 で埋め込まない（`/assets/…` の URL 参照にする）。
     *
     * 既定（4096 B 未満は base64 化）のままだと、IBM Plex Sans JP の小さい断片
     * （太さ3 × 8 断片 × woff2 / woff）が `url(data:font/…)` として CSS に入る。
     * すると `unicode-range` に関係なく、CSS と一緒にその本体（生で約 200 KB）が
     * 最初に落ちてくる。`packages/ui/src/styles.css` の冒頭が想定している
     * 「画面が実際に使う字の断片しか落ちてこない」は、埋め込まれた断片には効かない。
     *
     * 関数形の戻り値は、`boolean` ならそれが答えで、`undefined` なら Vite 既定の
     * 判定（4096 B のしきい値）に落ちる（vite 8.3.1 の `shouldInline`）。
     * だからフォント以外（画像など）には `undefined` を返して、扱いを変えない。
     */
    assetsInlineLimit: (filePath) =>
      /\.(woff2?|ttf|otf|eot)$/i.test(filePath) ? false : undefined,
  },
  server: {
    port: 5173,
    /**
     * 開発中は同一オリジンに見せる。
     *
     * こうしておくと**開発のためだけにデーモンへ CORS を開ける必要がなくなる**。
     * 既定の接続先が同一オリジンの `/api`（`packages/logic/src/config.ts`）なので、ここを
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
