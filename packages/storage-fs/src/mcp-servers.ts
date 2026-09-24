import { mkdir, readFile, rm, stat } from 'node:fs/promises';
import { dirname } from 'node:path';

import { parseMcpServers } from '@alteroid/core';
import type { McpServers, McpServerStore, StoredMcpServers } from '@alteroid/core';

import { writeFileAtomic } from './atomic.js';
import { withPathLock } from './file-lock.js';

/**
 * 人間の MCP 連携の登録の置き場（既定 `~/.alteroid/mcp-servers.json`。#325 段1）。
 *
 * **中身は `.mcp.json` と同じ形（`{ "mcpServers": { … } }`）にしてある。** 人間の
 * 手元の `.mcp.json` と見比べて読めるようにするためである。更新時刻はファイルの
 * mtime から読む（`FsProfileStore` と同じ。形に欄を足すと `.mcp.json` と違う形になる）。
 *
 * **0600 で持つ。** `env` / `headers` に鍵が入りうる（`FsCredentialVaultStore` と
 * 同じ扱い）。**`memory/` には置かない**（クローンのシステムプロンプトに載る）。
 *
 * **読むときにも検査する。** ファイルは手で書き換えられるので、入口（HTTP）で
 * 見ただけでは、手で書いた `alteroid` という名前がそのままクローンへ渡る。
 * 読めなければ投げる —— 黙って空として読むと「登録したのに0本」が原因の
 * 出ない形で起きる（呼ぶ側のクローンは投げられたら外部の連携なしで起き、
 * そのことを日誌に残す。`clone.ts` の `#externalMcpServers`）。
 */
export class FsMcpServerStore implements McpServerStore {
  readonly #path: string;

  constructor(path: string) {
    this.#path = path;
  }

  async read(): Promise<StoredMcpServers | null> {
    let raw: string;
    let mtime: Date;
    try {
      [raw, { mtime }] = await Promise.all([readFile(this.#path, 'utf8'), stat(this.#path)]);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // **`SyntaxError` の文言を載せない。** Node の JSON.parse は本文の断片を
      // 文言に含める（鍵が入りうる）。
      throw new Error(`${this.#path} が JSON として読めない`);
    }
    const servers = parseMcpServers(
      parsed !== null && typeof parsed === 'object' && 'mcpServers' in parsed
        ? parsed.mcpServers
        : undefined,
    );
    if (Object.keys(servers).length === 0) return null;
    return { mcpServers: servers, updatedAt: mtime.toISOString() };
  }

  async write(input: McpServers): Promise<StoredMcpServers> {
    // **書く前に検査する**（`McpServerStore.write` の doc）。不正ならここで投げ、
    // ファイルには1バイトも触れない（前のものが残る）。
    const servers = parseMcpServers(input);
    const at = new Date().toISOString();
    await withPathLock(this.#path, async () => {
      if (Object.keys(servers).length === 0) {
        await rm(this.#path, { force: true });
        return;
      }
      await mkdir(dirname(this.#path), { recursive: true });
      // 一時ファイルの時点で 0600（`writeFileAtomic` の `mode`）。
      await writeFileAtomic(this.#path, `${JSON.stringify({ mcpServers: servers }, null, 2)}\n`, {
        mode: 0o600,
      });
    });
    return { mcpServers: servers, updatedAt: at };
  }
}
