import { mkdir, readFile, rm, stat } from 'node:fs/promises';
import { dirname } from 'node:path';

import { parseMcpServers, prepareMcpServersForWrite, sortMcpServers } from '@alteroid/core';
import type { McpServers, McpServerStore, StoredMcpServers } from '@alteroid/core';

import { writeFileAtomic } from './atomic.js';
import { withPathLock } from './file-lock.js';

// 読めなければ黙って空にせず投げる: 「登録したのに0本」が原因の出ない形で起きるため
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
      // `SyntaxError` の文言を載せない: Node の JSON.parse は本文の断片（鍵が入りうる）を文言に含めるため
      throw new Error(`${this.#path} が JSON として読めない`);
    }
    const servers = sortMcpServers(
      parseMcpServers(
        parsed !== null && typeof parsed === 'object' && 'mcpServers' in parsed
          ? parsed.mcpServers
          : undefined,
      ),
    );
    if (Object.keys(servers).length === 0) return null;
    return { mcpServers: servers, updatedAt: mtime.toISOString() };
  }

  async write(input: McpServers): Promise<StoredMcpServers> {
    const servers = parseMcpServers(prepareMcpServersForWrite(input));
    const at = new Date().toISOString();
    await withPathLock(this.#path, async () => {
      if (Object.keys(servers).length === 0) {
        await rm(this.#path, { force: true });
        return;
      }
      await mkdir(dirname(this.#path), { recursive: true });
      await writeFileAtomic(this.#path, `${JSON.stringify({ mcpServers: servers }, null, 2)}\n`, {
        mode: 0o600,
      });
    });
    return { mcpServers: sortMcpServers(servers), updatedAt: at };
  }
}
