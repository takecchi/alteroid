// MCP の道具をサーバごとに畳む（#5291）。`contextUsage.mcpToolsByServer` と起動の記録の「上位のサーバ」の両方の元になる。
// 1本ずつ写さない: 日誌の1行が道具の本数だけ伸びるため。

/** 日誌へ載せるサーバ行の上限（「ほか」の行を含む）。これを超える分は「ほか」へ合算する。 */
export const MCP_TOOLS_BY_SERVER_LIMIT = 16;

/** `serverName` が無い道具の行の名前。 */
export const MCP_SERVER_UNKNOWN = 'unknown';

// 上限を超えた分の行の名前。実在のサーバ名と取り違えないよう、括弧で包んだ固定の印にする。
export const MCP_SERVER_OTHER = '(other)';

export interface McpToolsOfServer {
  name: string;
  count: number;
  tokens: number;
}

/**
 * 道具ごとの配列を `serverName` ごとに畳み、トークンの大きい順に並べる。
 * 空の入力は空の配列を返す（呼び出し側が欄そのものを作らない。0 の行を作らない）。
 * 同じトークンの行は名前の順にする: 並びが入力の順に依存すると、同じ内訳なのに日誌の行が変わるため。
 */
export function foldMcpToolsByServer(
  tools: readonly { serverName?: string; tokens: number }[],
): McpToolsOfServer[] {
  const byServer = new Map<string, McpToolsOfServer>();
  for (const tool of tools) {
    const name =
      tool.serverName === undefined || tool.serverName === ''
        ? MCP_SERVER_UNKNOWN
        : tool.serverName;
    const row = byServer.get(name) ?? { name, count: 0, tokens: 0 };
    row.count += 1;
    row.tokens += tool.tokens;
    byServer.set(name, row);
  }
  const sorted = [...byServer.values()].sort(
    (a, b) => b.tokens - a.tokens || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
  );
  if (sorted.length <= MCP_TOOLS_BY_SERVER_LIMIT) return sorted;
  const shown = sorted.slice(0, MCP_TOOLS_BY_SERVER_LIMIT - 1);
  const rest = sorted.slice(MCP_TOOLS_BY_SERVER_LIMIT - 1);
  return [
    ...shown,
    {
      name: MCP_SERVER_OTHER,
      count: rest.reduce((total, row) => total + row.count, 0),
      tokens: rest.reduce((total, row) => total + row.tokens, 0),
    },
  ];
}
