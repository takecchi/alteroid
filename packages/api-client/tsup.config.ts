import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  sourcemap: true,
  // core を取り込まない: 取り込むと Web のバンドルに core の複写が2部載り、check:web-bundle-size の合計に効くため
  external: [/^@alteroid\/core(\/|$)/],
  // charset を utf8 にする: 既定の escape だと、dist を生のバイト列で照合する検査が「届いていない」と誤判定するため
  esbuildOptions(options) {
    options.charset = 'utf8';
  },
});
