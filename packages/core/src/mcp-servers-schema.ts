import { z } from 'zod';

import { MCP_SERVER_NAME } from './mcp-server-name.js';
import { stripNul } from './nul-guard.js';

// MCP サーバの登録の「形」。保存の入口（parseMcpServers）と、web の保存前の検査が同じものを使う
// zod・nul-guard・名前の定数だけを import する小さな入口に切る: mcp-servers.ts は node:crypto を引くので、ブラウザの束へ入れられないため
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
