import type { McpServerEntryConfig } from './mcp-servers.js';

export type CodexMcpInputServer = McpServerEntryConfig | { type: 'sdk'; name?: string };

export interface CodexMcpSkipped {
  name: string;
  // 値を載せない: env / http_headers の値に鍵が入りうるため、reason と droppedFields には名前と欄名だけを書く
  reason: string;
}

export interface CodexMcpDropped {
  name: string;
  fields: string[];
}

export interface CodexMcpConfigResult {
  config: { mcp_servers: Record<string, Record<string, unknown>> } | null;
  passed: string[];
  skipped: CodexMcpSkipped[];
  droppedFields: CodexMcpDropped[];
}

export function toCodexMcpServersConfig(
  servers: Readonly<Record<string, CodexMcpInputServer>> | undefined,
): CodexMcpConfigResult {
  const out: Record<string, Record<string, unknown>> = {};
  const skipped: CodexMcpSkipped[] = [];
  const droppedFields: CodexMcpDropped[] = [];
  for (const name of Object.keys(servers ?? {}).sort()) {
    const server = (servers as Record<string, CodexMcpInputServer>)[name] as unknown as Record<
      string,
      unknown
    >;
    const type = server['type'];
    let entry: Record<string, unknown> | undefined;
    if (type === 'sdk') {
      skipped.push({ name, reason: 'インプロセス型の MCP サーバは app-server へ渡せない' });
      continue;
    } else if (type === 'sse') {
      // http として偽って渡さない: Codex は Streamable HTTP だけで、SSE として繋がる保証が無いため
      skipped.push({
        name,
        reason: 'sse の MCP サーバは Codex が受けない（Streamable HTTP のみ）ので渡さない',
      });
      continue;
    } else if (type === 'http') {
      if (typeof server['url'] !== 'string' || server['url'] === '') {
        skipped.push({ name, reason: 'http の url が読めない' });
        continue;
      }
      entry = { url: server['url'] };
      const headers = server['headers'];
      if (isStringMap(headers) && Object.keys(headers).length > 0) {
        entry['http_headers'] = { ...headers };
      }
    } else if (type === undefined || type === 'stdio') {
      if (typeof server['command'] !== 'string' || server['command'] === '') {
        skipped.push({ name, reason: 'stdio の command が読めない' });
        continue;
      }
      entry = { command: server['command'] };
      if (Array.isArray(server['args'])) entry['args'] = [...(server['args'] as unknown[])];
      const env = server['env'];
      if (isStringMap(env) && Object.keys(env).length > 0) entry['env'] = { ...env };
    } else {
      skipped.push({ name, reason: '知らない種別の MCP サーバ' });
      continue;
    }
    // timeout / alwaysLoad を渡さない: Codex 側の対応する欄を確認できていないため
    const dropped = ['timeout', 'alwaysLoad'].filter((f) => server[f] !== undefined);
    if (dropped.length > 0) droppedFields.push({ name, fields: dropped });
    out[name] = entry;
  }
  const passed = Object.keys(out);
  return {
    config: passed.length === 0 ? null : { mcp_servers: out },
    passed,
    skipped,
    droppedFields,
  };
}

function isStringMap(value: unknown): value is Record<string, string> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((v) => typeof v === 'string')
  );
}
