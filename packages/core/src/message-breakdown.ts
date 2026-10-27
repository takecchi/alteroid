// 会話の履歴（Messages）の内訳を日誌用に畳む。`contextUsage.messageBreakdown` と人が読む描画の両方の元になる。
// 依存を持たない: `journal-diagnostics-format.ts`（ブラウザへ入る）からも読むため、zod や schema.ts を import しない。
// 1本ずつ写さない: 日誌の1行が道具の種類の数だけ伸びるため。

/** 日誌へ載せる道具の行の上限（「ほか」の行を含む）。これを超える分は「ほか」へ合算する。 */
export const MESSAGE_BREAKDOWN_TOOLS_LIMIT = 12;

// 上限を超えた分の行の名前。実在の道具名と取り違えないよう、括弧で包んだ固定の印にする（`mcp-tools-by-server.ts` と同じ）。
export const MESSAGE_BREAKDOWN_TOOL_OTHER = '(other)';

/** 描画（人が読む1行）に出す道具の数。 */
export const MESSAGE_BREAKDOWN_TOP_TOOLS_SHOWN = 3;

export interface MessageBreakdownToolRow {
  name: string;
  callTokens: number;
  resultTokens: number;
}

export interface MessageBreakdownObservation {
  toolCallTokens: number;
  toolResultTokens: number;
  attachmentTokens: number;
  assistantMessageTokens: number;
  userMessageTokens: number;
  toolsByName: MessageBreakdownToolRow[];
}

/** SDK の `getContextUsage()` が返す `messageBreakdown` のうち、日誌へ写す欄。 */
export interface MessageBreakdownSource {
  toolCallTokens: number;
  toolResultTokens: number;
  attachmentTokens: number;
  assistantMessageTokens: number;
  userMessageTokens: number;
  toolCallsByType: readonly { name: string; callTokens: number; resultTokens: number }[];
}

function compareByResultTokens(a: MessageBreakdownToolRow, b: MessageBreakdownToolRow): number {
  return b.resultTokens - a.resultTokens || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
}

/**
 * `messageBreakdown` を日誌用に畳む。SDK が欄を返さなかった回（undefined）は undefined を返す（呼び出し側が欄を作らない。0 を置かない）。
 * 道具ごとの行は結果のトークンの大きい順に並べ、同点は名前の順にする: 並びが入力の順に依存すると、同じ内訳なのに日誌の行が変わるため。
 * 同じ名前の行は合算する。上限を超えた分は固定名の1行へ合算し、合計は畳んでも変わらない。
 */
export function foldMessageBreakdown(
  source: MessageBreakdownSource | undefined,
): MessageBreakdownObservation | undefined {
  if (source === undefined) return undefined;
  const byName = new Map<string, MessageBreakdownToolRow>();
  for (const tool of source.toolCallsByType) {
    const row = byName.get(tool.name) ?? { name: tool.name, callTokens: 0, resultTokens: 0 };
    row.callTokens += tool.callTokens;
    row.resultTokens += tool.resultTokens;
    byName.set(tool.name, row);
  }
  const sorted = [...byName.values()].sort(compareByResultTokens);
  const toolsByName =
    sorted.length <= MESSAGE_BREAKDOWN_TOOLS_LIMIT
      ? sorted
      : [
          ...sorted.slice(0, MESSAGE_BREAKDOWN_TOOLS_LIMIT - 1),
          {
            name: MESSAGE_BREAKDOWN_TOOL_OTHER,
            callTokens: sorted
              .slice(MESSAGE_BREAKDOWN_TOOLS_LIMIT - 1)
              .reduce((total, row) => total + row.callTokens, 0),
            resultTokens: sorted
              .slice(MESSAGE_BREAKDOWN_TOOLS_LIMIT - 1)
              .reduce((total, row) => total + row.resultTokens, 0),
          },
        ];
  return {
    toolCallTokens: source.toolCallTokens,
    toolResultTokens: source.toolResultTokens,
    attachmentTokens: source.attachmentTokens,
    assistantMessageTokens: source.assistantMessageTokens,
    userMessageTokens: source.userMessageTokens,
    toolsByName,
  };
}

/**
 * 結果のトークンが大きい上位の道具を「名前 数」で並べる（「ほか」の行は塊であって道具ではないので順位に入れない）。
 * 道具の行が1つも無ければ空の配列（0 を埋めない）。
 */
export function topToolResults(toolsByName: readonly MessageBreakdownToolRow[]): string[] {
  return toolsByName
    .filter((row) => row.name !== MESSAGE_BREAKDOWN_TOOL_OTHER)
    .sort(compareByResultTokens)
    .slice(0, MESSAGE_BREAKDOWN_TOP_TOOLS_SHOWN)
    .map((row) => `${row.name} ${row.resultTokens.toLocaleString('en-US')}`);
}

/** 人が読む1行。 */
export function describeMessageBreakdown(breakdown: MessageBreakdownObservation): string {
  const n = (value: number): string => value.toLocaleString('en-US');
  const top = topToolResults(breakdown.toolsByName);
  return (
    `会話の履歴の内訳: 道具の結果 ${n(breakdown.toolResultTokens)} / 道具の呼び出し ${n(breakdown.toolCallTokens)}` +
    ` / 添付 ${n(breakdown.attachmentTokens)} / assistant ${n(breakdown.assistantMessageTokens)}` +
    ` / user ${n(breakdown.userMessageTokens)} トークン` +
    (top.length === 0 ? '' : `。結果が大きい道具: ${top.join('・')}`)
  );
}
