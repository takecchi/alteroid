import type { AgentTurnUsage } from './agent-events.js';
import type { ContextUsageObservation } from './schema.js';

// MCP の道具の行を名前で探す: `kind` は「その行が何か」までは言わず、`deferred` か `used` かだけを言うため（分類は kind、どの行かの特定だけ名前）。
// 前方一致にする: SDK が「MCP tools (deferred)」のように後ろへ足しても拾うため。見つからなければ推し量らず「取れなかった」と書く。
const MCP_TOOLS_CATEGORY_NAME = 'MCP tools';

function tokens(value: number): string {
  return value.toLocaleString('en-US');
}

// 本体は、ToolSearch で読み込んだ分を「MCP tools」（used）、残りを「MCP tools (deferred)」（deferred）の2行に分けて返す（CLI 0.3.303 を読んだ）。
// 最初のターンでクローンが ToolSearch を使うと両方が出るので、`kind` が1種類に揃うことを条件にしない（揃えると、効いた回ほど「取れなかった」になる。#4269）
function mcpToolsPhrase(contextUsage: ContextUsageObservation): string {
  if (contextUsage.error !== undefined) {
    return `MCP の道具の区分は取れなかった（文脈の観測が失敗した: ${contextUsage.error}）`;
  }
  const rows = (contextUsage.categories ?? []).filter((category) =>
    category.name.startsWith(MCP_TOOLS_CATEGORY_NAME),
  );
  if (rows.length === 0) {
    return contextUsage.categories === undefined
      ? 'MCP の道具の区分は取れなかった（区分が返らなかった）'
      : 'MCP の道具の区分は取れなかった（区分に MCP の道具の行が無かった）';
  }
  const deferred = rows.filter((row) => row.kind === 'deferred');
  const used = rows.filter((row) => row.kind === 'used');
  if (deferred.length + used.length !== rows.length) {
    const others = [...new Set(rows.map((row) => row.kind ?? '（無し）'))].join('・');
    return `MCP の道具の区分は取れなかった（区分の種類 ${others} が used・deferred のどちらでもない）`;
  }
  const sumOf = (items: readonly { tokens: number }[]): string =>
    tokens(items.reduce((total, row) => total + row.tokens, 0));
  if (used.length === 0) return `MCP の道具は deferred（名前だけ、${sumOf(deferred)} トークン）`;
  if (deferred.length === 0) return `MCP の道具は used（本体ごと、${sumOf(used)} トークン）`;
  return (
    `MCP の道具は deferred（ToolSearch は効いていた。名前だけ ${sumOf(deferred)} トークン、` +
    `ToolSearch で読み込んだ分 ${sumOf(used)} トークン）`
  );
}

/**
 * 起動後の最初の本セッションのターンで、ToolSearch が実際に効いたかを1行にする（#4921。起動時の1行は #4269）。
 * 起動時の1行は env から見た「見込み」で、これはその後の `getContextUsage()` の区分から見た「実際」。
 * 要求の本数・使用量が取れなかった回はその文を書かない（0 を埋めない）。
 */
export function describeFirstTurnToolSearch(
  contextUsage: ContextUsageObservation,
  usage: AgentTurnUsage | undefined,
): string {
  const parts = [mcpToolsPhrase(contextUsage)];
  if (contextUsage.totalTokens !== undefined) {
    parts.push(`文脈 ${tokens(contextUsage.totalTokens)} トークン`);
  }
  if (usage?.numTurns !== undefined) parts.push(`要求 ${String(usage.numTurns)} 本`);
  const main = usage?.mainLoopUsage;
  if (main !== undefined) {
    const total =
      main.inputTokens +
      main.cacheReadInputTokens +
      main.cacheCreationInputTokens +
      main.outputTokens;
    parts.push(
      `使用量 合計 ${tokens(total)}（入力 ${tokens(main.inputTokens)}・キャッシュの読み ${tokens(main.cacheReadInputTokens)}・キャッシュの書き ${tokens(main.cacheCreationInputTokens)}・出力 ${tokens(main.outputTokens)}）`,
    );
  }
  return (
    `ToolSearch（起動後の最初のターンの観測）: ${parts.join('。')}。` +
    '読み方: deferred なら ToolSearch は効いていた。合計の大半がキャッシュの読みなら、1ターンで要求を何本も出し、毎回前置きを読み直した合計（#4921）'
  );
}
