import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  sourcemap: true,
  // 非 ASCII を escape させない: dist を生のバイト列で照合する検査が「届いていない」と誤判定するため。
  esbuildOptions(options) {
    options.charset = 'utf8';
  },
});
