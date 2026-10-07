import { defineConfig } from 'tsup';

export default defineConfig({
  // `src/openapi.ts` を足す: 足さないと `dist/openapi.js` が無く、`write-openapi.mjs` が import できないため。
  entry: ['src/index.ts', 'src/openapi.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  sourcemap: true,
  // esbuild の非 ASCII の escape を止める: dist を生のバイト列で照合する検査が「届いていない」と誤判定するため。
  esbuildOptions(options) {
    options.charset = 'utf8';
  },
});
