import type { AgentContextUsage } from './agent-session.js';
import { foldMcpToolsByServer } from './mcp-tools-by-server.js';
import { foldMessageBreakdown } from './message-breakdown.js';
import { exactTokens, type ExactTokens } from './quantity.js';
import type { ContextUsageObservation } from './schema.js';
import { describeProbeError } from './usage-probe.js';

// 軸の件数の上限を二重に定義しない: クローン層とランナー層の両方が使うため。版が上がって軸が増えたときに日誌の1行が黙って伸びるのを塞ぐ
export const CONTEXT_USAGE_CATEGORY_LIMIT = 24;

// ターンの終わりで聞く文脈占有の締め切り。層が2つとも同じこれを使う（#4649）
// 期限を置く: 聞いている間はそのターンの終わりの処理（報告・受信箱の次の合図）が先へ進まず、CLI が生きたまま答えないと永久に止まるため。観測であって仕事ではない
export const CONTEXT_USAGE_READ_TIMEOUT_MS = 10_000;

// 期限を過ぎたら投げる（`undefined` に畳まない）: 呼び出し元の catch が「測れなかった」を `error` として日誌へ残し、黙った回が数えられるようにするため
// 打ち切った後に返ってきた答えと失敗は捨てる（未処理の拒否にしない）
export async function contextUsageWithin<T>(answer: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`getContextUsage が ${String(ms)}ms 以内に返らなかった`));
    }, ms);
  });
  answer.catch(() => undefined);
  try {
    return await Promise.race([answer, expired]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * ターンの境界で聞いた文脈占有の答えを、日誌と出来事に載せる形へ写す。クローン（`clone.ts`）と担当（`runner.ts`）の `#observeContextUsage` が使う:
 * 2つの層で写し方がずれると、同じ答えが層によって違う形で残るため。
 * - 分類ロジックを複製しない: SDK の値をそのまま写し、分類（`kind` の値だけで行い `name` の文字列は見ない）と集計は読む側（`summarizeContextCategories`）が1箇所で持つ。
 * - 配列は合計へ畳む: 1本ずつ写すと日誌の1行が道具の本数だけ伸びるため。
 * - 空の配列・SDK が返さなかった欄は、欄そのものを作らない: 0 を置くと「測ったが 0」と読め、取れない軸に 0 の行を作ることになるため。
 * `durationMs` は `startedAt` から、この関数が値を組む時点までを測る（呼び出し元は答えを待った直後に呼ぶ）。
 */
export function contextUsageObservationOf(
  usage: AgentContextUsage,
  startedAt: number,
): ContextUsageObservation {
  const categories = (usage.categories ?? []).map((category) => ({
    name: category.name,
    tokens: category.tokens,
    kind: category.kind,
  }));
  const shownCategories = categories.slice(0, CONTEXT_USAGE_CATEGORY_LIMIT);
  const omittedCategories = categories.length - shownCategories.length;
  const sumTokens = (items: readonly { tokens: number }[]): number =>
    items.reduce((total, item) => total + item.tokens, 0);
  const mcpTools = usage.mcpTools ?? [];
  const memoryFiles = usage.memoryFiles ?? [];
  const systemPromptSections = usage.systemPromptSections ?? [];
  const messageBreakdown = foldMessageBreakdown(usage.messageBreakdown);
  return {
    durationMs: Date.now() - startedAt,
    totalTokens: usage.totalTokens,
    rawMaxTokens: usage.rawMaxTokens,
    percentage: usage.percentage,
    ...(usage.autoCompactThreshold === undefined
      ? {}
      : { autoCompactThreshold: usage.autoCompactThreshold }),
    isAutoCompactEnabled: usage.isAutoCompactEnabled,
    ...(shownCategories.length === 0 ? {} : { categories: shownCategories }),
    ...(omittedCategories > 0 ? { categoriesOmitted: omittedCategories } : {}),
    ...(mcpTools.length === 0
      ? {}
      : {
          mcpToolTokens: sumTokens(mcpTools),
          mcpToolCount: mcpTools.length,
          mcpToolsByServer: foldMcpToolsByServer(mcpTools),
        }),
    ...(memoryFiles.length === 0
      ? {}
      : { memoryFileTokens: sumTokens(memoryFiles), memoryFileCount: memoryFiles.length }),
    ...(systemPromptSections.length === 0
      ? {}
      : {
          systemPromptTokens: sumTokens(systemPromptSections),
          systemPromptSectionCount: systemPromptSections.length,
        }),
    ...(messageBreakdown === undefined ? {} : { messageBreakdown }),
  };
}

/**
 * 文脈占有を聞けなかった回の形（`contextUsageObservationOf` と対）。理由は `describeProbeError` でしか運ばない: 秘密を漏らさないため。
 */
export function failedContextUsageObservation(
  error: unknown,
  startedAt: number,
): ContextUsageObservation {
  return {
    durationMs: Date.now() - startedAt,
    error: describeProbeError(error, process.env),
  };
}

// 分類は kind だけで行い、name の英語の文字列を見ない:
// > [sdk-verbatim SDKControlGetContextUsageResponse.categories.kind]
// > Classify on this, never on the English name.
const CONTEXT_CATEGORY_KINDS = ['used', 'free', 'buffer', 'deferred'] as const;

type ContextCategoryKind = (typeof CONTEXT_CATEGORY_KINDS)[number];

interface ContextCategoryTotals {
  // 素の number にしない: 文字数（HeuristicChars）をトークンとして読み替える経路を tsc に落とさせるため
  tokens: ExactTokens;
  count: number;
}

interface ContextCategorySummary {
  // free / buffer / deferred / unclassified を used に混ぜない: used は「毎ターン払っている量」として読まれるため
  used: ContextCategoryTotals;
  free: ContextCategoryTotals;
  buffer: ContextCategoryTotals;
  deferred: ContextCategoryTotals;
  // unclassified へ倒す: used に倒すと払っている量に紛れ込み、捨てると合計が食い違って消えた分が見えなくなるため
  unclassified: ContextCategoryTotals;
}

function emptyTotals(): ContextCategoryTotals {
  return { tokens: exactTokens(0), count: 0 };
}

function isContextCategoryKind(value: string | undefined): value is ContextCategoryKind {
  if (value === undefined) return false;
  return (CONTEXT_CATEGORY_KINDS as readonly string[]).includes(value);
}

// 例外を投げない: 未知の kind は unclassified へ入れるだけで呼び出しを止めない
export function summarizeContextCategories(
  categories: readonly { name: string; tokens: number; kind?: string }[] | undefined,
): ContextCategorySummary {
  const summary: ContextCategorySummary = {
    used: emptyTotals(),
    free: emptyTotals(),
    buffer: emptyTotals(),
    deferred: emptyTotals(),
    unclassified: emptyTotals(),
  };
  for (const category of categories ?? []) {
    const bucket = isContextCategoryKind(category.kind)
      ? summary[category.kind]
      : summary.unclassified;
    // += ではなく exactTokens(...) を通す: 算術演算子を通すと素の number に戻るため
    bucket.tokens = exactTokens(bucket.tokens + category.tokens);
    bucket.count += 1;
  }
  return summary;
}
