// `schema.ts` を import せず型を手で複製する: zod ごとブラウザバンドルへ入るため
export const JOURNAL_DIAGNOSTICS_TYPES = [
  'worker_wait',
  'turn_usage',
  'context_usage',
  'inbox_flow',
] as const;

export type JournalDiagnosticsType = (typeof JOURNAL_DIAGNOSTICS_TYPES)[number];

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

function contextUsageNote(
  context: { percentage?: number; totalTokens?: number } | undefined,
): string {
  if (context === undefined || context.percentage === undefined) return '';
  return (
    ` 文脈 ${context.percentage}%` +
    (context.totalTokens === undefined ? '' : `（${context.totalTokens} トークン）`)
  );
}

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
      // キャッシュの read/write を潰さない: 潰すと「キャッシュ書き直しに払っているか」が推測に戻るため
      const models = Object.entries(entry.models);
      const totalCost = models.reduce((sum, [, totals]) => sum + totals.costUsd, 0);
      const cacheWrite = models.reduce(
        (sum, [, totals]) => sum + totals.cacheCreationInputTokens,
        0,
      );
      const cacheRead = models.reduce((sum, [, totals]) => sum + totals.cacheReadInputTokens, 0);
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
      const context = entry.contextUsage;
      const status = entry.turnSucceeded ? '成功' : '失敗';
      const note =
        context.error !== undefined
          ? `測れなかった（${context.error}）`
          : contextUsageNote(context).trim() || '（詳細なし）';
      return `[${entry.layer}/${entry.site}] ${entry.managerId} ターン${status}: ${note}`;
    }
    case 'inbox_flow': {
      // 4つの総数を混ぜない: 別のものを数えており、食い違いそのものが読む材料であるため
      const oldest =
        entry.pending.oldestAt === undefined ? '' : `（最古 ${entry.pending.oldestAt}）`;
      return (
        `受信箱 到着${entry.arrived.total} / 配達${entry.delivered.total} / ` +
        `消し込み${entry.settled.total} / 滞留${entry.pending.count}${oldest}`
      );
    }
  }
}
