import { defineConfig } from 'tsup';

export default defineConfig({
  /**
   * 3つ出す。
   *
   * - `index.ts` — デーモン・runner・CLI が読む本体（Node の組み込みと
   *   Claude Agent SDK を含む）
   * - `usage-format.ts` — **ブラウザが読む軽い口**（`@alteroid/core/usage`）。
   *   実行時の依存を1つも持たない。ここを分けないと、金額を整形して足すために
   *   core 全体（gzip 約 300KB）がダッシュボードの初期チャンクへ入る
   * - `revision-format.ts` — 同じ理由の版の口（`@alteroid/core/revision`）。
   *   隣の `revision.ts` は焼き込み（正典の全文で約 95KB）と zod を読むので、
   *   そこから配ると「版を1行出す」ためにその全部が初期チャンクへ入る
   */
  entry: ['src/index.ts', 'src/usage-format.ts', 'src/revision-format.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  sourcemap: true,
});
