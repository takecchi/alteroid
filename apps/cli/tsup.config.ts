import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  clean: true,
  sourcemap: true,
  // #378: esbuild は既定で非 ASCII を `\uXXXX` へ escape する。dist を生の
  // バイト列で照合する検査（変異試験の `spec.artifact` 等）がそれを
  // 「届いていない」と誤判定するため、escape を止める。
  esbuildOptions(options) {
    options.charset = 'utf8';
  },
});
