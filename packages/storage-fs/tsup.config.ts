import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/light.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  sourcemap: true,
  // escape を止める: esbuild 既定の `\uXXXX` 化だと、dist を生のバイト列で照合する検査が「届いていない」と誤判定するため
  esbuildOptions(options) {
    options.charset = 'utf8';
  },
});
