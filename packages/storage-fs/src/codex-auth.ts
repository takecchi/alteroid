import { mkdir, readFile, rm } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { CodexChatgptAuthRecord, CodexChatgptAuthStore } from '@alteroid/core';
import { z } from 'zod';

import { writeFileAtomic } from './atomic.js';
import { withPathLock } from './file-lock.js';

const recordSchema = z.object({
  value: z.string(),
  revision: z.string().min(1),
  updatedAt: z.string(),
  email: z.string().nullable(),
  planType: z.string().nullable(),
  failure: z.object({ at: z.string(), reason: z.string() }).nullable(),
});

/**
 * Codex の ChatGPT ログインの正本（既定 `~/.alteroid/codex-chatgpt-auth.json`、0600。#3939）。
 *
 * **書くのは `withPathLock` の中で読み直してから**——compare-and-swap は「読んだ版と同じなら置く」
 * なので、読んでから書くまでの間に別の書き戻しが入ると古い値で新しい値を潰す。
 *
 * **読めないファイルは「無い」と混ぜずに投げる**（壊れた正本を黙って「ログインしていない」と
 * 読むと、次のログインが上書きして跡が消える）。理由の文に値は載せない（欄の名前だけ）。
 */
export class FsCodexChatgptAuthStore implements CodexChatgptAuthStore {
  readonly #path: string;

  constructor(path: string) {
    this.#path = path;
  }

  async #read(): Promise<CodexChatgptAuthRecord | null> {
    let raw: string;
    try {
      raw = await readFile(this.#path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      throw new Error(`${this.#path} が JSON として読めない`);
    }
    const parsed = recordSchema.safeParse(json);
    if (!parsed.success) {
      const fields = parsed.error.issues.map((issue) => issue.path.join('.') || '(根)');
      throw new Error(`${this.#path} の欄が不正: ${[...new Set(fields)].join(', ')}`);
    }
    return parsed.data;
  }

  async #write(record: CodexChatgptAuthRecord): Promise<void> {
    await mkdir(dirname(this.#path), { recursive: true });
    await writeFileAtomic(this.#path, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  }

  async get(): Promise<CodexChatgptAuthRecord | null> {
    return this.#read();
  }

  async replace(record: CodexChatgptAuthRecord): Promise<void> {
    await withPathLock(this.#path, () => this.#write(recordSchema.parse(record)));
  }

  async compareAndSwap(expectedRevision: string, next: CodexChatgptAuthRecord): Promise<boolean> {
    return withPathLock(this.#path, async () => {
      const current = await this.#read();
      if (current === null || current.revision !== expectedRevision) return false;
      await this.#write(recordSchema.parse(next));
      return true;
    });
  }

  async remove(): Promise<boolean> {
    return withPathLock(this.#path, async () => {
      const current = await this.#read().catch(() => 'unreadable' as const);
      if (current === null) return false;
      await rm(this.#path, { force: true });
      return true;
    });
  }
}
