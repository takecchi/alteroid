export const ORIGIN_PLACEHOLDER = '<デーモンの origin>';

// 相対（/api）は外から届く先とは限らず、推測した URL を出さないため null
export function daemonOrigin(baseUrl: string): string | null {
  return baseUrl.startsWith('/') ? null : baseUrl.replace(/\/+$/, '');
}

// 外の AI が `POST /mcp` の `report_problem` で alteroid の不具合を報告する鍵の source（デーモンの `MCP_REPORT_SOURCE` と同じ値。鍵の source がそのまま報告の source になる）
export const REPORT_SOURCE = 'alteroid-report';

// 報告用の鍵を絞る推奨値（オーナーの決定）。デーモンの既定（60 回/分）は変えず、発行のときにここへ絞る
export const REPORT_RATE_PER_MINUTE = 10;

// 別の alteroid の「設定 — MCP サーバ」ページに貼る JSON（`.mcp.json` の `mcpServers` の中身と同じ形。packages/core の `mcpServersSchema` を通る）。
// 他の例と違って値を埋める: 貼れる形にするのが目的で、値は発行の応答にしか無く、発行直後の画面（保存も再表示もしない）でだけ組み立てる
export function mcpServerJson(origin: string | null, value: string): string {
  return JSON.stringify(
    {
      [REPORT_SOURCE]: {
        type: 'http',
        url: `${origin ?? ORIGIN_PLACEHOLDER}/mcp`,
        headers: { Authorization: `Bearer ${value}` },
      },
    },
    null,
    2,
  );
}

// 値は書かない（画面に出るのは発行の1度だけなので、置き場所の印だけを置く）。書式は Claude Code の公式ドキュメント（MCP の節）の HTTP サーバの例に従う
export function claudeMcpAddCommand(origin: string | null): string {
  return (
    `claude mcp add --transport http ${REPORT_SOURCE} ${origin ?? ORIGIN_PLACEHOLDER}/mcp \\\n` +
    `  --header "Authorization: Bearer <上の値>"`
  );
}
