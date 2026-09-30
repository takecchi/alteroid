import { reactRouter } from '@react-router/dev/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

/** 開発時に画面が繋ぎに行くデーモン。既定はデーモンの既定ポート。 */
const daemonUrl = process.env.ALTEROID_API_URL ?? 'http://127.0.0.1:4517';

/** `src` の中の `url(...) format('woff')`（woff v1）の1項。前の `,` ごと取る。woff2 には当たらない。 */
const WOFF1_SRC_ENTRY = /,\s*url\([^)]*\)\s*format\(\s*(['"]?)woff\1\s*\)/gi;

/**
 * `@font-face` の `src` から woff（v1）の項だけを落とす PostCSS プラグイン。
 *
 * `@fontsource/*` の CSS は全 face が `src: url(….woff2) format('woff2'), url(….woff) format('woff')`
 * の2本立てで、woff は woff2 を読めない古いブラウザ向けの後備え。build の target
 * （Vite 8 既定の baseline-widely-available: chrome111 / edge111 / firefox114 / safari16.4）は
 * すべて woff2 を読むので、後備えは読まれないまま CSS と assets を太らせるだけになる。
 *
 * なぜ PostCSS プラグインか（位置の理由）:
 * - `@tailwindcss/vite` は `enforce: 'pre'` の transform で `@import`（`@fontsource/*` を含む）を
 *   展開した CSS を出す。Vite 組み込みの `vite:css` はその後に走り、そこで `css.postcss` を回す。
 *   だから展開後の `@font-face` がこのプラグインに届く。
 * - `vite:css` は PostCSS の後で `url()` を解決して assets へ出す。この時点で woff の項を
 *   落とせば、woff のファイルは参照されず出力されない（`assetsInlineLimit` の話とは独立）。
 * - `@fontsource/*` の CSS を repo に写して書き換える形は、版を上げたとき追随が崩れるので避けた。
 *   これは元の CSS に触れず、build のたびに落とすだけなので版の追随が要らない。
 *
 * 落とすのは、woff2 の項が1つ以上残るときだけ（woff しか無い `src` は手を付けない）。
 * woff2 の項・`unicode-range` など他の宣言は書き換えない。
 */
const dropWoff1FromFontFace = {
  postcssPlugin: 'alteroid-drop-woff1-from-font-face',
  AtRule: {
    'font-face': (atRule: {
      walkDecls: (prop: string, cb: (decl: { value: string }) => void) => void;
    }) => {
      atRule.walkDecls('src', (decl) => {
        const next = decl.value.replace(WOFF1_SRC_ENTRY, '');
        if (next !== decl.value && /format\(\s*['"]?woff2['"]?\s*\)/i.test(next)) {
          decl.value = next;
        }
      });
    },
  },
};

export default defineConfig({
  // `tailwindcss()` は `reactRouter()` より前（CSS の変換が先に要る）。
  plugins: [tailwindcss(), reactRouter()],
  css: { postcss: { plugins: [dropWoff1FromFontFace] } },
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
