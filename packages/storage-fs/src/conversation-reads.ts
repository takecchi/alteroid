import { mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { compareIsoInstant } from '@alteroid/core';
import type {
  ConversationBaselineResult,
  ConversationReadPosition,
  ConversationReadRead,
  ConversationReadStore,
} from '@alteroid/core';
import { z } from 'zod';

import { writeFileAtomic } from './atomic.js';
import { withPathLock } from './file-lock.js';

const positionSchema = z.object({
  readThrough: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
});

const fileSchema = z.object({
  baseline: z.string().datetime({ offset: true }).nullable(),
  conversations: z.record(z.string(), positionSchema),
});

type FileContent = z.infer<typeof fileSchema>;

/**
 * 会話の既読の位置と基準時刻（既定 `~/.alteroid/jobs/conversation-reads.json`）。
 *
 * 通知の既読（承認待ちと同じ `jobs/`）と同じ流儀で、人間への知らせの「どこまで読んだか」
 * をまとめて置く。**書くのは `withPathLock` の中で読み直してから**——読んでから書くまでの間に
 * 別の入口が進めた位置を、古い値で踏み戻さない（`advance` の「戻らない」、`ensureBaseline`
 * の「一度決まったら変えない」）。
 */
export class FsConversationReadStore implements ConversationReadStore {
  readonly #path: string;

  constructor(dir: string) {
    this.#path = join(dir, 'conversation-reads.json');
  }

  async #load(): Promise<
    { state: 'ok'; content: FileContent } | { state: 'unreadable'; reason: string }
  > {
    let raw: string;
    try {
      raw = await readFile(this.#path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { state: 'ok', content: { baseline: null, conversations: {} } };
      }
      return { state: 'unreadable', reason: describeError(error) };
    }
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch (error) {
      return { state: 'unreadable', reason: `JSON として読めない: ${describeError(error)}` };
    }
    const parsed = fileSchema.safeParse(json);
    if (!parsed.success) {
      const fields = parsed.error.issues.map((issue) => issue.path.join('.') || '(根)');
      return { state: 'unreadable', reason: `不正な欄: ${[...new Set(fields)].join(', ')}` };
    }
    return { state: 'ok', content: parsed.data };
  }

  async read(): Promise<ConversationReadRead> {
    const loaded = await this.#load();
    if (loaded.state === 'unreadable') return loaded;
    return {
      state: 'ok',
      baseline: loaded.content.baseline,
      positions: loaded.content.conversations,
    };
  }

  async ensureBaseline(at: string): Promise<ConversationBaselineResult> {
    await mkdir(dirname(this.#path), { recursive: true });
    return withPathLock(this.#path, async () => {
      const loaded = await this.#load();
      // 読めないファイルは書き換えない（位置の手がかりを黙って消さない）。
      if (loaded.state === 'unreadable') return loaded;
      if (loaded.content.baseline !== null) {
        return { state: 'ok' as const, baseline: loaded.content.baseline };
      }
      await this.#write({ ...loaded.content, baseline: at });
      return { state: 'ok' as const, baseline: at };
    });
  }

  async advance(conversationId: string, readThrough: string): Promise<ConversationReadPosition> {
    await mkdir(dirname(this.#path), { recursive: true });
    return withPathLock(this.#path, async () => {
      const loaded = await this.#load();
      // 読めないときは、この会話の位置で書き直す（基準時刻はいまに決め直す）。
      const content: FileContent =
        loaded.state === 'ok'
          ? loaded.content
          : { baseline: new Date().toISOString(), conversations: {} };
      const current = content.conversations[conversationId];
      if (current !== undefined && compareIsoInstant(readThrough, current.readThrough) <= 0) {
        return current;
      }
      const next: ConversationReadPosition = {
        readThrough,
        updatedAt: new Date().toISOString(),
      };
      await this.#write({
        ...content,
        conversations: { ...content.conversations, [conversationId]: next },
      });
      return next;
    });
  }

  async #write(content: FileContent): Promise<void> {
    await writeFileAtomic(this.#path, `${JSON.stringify(content, null, 2)}\n`);
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
