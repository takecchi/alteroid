import type { McpServerEntryConfig } from './mcp-servers.js';

/**
 * alteroid の MCP サーバ登録（`McpServers`・`.mcp.json` と同じ形）を、Codex app-server の
 * `thread/start` / `thread/resume` の `config` へ写す純関数（#486 M7 S6）。
 *
 * 後で alteroid の `peer` MCP サーバやクローンの道具中継も同じ写しで運ぶので、駆動役の中に
 * 埋めず、入出力が値だけの関数として置く。
 *
 * ## 何を確かめ、何を推測しているか（固定した版: `@openai/codex` 0.160.0）
 *
 * 確認済み（成果物から読んだ）:
 * - `codex-schema/0.160.0/codex_app_server_protocol.schemas.json` の `ThreadStartParams.config` /
 *   `ThreadResumeParams.config` は `{"additionalProperties":true,"type":["object","null"]}`。
 *   つまり任意のオブジェクトを受ける（欄の中身は schema からは分からない）。
 * - 同版の linux-x64 バイナリの文字列に、設定の TOML 用の欄名として次が在る:
 *   `mcp_servers.` / `Stdio` 型の `command` `env` `cwd` / `StreamableHttp` 型の `url`
 *   `bearer_token_env_var` `http_headers` `http_headers_helper` / `startup_timeout_sec` /
 *   エラー文「mcp_servers.<名前> uses unsupported `bearer_token`; set `bearer_token_env_var`」。
 *   HTTP の種別名が `StreamableHttp` のみで、SSE 専用の種別は見つからなかった。
 *
 * 推測（実機の app-server では確かめていない）:
 * - `config` オブジェクトが `config.toml` と同じ構造（`{ mcp_servers: { <名前>: {...} } }`）として
 *   取り込まれ、起動した thread で MCP サーバが実際に繋がること。
 * - stdio の `args`（`command` の引数列）が Codex の欄名であること（バイナリ内では短い名前なので
 *   文字列として単独では確認できなかった。Codex 公式の config.toml の書式に従う）。
 * - `http_headers` が `{ 名前: 値 }` の静的な写しであること。
 * ⟹ だから `CODEX_PROVIDER.capabilities.mcpServers` は false のままにしている。
 *
 * ## 写せないもの（`skipped` に理由つきで返す。黙って捨てない）
 * - `sdk`（インプロセス。生きた `McpServer` を持つのでシリアライズできない）
 * - `sse`（Codex は Streamable HTTP だけ。SSE として繋がる保証が無いので `http` として偽って渡さない）
 * - 形が読めないもの
 * 写せた登録でも、`timeout` / `alwaysLoad` は Codex 側の対応する欄を確認できていないので渡さない。
 * 渡さなかった欄名は `droppedFields` に返す。
 *
 * ## ⚠️ 値に鍵が入りうる
 * 返す `config` には `env` / `http_headers` の値が入る（app-server へ JSON-RPC で渡すためで、
 * argv には載せない）。`skipped` の `reason` と `droppedFields` には**名前と欄名だけ**を書き、
 * 値は載せない。
 */

/** 呼び出し側が渡せる登録。`sdk` はインプロセスの型で、運べないことを `skipped` で言うために受ける。 */
export type CodexMcpInputServer = McpServerEntryConfig | { type: 'sdk'; name?: string };

export interface CodexMcpSkipped {
  name: string;
  /** 値を含まない理由。 */
  reason: string;
}

export interface CodexMcpDropped {
  name: string;
  fields: string[];
}

export interface CodexMcpConfigResult {
  /** `thread/start` / `thread/resume` の `config` に混ぜる断片。1件も写せなければ null。 */
  config: { mcp_servers: Record<string, Record<string, unknown>> } | null;
  /** 実際に渡した登録の名前（昇順）。 */
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
