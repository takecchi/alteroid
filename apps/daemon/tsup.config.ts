import { defineConfig } from 'tsup';

export default defineConfig({
  // openapi.ts は build スクリプトが spec を書き出すためだけの入口（CLI 等は
  // index.ts しか見ない）。ここに足さないと dist/openapi.js が無く、
  // write-openapi.mjs が import できない。
  entry: ['src/index.ts', 'src/openapi.ts'],
  format: ['esm'],
  // CLI が hono/client で型を共有するため型定義を出す（実装は共有しない）
  dts: true,
  clean: true,
  sourcemap: true,
});
