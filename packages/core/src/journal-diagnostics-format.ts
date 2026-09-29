/**
 * 日誌の4種（`worker_wait` / `turn_usage` / `context_usage` / `inbox_flow`）
 * を人が読む1行に潰す、**実行時の import を1つも持たない**ブラウザが読める
 * 軽い口（issue #2016。`@alteroid/core/journal-diagnostics-format`）。
 *
 * ## なぜ在るか
 *
 * CLI（`apps/cli/src/chat.ts` の `/journal` ハンドラ）は日誌1行の要約を
 * `summarize()` が作るが、そこは `text` / `decision` / `question` /
 * `summary` / `body` / `tool` の6キーの duck typing で、この4種はどの
 * キーも持たないため要約が空欄になっていた（issue #2016。空欄は
 * `  <at>  [worker_wait] ` の後ろに何も出ない形で見える）。同じ4種を
 * Web（`packages/swr/src/hooks/queries.ts` の `summarizeJournalEntry`）と
 * クローンの `journal_read`（`tools.ts` の `renderJournalEntry`——こちらは
 * head/body に分けたもっと詳しい表示で、この口とは別の正本のまま残す）は
 * 既に整形して出していた。
 *
 * 正本は元々 `summarizeJournalEntry` のこの4種を扱う枝だった——中身を
 * ここへ移し、Web 側（`queries.ts`）はここから import して同じ4分岐で使う
 * （`trace-action.ts` / `answered-via.ts` と同じ形。#1528・#1479 の続き）。
 * **生成元を3つに増やさないため**、CLI と Web の両方がここから引く。
 *
 * ## この4種だけを移す理由（`JournalEntry` の残り9種は複製しない）
 *
 * `summarizeJournalEntry` が扱う13種のうち、CLI で空欄になっていたのは
 * この4種だけである——残り9種は6キーの duck typing がたまたま拾えている
 * （`exchange` の `text`、`decision` の `decision`、`escalation` の
 * `question`、`tool_use` の `tool`、`memory_update`/`external_event` の
 * `summary`、`daily_report` の `body` などが当たる）。`trace-action.ts` の
 * doc と同じ理由で、**使わない9種のぶんまで `Like` 型を複製すると「複製を
 * やめる」という目的そのものに反する**——⟹ `trace-action.ts` と同じ判断で、
 * 実際に要る4種だけを手で書き写した。Web 側の残り9種の分岐は、この PR では
 * 1文字も変えていない（`queries.ts` に残したまま）。
 *
 * ## なぜ手で複製した型を使うか（`schema.ts` を import しない）
 *
 * `schema.ts` は `journalEntrySchema`（zod）を持ち、zod は実行時の依存に
 * なる——`system-error-format.ts` と同じ理由で、ここから型を取ると zod
 * ごとブラウザバンドルへ入る。構造的に一致すること（この4種について）は
 * `schema.ts` の `_AssertJournalDiagnosticsMatchesLikeType` が保証する
 * （`trace-action.ts` と同じ片方向——{@link JournalDiagnosticsEntryLike} は
 * 意図して「実際に読む欄だけの最小の型」であって4種の完全な写しではない
 * ので、双方向にすると `id` / `at` などのぶんで必ず落ちる）。
 *
 * ## Web の表示は1文字も変えていない
 *
 * `contextUsageNote` を含め、移設だけで文言・ロジックは1文字も変えていない
 * （`packages/swr/src/hooks/queries.test.ts` がそのまま緑であることで確認する）。
 */

/** この口が扱う4種の名前。CLI 側の判別にもここから配る（2箇所で書き並べない）。 */
export const JOURNAL_DIAGNOSTICS_TYPES = [
  'worker_wait',
  'turn_usage',
  'context_usage',
  'inbox_flow',
] as const;

export type JournalDiagnosticsType = (typeof JOURNAL_DIAGNOSTICS_TYPES)[number];

/**
 * `summarizeJournalDiagnosticsEntry` が受け付ける最小の構造型。
 *
 * 各欄の意味は `schema.ts` の `journalEntrySchema` の同名の欄の doc を見よ
 * （二重に書かない）。
 */
export type JournalDiagnosticsEntryLike =
  | {
      type: 'worker_wait';
      tasks: number;
      turns: number;
      byCause: { input: number; notification: number; continuation: number };
      toolless: number;
      settled: boolean;
    }
  | {
      type: 'turn_usage';
      layer: string;
      site: string;
      managerId: string;
      models: Record<
        string,
        { costUsd: number; cacheReadInputTokens: number; cacheCreationInputTokens: number }
      >;
      contextUsage?: { percentage?: number; totalTokens?: number };
      compactions?: unknown[];
      reset?: unknown;
    }
  | {
      type: 'context_usage';
      layer: string;
      site: string;
      managerId: string;
      turnSucceeded: boolean;
      contextUsage: { percentage?: number; totalTokens?: number; error?: string };
    }
  | {
      type: 'inbox_flow';
      arrived: { total: number };
      delivered: { total: number };
      settled: { total: number };
      pending: { count: number; oldestAt?: string };
    };

