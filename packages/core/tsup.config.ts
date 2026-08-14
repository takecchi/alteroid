import { defineConfig } from 'tsup';

export default defineConfig({
  /**
   * 2つ出す。
   *
   * - `index.ts` — デーモン・runner・CLI が読む本体（Node の組み込みと
   *   Claude Agent SDK を含む）
   * - `usage-format.ts` — **ブラウザが読む軽い口**（`@alteroid/core/usage`）。
   *   実行時の依存を1つも持たない。ここを分けないと、金額を整形して足すために
   *   core 全体（gzip 約 300KB）がダッシュボードの初期チャンクへ入る
   */
  entry: ['src/index.ts', 'src/usage-format.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  sourcemap: true,
});
