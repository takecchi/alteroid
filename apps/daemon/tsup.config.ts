import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  // CLI が hono/client で型を共有するため型定義を出す（実装は共有しない）
  dts: true,
  clean: true,
  sourcemap: true,
});
