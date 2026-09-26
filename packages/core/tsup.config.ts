import { defineConfig } from 'tsup';

export default defineConfig({
  /**
   * 13個出す。
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
   * - `answered-via.ts` — 承認への回答経路（`answeredVia`）の表示（issue
   *   #1479。`@alteroid/core/answered-via`）。**`permission-rule.ts` と同じ
   *   形**——Web UI（`apps/web/app/routes/approvals.tsx`）はこれが無かった
   *   間、CLI（`apps/cli/src/chat.ts`）と同じ `describeAnsweredVia` を画面へ
   *   手で複製していた（#1514）。複製をやめてここへ寄せた。ファイル自身は
   *   import を1つも持たない——zod スキーマから推論した型と構造的に一致する
   *   ことは `schema.ts` の型レベルの検査（`_AssertAnsweredViaMatchesLikeType`）
   *   が保証する。
   * - `trace-action.ts` — 承認の行動一覧の1件を1文にする表示
   *   （issue #1528。`@alteroid/core/trace-action`）。**`answered-via.ts` と
   *   同じ形**——Web UI（`apps/web/app/routes/approvals.tsx`）はこれが無かった
   *   間、`describeTraceAction`（`approval-trace.ts`）の複製（`describeAction`）
   *   を画面へ手で持っていたが、`tool_use` の `outcome` と `exchange` の
   *   接頭辞が抜けて2つの実装の文言がずれていた。複製をやめてここへ寄せた。
   *   ファイル自身は import を1つも持たない（`schema.ts` からは
   *   `import type` だけ）——構造的に一致することは `schema.ts` の型レベルの
   *   検査（`_AssertTraceActionMatchesLikeType`）が保証する。
   * - `mask-url.ts` — MCP サーバの宛先 URL の伏せ字（issue #1622。
   *   `@alteroid/core/mask-url`）。**`permission-rule.ts` と同じ形**——CLI
   *   （`apps/cli/src/mcp.ts`）と Web UI（`apps/web/app/routes/mcp-servers.tsx`）が
   *   同じ1行の判定を別々に持ち、**どちらも password だけの userinfo を
   *   伏せていなかった**。秘密の伏せ方は片方だけ直すと他方から漏れるので、
   *   ここへ寄せた。ファイル自身は import を1つも持たない。
   * - `manager-activity.ts` — マネージャー1本が「止まっている／進んでいる／
   *   判定できない」かの判定（`classifyManagerActivity`）と、直近の報告が
   *   いま走っているターンのものではないことを言う一文
   *   （`describeReportDrift`。issue #1036）（`@alteroid/core/manager-activity`）。
   *   **`answered-via.ts` と同じ形**——クローンの `manager_list` /
   *   `manager_report`（`tools.ts` の `describeToolUseStall` /
   *   `describeReportDrift` の呼び出し元）が使っている判定そのものを、
   *   Web UI（`apps/web/app/routes/manager-detail.tsx`）の診断欄が
   *   **同じ答えで**借りるための唯一の正本——判定のコピーを2つ作らない
   *   （ファイル冒頭の doc と同じ理由）。ファイル自身は値の import を
   *   1つだけ持つ（`./inbox-validity.js`）が、**そちらも実行時の依存が
   *   無い**（`schema.ts` からは両方とも `import type` だけ）ので、束ねても
   *   `usage-format.ts` と同じ「実行時の依存を1つも持たない」帯に収まる。
   * - `job-status-running.ts` — ジョブの「実行中」件数の判定（9回目の横断
   *   レビュー指摘。`@alteroid/core/job-status-running`）。**`mask-url.ts` と
   *   同じ形**——Web UI（`apps/web/app/routes/dashboard.tsx`）が
   *   `m.status === 'running'` を直書きしていて、将来「実行中」を意味する
   *   新しい値が `jobStatusSchema` に足されても件数から静かに漏れる形に
   *   なっていた。core 側（`tools.ts` の `describeManagerCounts`）にも同じ
   *   直書きが在ったので、判定をここへ寄せた。ファイル自身は import を
   *   1つも持たない——zod スキーマから推論した型と構造的に一致することは
   *   `schema.ts` の型レベルの検査（`_AssertJobStatusMatchesRunningLikeType`）
   *   が保証する。
   * - `cgroup-events-format.ts` — `lastCgroupEvents`（cgroup の pids/OOM
   *   カウンタの差分）を人が読む一文へ整形する表示（issue #1517。
   *   `@alteroid/core/cgroup-events-format`）。**`mask-url.ts` と同じ形**——
   *   issue #1645（委譲の詳細画面に診断欄を出す）で、Web UI
   *   （`apps/web/app/routes/manager-detail.tsx`）は隣の `cgroup-events.ts`
   *   が zod（`cgroupEventsDeltaSchema`）を同じファイルに持つために軽い口へ
   *   できず、文言を手で複製していた。複製をやめてここへ寄せた。ファイル
   *   自身は import を1つも持たない——zod スキーマから推論した型と構造的に
   *   一致することは `schema.ts` の型レベルの検査
   *   （`_AssertCgroupEventsDeltaMatchesLikeType`）が保証する。
   * - `system-error-format.ts` — `lastSystemError`（Node が構造として持つ
   *   失敗の分類 `code`/`errno`/`syscall`）を人が読む一文へ整形する表示
   *   （#713 段3。`@alteroid/core/system-error-format`）。**`cgroup-events-format.ts`
   *   と同じ形・同じ理由**——隣の `system-error.ts` が zod
   *   （`systemErrorFactsSchema`）を同じファイルに持つ。ファイル自身は
   *   import を1つも持たない——構造的に一致することは `schema.ts` の型
   *   レベルの検査（`_AssertSystemErrorFactsMatchesLikeType`）が保証する。
   *   D（判定できなかった）の文言は、クローン向け（`system-error.ts` の
   *   `SYSTEM_ERROR_UNKNOWN_NOTE`）と Web UI 向けとで末尾の指し先だけが
   *   意図して違う（欄名 `lastFailure` を直接指すか、画面上の該当セクション
   *   を指すか）ので、共通部分だけを `formatSystemErrorUnknownNote(pointer)`
   *   としてまとめ、指し先は呼び出し元の引数にした（ファイル冒頭の doc）。
   */
  entry: [
    'src/index.ts',
    'src/usage-format.ts',
    'src/revision-format.ts',
    'src/journal-search.ts',
    'src/clone-tool-relay-child.ts',
    'src/permission-rule.ts',
    'src/answered-via.ts',
    'src/trace-action.ts',
    'src/mask-url.ts',
    'src/manager-activity.ts',
    'src/job-status-running.ts',
    'src/cgroup-events-format.ts',
    'src/system-error-format.ts',
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
