import { excerptLine } from './excerpt.js';

export interface McpServerStatus {
  name: string;
  status: string;
}

// プロバイダが切った上限より短く締める: 名前と状態の文字列を無制限に日誌へ写さないため。
const JOURNAL_SERVERS_MAX = 20;
const JOURNAL_FIELD_LIMIT = 120;

/**
 * init が知らせた MCP サーバのうち `connected` 以外だけを文にする（名前と状態だけで、設定・鍵は載せない）。
 * 全部 `connected` なら `null`（日誌に残さない）。`digest` が同じなら同じ状態の組。
 */
export function describeMcpStatusForJournal(
  servers: readonly McpServerStatus[],
): { text: string; digest: string } | null {
  const bad = servers
    .filter((server) => server.status !== 'connected')
    .map(
      (server) =>
        `${excerptLine(server.name, JOURNAL_FIELD_LIMIT)}（${excerptLine(server.status, JOURNAL_FIELD_LIMIT)}）`,
    )
    .sort();
  if (bad.length === 0) return null;
  const shown = bad.slice(0, JOURNAL_SERVERS_MAX);
  const omitted = bad.length - shown.length;
  return {
    text:
      `init が知らせた MCP サーバのうち、接続できていないもの: ${shown.join(', ')}` +
      `${omitted > 0 ? `（ほか ${omitted} 件）` : ''}。` +
      'この担当ではそのサーバの道具が使えない（認証が切れた・落ちた・起動が間に合わなかったなど）。',
    digest: JSON.stringify([shown, omitted]),
  };
}
