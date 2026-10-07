import { reactRouter } from '@react-router/dev/vite';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const daemonUrl = process.env.ALTEROID_API_URL ?? 'http://127.0.0.1:4517';

const WOFF1_SRC_ENTRY = /,\s*url\([^)]*\)\s*format\(\s*(['"]?)woff\1\s*\)/gi;

// @fontsource の CSS を repo に写して書き換えない: 版を上げたとき追随が崩れるため
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

const JSX_RUNTIME_ESM = fileURLToPath(new URL('./jsx-runtime-esm.ts', import.meta.url));

// resolve.alias にしない: 包み自身が react/jsx-runtime を import し、alias は importer を見ないので包みが自分自身を指して循環するため
// 開発サーバと SSR のビルドには効かせない: 大きさの予算の対象ではなく、Vite の依存の事前束ねと食い違う余地を残さないため
const jsxRuntimeAsEsm = {
  name: 'alteroid-jsx-runtime-esm',
  apply: 'build' as const,
  enforce: 'pre' as const,
  resolveId(source: string, importer: string | undefined, options?: { ssr?: boolean }) {
    if (source !== 'react/jsx-runtime') return null;
    if (options?.ssr === true || importer === JSX_RUNTIME_ESM) return null;
    return JSX_RUNTIME_ESM;
  },
};

export default defineConfig({
  // tailwindcss() は reactRouter() より前に置く: CSS の変換が先に要るため
  plugins: [jsxRuntimeAsEsm, tailwindcss(), reactRouter()],
  css: { postcss: { plugins: [dropWoff1FromFontFace] } },
  resolve: {
    tsconfigPaths: true,
    alias: [
      // with-selector には当てない: shim ではなく本物の実装のため（末尾が shim か shim/index.js のものだけ）
      {
        find: /^use-sync-external-store\/shim(\/index\.js)?$/,
        replacement: fileURLToPath(new URL('./use-sync-external-store-shim.ts', import.meta.url)),
      },
    ],
  },
  build: {
    // フォントのファイルだけは CSS へ base64 で埋め込まない: unicode-range に関係なく、埋め込まれた断片の本体が CSS と一緒に最初に落ちてくるため
    assetsInlineLimit: (filePath) =>
      /\.(woff2?|ttf|otf|eot)$/i.test(filePath) ? false : undefined,
    rolldownOptions: {
      output: {
        chunkFileNames: (chunk) =>
          chunk.name.startsWith('shared') ? 'assets/shared-[hash].js' : 'assets/[name]-[hash].js',
        codeSplitting: {
          groups: [
            {
              name: 'shared',
              test: /^(?!.*[\\/]node_modules[\\/])/,
              minShareCount: 2,
              maxModuleSize: 4096,
              entriesAware: true,
              entriesAwareMergeThreshold: 8192,
            },
          ],
        },
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: daemonUrl,
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ''),
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
