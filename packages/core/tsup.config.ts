import { defineConfig } from 'tsup';

export default defineConfig({
  /**
   * 6つ出す。
   *
   * - `index.ts` — デーモン・runner・CLI が読む本体（Node の組み込みと
   *   Claude Agent SDK を含む）
   * - `usage-format.ts` — **ブラウザが読む軽い口**（`@alteroid/core/usage`）。
   *   実行時の依存を1つも持たない。ここを分けないと、金額を整形して足すために
   *   core 全体（gzip 約 300KB）がダッシュボードの初期チャンクへ入る
   * - `revision-format.ts` — 同じ理由の版の口（`@alteroid/core/revision`）。
   *   隣の `revision.ts` は焼き込み（正典の全文で約 95KB）と zod を読むので、
   *   そこから配ると「版を1行出す」ためにその全部が初期チャンクへ入る
   * - `journal-search.ts` — 日誌を語で探す照合の口（issue #250。
   *   `@alteroid/core/journal-search`）。**実行時の依存を1つも持たない**
   *   （`schema.ts` からは `import type` だけ）。**ここを分ける理由は
   *   `usage-format.ts` と同じではなく、もう一段強い** —— 照合に使う欄の
   *   一覧は「4口すべてで同じ答えを出す」ための唯一の正本なので、
   *   ブラウザ側だけ写しを持つ形にすると、片方だけ直して他方を忘れる
   *   （`journal-search.ts` の doc）。かといって `@alteroid/core` 本体から
   *   **値**を import すると、サーバ専用のドメイン層ごとブラウザバンドルへ
   *   入る —— #294 / #306 で `/commitments` のチャンクが 1.2MB になり、
   *   本番でそのルートが開けなくなった事故そのものである
   *   （`apps/web/app/routes/commitments.tsx` の doc）。**写しを持たずに
   *   膨らませない唯一の形がこの軽い口である。**
   * - `clone-tool-relay-child.ts` — #486 48(a) 案D。クローンの道具の中継
   *   （relay）の子プロセスの入口。**上の4つと違い `package.json` の
   *   `exports` には載せない** —— 外から名前で import される口ではなく、
   *   `clone.ts`（同じパッケージの中）が `import.meta.url` から相対パスで
   *   組み立てた絶対パスを `command`/`args` として spawn する、実行専用の
   *   成果物だからである（`apps/daemon` の `openapi.ts` が `write-openapi.mjs`
   *   専用でエクスポートに載らないのと同じ扱い）。
   * - `permission-rule.ts` — 許可の規則の純粋な照合器と広さ判定
   *   （issue #863。`@alteroid/core/permission-rule`）。**`journal-search.ts`
   *   と同じ理由でもう一段強い** —— CLI（`apps/cli/src/permission.ts`）が
   *   `describePermissionRuleBreadth` で使っている意味論と、Web UI
   *   （`apps/web/app/routes/permissions.tsx`）が使う意味論を**同じ実装**に
   *   揃えるための唯一の正本。ファイル自身がもともと import を1つも
   *   持たない（ストア・時刻・乱数のどれにも触れない設計——ファイル冒頭の
   *   doc）ので、分離のために書き換えた行は無い。
   */
  entry: [
    'src/index.ts',
    'src/usage-format.ts',
    'src/revision-format.ts',
    'src/journal-search.ts',
    'src/clone-tool-relay-child.ts',
    'src/permission-rule.ts',
  ],
  format: ['esm'],
  dts: true,
  clean: true,
  sourcemap: true,
  // #378: esbuild は既定で非 ASCII を `\uXXXX` へ escape する。dist を生の
  // バイト列で照合する検査（変異試験の `spec.artifact` 等）がそれを
  // 「届いていない」と誤判定するため、escape を止める。
  esbuildOptions(options) {
    options.charset = 'utf8';
  },
});
