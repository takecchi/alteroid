import { createHash } from 'node:crypto';

import { compareCodeUnits } from './code-unit-order.js';
import { mcpServersSchema, type McpServers } from './mcp-servers-schema.js';
import { assertNoNul, stripNul } from './nul-guard.js';

// 形のスキーマは mcp-servers-schema.ts（ブラウザの束にも入れられる小さな入口）。ここから再び出す: 既存の import 先を変えないため
export {
  isReservedMcpServerName,
  mcpHttpServerConfigSchema,
  mcpServerConfigSchema,
  mcpServerNameSchema,
  mcpServersSchema,
  mcpSseServerConfigSchema,
  mcpStdioServerConfigSchema,
  type McpServerEntryConfig,
  type McpServers,
} from './mcp-servers-schema.js';

export interface StoredMcpServers {
  mcpServers: McpServers;
  updatedAt: string;
}

/** 日誌・応答に値を載せないための口（`env` / `headers` には鍵が入りうる）。 */
export function mcpServerNames(servers: McpServers): string[] {
  return Object.keys(servers).sort();
}

// 3実装が同じ関数を呼ぶ（器ごとに検査を書くと1つだけ緩い器が生まれる）。例外の文言に値を載せない。
export function parseMcpServers(input: unknown): McpServers {
  const result = mcpServersSchema.safeParse(input);
  if (result.success) return result.data;
  const first = result.error.issues[0];
  const where = first === undefined ? '' : first.path.map(String).join('.');
  throw new Error(
    `MCP サーバの登録の形が不正: ${where === '' ? '' : `${where}: `}${first?.message ?? '理由不明'}`,
  );
}

// pg の jsonb は書いた順を保たないので、3実装が戻り値をこれで揃える。
export function sortMcpServers(servers: McpServers): McpServers {
  return Object.fromEntries(
    Object.entries(servers).sort(([a], [b]) => compareCodeUnits(a, b)),
  ) as McpServers;
}

// 鍵の順序に依存させない: pg の jsonb はキーを並べ替えて返すので、書いた JSON 文字列から取ると
// 同じ登録なのに指紋が食い違う。配列（`args`）の順序は意味を持つのでそのまま。
export function mcpServersFingerprintOf(servers: McpServers): string {
  return createHash('sha256').update(canonicalJson(servers), 'utf8').digest('hex').slice(0, 12);
}

// `updatedAt` は fs では mtime で器ごとに粒度が違うので版に使わない。null と空の `{}` は同じ版。
export function mcpServersVersionOf(stored: Pick<StoredMcpServers, 'mcpServers'> | null): string {
  return createHash('sha256')
    .update(canonicalJson(stored === null ? {} : stored.mcpServers), 'utf8')
    .digest('hex');
}

export interface WriteMcpServersOptions {
  /** 省略は無条件の全文置換（CLI のため）。 */
  ifMatch?: string;
}

export class McpServersConflictError extends Error {
  readonly current: StoredMcpServers | null;
  constructor(current: StoredMcpServers | null) {
    super('MCP サーバの登録が読んだ後に変わっています');
    this.name = 'McpServersConflictError';
    this.current = current;
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

// サーバー名と `env` の名前・値は断る（名前は鍵、`env` は環境変数になり NUL を入れられない）。
// それ以外は NUL を落として残す（pg の jsonb は NUL を持てないので fs も揃える）。
export function prepareMcpServersForWrite(input: unknown): unknown {
  if (!isPlainObject(input)) return input;
  const out: Record<string, unknown> = {};
  for (const [name, config] of Object.entries(input)) {
    assertNoNul('mcpServer.name', name);
    if (!isPlainObject(config)) {
      out[name] = config;
      continue;
    }
    const prepared: Record<string, unknown> = {};
    for (const [field, value] of Object.entries(config)) {
      if (field === 'env' && isPlainObject(value)) {
        for (const [envName, envValue] of Object.entries(value)) {
          assertNoNul('mcpServer.env.name', envName);
          if (typeof envValue === 'string') assertNoNul('mcpServer.env.value', envValue);
        }
        prepared[field] = { ...value };
      } else {
        prepared[field] = stripNulDeep(value);
      }
    }
    out[name] = prepared;
  }
  return out;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stripNulDeep(value: unknown): unknown {
  if (typeof value === 'string') return stripNul(value);
  if (Array.isArray(value)) return value.map(stripNulDeep);
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [stripNul(k), stripNulDeep(v)]),
    );
  }
  return value;
}
