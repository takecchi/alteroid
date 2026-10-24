import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as joinPath } from 'node:path';

export interface SplitMcpServers {
  inProcess: Record<string, McpServerConfig>;
  external: Record<string, McpServerConfig>;
}

function isInProcess(config: McpServerConfig): boolean {
  return config.type === 'sdk' && 'instance' in config && config.instance !== undefined;
}

export function splitInProcessMcpServers(
  servers: Readonly<Record<string, McpServerConfig>>,
): SplitMcpServers {
  const inProcess: Record<string, McpServerConfig> = {};
  const external: Record<string, McpServerConfig> = {};
  for (const [name, config] of Object.entries(servers)) {
    (isInProcess(config) ? inProcess : external)[name] = config;
  }
  return { inProcess, external };
}

export interface CloneMcpConfigFile {
  path: string;
  remove: () => void;
}

// CLI（`alteroid-mcp-`）と runner（`alteroid-runner-mcp-config-`）のどちらもこの接頭辞で始まらない: 掃きが巻き込まないため
export const CLONE_MCP_CONFIG_DIR_PREFIX = 'alteroid-clone-mcp-';

// このプロセスが作って、まだ remove していないディレクトリ。掃きが「今使っているもの」を消さないために読む
const liveCloneMcpConfigDirs = new Set<string>();

export function liveCloneMcpConfigDirPaths(): ReadonlySet<string> {
  return liveCloneMcpConfigDirs;
}

// JSON を argv へ戻さない: 書けないときは投げる。argv は同じ器の他のプロセスから読めるため、資格が出る
// 名前に pid を入れる: デーモンが落ちて残ったものを、持ち主が居ないと見分けて掃くため
export function writeCloneMcpConfigFile(
  external: Readonly<Record<string, McpServerConfig>>,
): CloneMcpConfigFile | undefined {
  if (Object.keys(external).length === 0) return undefined;
  const dir = mkdtempSync(
    joinPath(tmpdir(), `${CLONE_MCP_CONFIG_DIR_PREFIX}${String(process.pid)}-`),
  );
  liveCloneMcpConfigDirs.add(dir);
  const path = joinPath(dir, 'mcp-config.json');
  const remove = (): void => {
    // 集合から先に外す: 消すのに失敗したとき、掃きが「今使っているもの」と読んで残し続けないため
    liveCloneMcpConfigDirs.delete(dir);
    rmSync(dir, { recursive: true, force: true });
  };
  try {
    writeFileSync(path, JSON.stringify({ mcpServers: external }), { mode: 0o600, flag: 'wx' });
  } catch (error) {
    remove();
    throw error;
  }
  return { path, remove };
}

// 全体を分けて、外へ出す側だけをファイルにする。インプロセス側は SDK が argv に載せない
export function stageCloneMcpServers(servers: Readonly<Record<string, McpServerConfig>>): {
  inProcess: Record<string, McpServerConfig>;
  file: CloneMcpConfigFile | undefined;
} {
  const { inProcess, external } = splitInProcessMcpServers(servers);
  return { inProcess, file: writeCloneMcpConfigFile(external) };
}
