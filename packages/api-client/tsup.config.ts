import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  sourcemap: true,
  // core は取り込まず import のまま残す。取り込むと `@alteroid/core/redact` の中身が
  // dist へ複写され、Web のバンドルには `packages/logic` が core から直接引く本物と
  // この複写の2部が載る（`pnpm check:web-bundle-size` の合計に効く）。
  external: [/^@alteroid\/core(\/|$)/],
  // #378: esbuild は既定で非 ASCII を `\uXXXX` へ escape する。dist を生の
  // バイト列で照合する検査（変異試験の `spec.artifact` 等）がそれを
  // 「届いていない」と誤判定するため、escape を止める。
  esbuildOptions(options) {
    options.charset = 'utf8';
  },
});
