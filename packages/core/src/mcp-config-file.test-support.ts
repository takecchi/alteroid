import { readFileSync } from 'node:fs';

import type { McpServerConfig, Options } from '@anthropic-ai/claude-agent-sdk';

/**
 * CLI が見る MCP 登録の全体（`mcpServers` と、`--mcp-config` のファイルの中身を合わせたもの）を載せた Options を返す。
 * childUser の無い runner は資格つきの登録を argv に載る `mcpServers` ではなくファイルで渡し、ファイルはセッションが終わると消えるので、
 * 起こした瞬間に呼ぶこと。
 */
export function withEffectiveMcpServers<T extends Options>(options: T): T {
  const path = (options.extraArgs as Record<string, string | null> | undefined)?.['mcp-config'];
  if (typeof path !== 'string') return options;
  const fromFile = (
    JSON.parse(readFileSync(path, 'utf8')) as { mcpServers: Record<string, McpServerConfig> }
  ).mcpServers;
  const merged = { ...fromFile, ...(options.mcpServers ?? {}) };
  return Object.keys(merged).length === 0 ? options : { ...options, mcpServers: merged };
}