/**
 * `contextUsage` から「 文脈 X%（Y トークン）」の断片を作る（先頭に半角
 * スペースを含む。無ければ空文字）。`turn_usage`（欄が optional）と
 * `context_usage`（欄が必須）の両方の `summarizeJournalDiagnosticsEntry`
 * から呼ぶ共通部分——書き方を2箇所で複製しない（#976 で `context_usage`
 * を足すときに揃えた判断を、移設後もそのまま保つ）。
 */
function contextUsageNote(
  context: { percentage?: number; totalTokens?: number } | undefined,
): string {
  if (context === undefined || context.percentage === undefined) return '';
  return (
    ` 文脈 ${context.percentage}%` +
    (context.totalTokens === undefined ? '' : `（${context.totalTokens} トークン）`)
  );
}

/**
 * 日誌の4種（`worker_wait` / `turn_usage` / `context_usage` / `inbox_flow`）
 * を人が読む1行に潰す（Web の一覧・通知、CLI の `/journal` が同じ文言を
 * 使うため）。
 */
export function summarizeJournalDiagnosticsEntry(entry: JournalDiagnosticsEntryLike): string {
  switch (entry.type) {
    case 'worker_wait': {
      const cause = entry.byCause;
      return (
        `作業者 ${entry.tasks} 体を待つあいだに ${entry.turns} ターン` +
        `（通知 ${cause.notification} / 自己継続 ${cause.continuation} / 話しかけ ${cause.input}）。` +
        `うち ${entry.toolless} ターンは道具を1つも動かしていない` +
        (entry.settled ? '' : '（区間は閉じずに終わった）')
      );
    }
    case 'turn_usage': {
      // **キャッシュの書き直しを潰さない**（read/write を分けたまま見せる。
      // 潰すと「キャッシュ書き直しに払っているか」が推測に戻る）。数え直しの
      // 印は隠さない — 印の行を一覧から見えなくすると誤読を招く。
      const models = Object.entries(entry.models);
      const totalCost = models.reduce((sum, [, totals]) => sum + totals.costUsd, 0);
      const cacheWrite = models.reduce(
        (sum, [, totals]) => sum + totals.cacheCreationInputTokens,
        0,
      );
      const cacheRead = models.reduce((sum, [, totals]) => sum + totals.cacheReadInputTokens, 0);
      // **⚠️ Issue #976 以降、これは唯一の経路ではない。** 独立した
      // `context_usage`（下のケース）が、失敗したターン・増分がゼロだった
      // ターンも含めて必ず残す——この欄は「成功して増分もあった回」に限り
      // 従来どおり載る（既存の読み手との互換のため）。
      const contextNote = contextUsageNote(entry.contextUsage);
      const compactionNote =
        entry.compactions === undefined || entry.compactions.length === 0
          ? ''
          : ` ⚠ compaction ${entry.compactions.length} 回`;
      return (
        `[${entry.layer}/${entry.site}] ${entry.managerId} 1ターン $${totalCost.toFixed(4)}` +
        `（cache read=${cacheRead} write=${cacheWrite}）` +
        contextNote +
        compactionNote +
        (entry.reset === undefined ? '' : ' ⚠ 数え直しを挟んだ回（models は差分ではない）')
      );
    }
    case 'context_usage': {
      // **消費（`turn_usage`）とは独立の行（Issue #976）。** 失敗したターン
      // （`turnSucceeded: false`）こそがこの型の存在理由——#976 より前は
      // どこにも残らなかった値である。
      const context = entry.contextUsage;
      const status = entry.turnSucceeded ? '成功' : '失敗';
      const note =
        context.error !== undefined
          ? `測れなかった（${context.error}）`
          : contextUsageNote(context).trim() || '（詳細なし）';
      return `[${entry.layer}/${entry.site}] ${entry.managerId} ターン${status}: ${note}`;
    }
    case 'inbox_flow': {
      // **4つの総数を1行に並べる（Issue #783 段0）。** この種別の読み方は
      // 窓どうしを並べた推移で、1行に潰すときも**4つの軸を混ぜない**こと
      // ——`arrived`（受理）・`delivered`（待ち行列へ載った）・`settled`
      // （ストアから消えた）・`pending`（窓の終わりの1点）は別のものを
      // 数えており、食い違いそのものが読む材料である（`schema.ts` の
      // `inbox_flow` の doc）。種類別の内訳はここでは落とす —— 一覧の1行に
      // 収まらないので、詳細は日誌の本文側で読む。
      const oldest =
        entry.pending.oldestAt === undefined ? '' : `（最古 ${entry.pending.oldestAt}）`;
      return (
        `受信箱 到着${entry.arrived.total} / 配達${entry.delivered.total} / ` +
        `消し込み${entry.settled.total} / 滞留${entry.pending.count}${oldest}`
      );
    }
  }
}
