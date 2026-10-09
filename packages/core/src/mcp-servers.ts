import { createHash } from 'node:crypto';

import { z } from 'zod';

import { compareCodeUnits } from './code-unit-order.js';
import { assertNoNul, stripNul } from './nul-guard.js';
import { MCP_SERVER_NAME } from './tools.js';

// 未知の欄は黙って捨てずに拒む（z.strictObject）: 捨てると綴りを間違えた `headers` が
// 「保存できたのに効かない」になる。`env` / `headers` / `args` には秘密が入りうるので、日誌には名前だけを書く。

/** 名前は道具名の一部（`mcp__<名前>__<道具>`）になる。緩めると `allowedTools` の照合が壊れる。 */
const MCP_SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** 大文字小文字を無視して比べる: 接頭辞 `mcp__alteroid__` で自作ツールを許可しているので、見分けにくい綴りの別サーバを入口で止める。 */
export function isReservedMcpServerName(name: string): boolean {
  return name.toLowerCase() === MCP_SERVER_NAME.toLowerCase();
}

export const mcpServerNameSchema = z
  .string()
  .regex(MCP_SERVER_NAME_PATTERN, '英数字・-・_ の1〜64文字で書くこと')
  .refine((name) => !isReservedMcpServerName(name), {
    message: `「${MCP_SERVER_NAME}」は alteroid 自身の MCP サーバの名前なので使えない`,
  });

const stringMapSchema = z.record(z.string(), z.string());

const commonFields = {
  timeout: z.number().int().positive().optional(),
  alwaysLoad: z.boolean().optional(),
};

// NUL だけの値は、`prepareMcpServersForWrite` が NUL を落とすと空になる。落とした後の形で断る。
const nonEmptyAfterNul = z
  .string()
  .min(1)
  .refine((value) => stripNul(value).length > 0, { message: 'NUL（\\u0000）だけの値は空と同じ' });

export const mcpStdioServerConfigSchema = z.strictObject({
  type: z.literal('stdio').optional(),
  command: nonEmptyAfterNul,
  args: z.array(z.string()).optional(),
  env: stringMapSchema.optional(),
  ...commonFields,
});

export const mcpHttpServerConfigSchema = z.strictObject({
  type: z.literal('http'),
  url: nonEmptyAfterNul,
  headers: stringMapSchema.optional(),
  ...commonFields,
});

export const mcpSseServerConfigSchema = z.strictObject({
  type: z.literal('sse'),
  url: nonEmptyAfterNul,
  headers: stringMapSchema.optional(),
  ...commonFields,
});

export const mcpServerConfigSchema = z.union([
  mcpStdioServerConfigSchema,
  mcpHttpServerConfigSchema,
  mcpSseServerConfigSchema,
]);

export const mcpServersSchema = z.record(mcpServerNameSchema, mcpServerConfigSchema);

export type McpServerEntryConfig = z.infer<typeof mcpServerConfigSchema>;
export type McpServers = z.infer<typeof mcpServersSchema>;

export interface StoredMcpServers {
  mcpServers: McpServers;
  updatedAt: string;
}

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
