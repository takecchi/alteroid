import { topToolResults } from './message-breakdown.js';
import type { MessageBreakdownToolRow } from './message-breakdown.js';

// `schema.ts` を import せず型を手で複製する: zod ごとブラウザバンドルへ入るため
type ContextUsageLike = {
  percentage?: number;
  totalTokens?: number;
  messageBreakdown?: { toolsByName: readonly MessageBreakdownToolRow[] };
};

export const JOURNAL_DIAGNOSTICS_TYPES = [
  'turn_usage',
  'context_usage',
  'turn_timing',
  'http_timing',
] as const;

export type JournalDiagnosticsEntryLike =
  | {
      type: 'turn_usage';
      layer: string;
      site: string;
      managerId: string;
      models: Record<
        string,
        { costUsd: number; cacheReadInputTokens: number; cacheCreationInputTokens: number }
      >;
      contextUsage?: ContextUsageLike;
      compactions?: unknown[];
      reset?: unknown;
    }
  | {
      type: 'context_usage';
      layer: string;
      site: string;
      managerId: string;
      turnSucceeded: boolean;
      contextUsage: ContextUsageLike & { error?: string };
    }
  | {
      type: 'turn_timing';
      triggers: string[];
      kinds: string[];
      succeeded: boolean;
      totalMs: number;
      firstTextMs?: number;
      phases: Record<string, number>;
      tokens?: { input: number; cacheRead: number; cacheCreation: number; output: number };
    }
  | {
      type: 'http_timing';
      windowMs: number;
      requests: number;
      routes: Array<{ route: string; totalMs: number }>;
      slowest: Array<{ route: string; totalMs: number }>;
    };

// 秒の言い方は `turn-timing-format.ts` の `formatSeconds` と同じにする（こちらはブラウザへ入るので、あちらを読まず同じ規則で書く）
function seconds(ms: number): string {
  if (ms < 1000) return `${String(ms)}ms`;
  const value = ms / 1000;
  return value < 10 ? `${value.toFixed(1)}秒` : `${String(Math.round(value))}秒`;
}

function contextUsageNote(context: ContextUsageLike | undefined): string {
  if (context === undefined || context.percentage === undefined) return '';
  // 履歴の内訳が無い回（古い行・SDK が返さなかった回）と道具の行が無い回は書かない（0 を埋めない）
  const top = topToolResults(context.messageBreakdown?.toolsByName ?? []);
  return (
    ` 文脈 ${context.percentage}%` +
    (context.totalTokens === undefined ? '' : `（${context.totalTokens} トークン）`) +
    (top.length === 0 ? '' : `・履歴の道具の結果が大きい順: ${top.join('・')}`)
  );
}

export function summarizeJournalDiagnosticsEntry(entry: JournalDiagnosticsEntryLike): string {
  switch (entry.type) {
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
    case 'turn_timing': {
      // 親の段（`.` の無い段）だけで最も長い段を選ぶ: 内訳は親に含まれるため（#5086）
      const [slowest] = Object.entries(entry.phases)
        .filter(([name]) => !name.includes('.'))
        .sort((a, b) => b[1] - a[1]);
      const input =
        entry.tokens === undefined
          ? ''
          : `・入力 ${(entry.tokens.input + entry.tokens.cacheRead + entry.tokens.cacheCreation).toLocaleString('en-US')} トークン`;
      return (
        `[${entry.kinds.join('+') || 'ターン無し'} ${entry.triggers.join('+')} ${entry.succeeded ? '成功' : '失敗'}]` +
        ` 合計 ${seconds(entry.totalMs)}` +
        (entry.firstTextMs === undefined ? '' : `・最初の文字まで ${seconds(entry.firstTextMs)}`) +
        (slowest === undefined ? '' : `・最も長い段 ${slowest[0]} ${seconds(slowest[1])}`) +
        input
      );
    }
    case 'http_timing': {
      const [top] = entry.routes;
      const [slowest] = entry.slowest;
      return (
        `[${String(Math.max(1, Math.round(entry.windowMs / 60_000)))}分の窓] 要求 ${String(entry.requests)} 回` +
        (top === undefined
          ? ''
          : `・時間を最も食った経路 ${top.route} 合計 ${seconds(top.totalMs)}`) +
        (slowest === undefined ? '' : `・最も遅い要求 ${slowest.route} ${seconds(slowest.totalMs)}`)
      );
    }
  }
}
