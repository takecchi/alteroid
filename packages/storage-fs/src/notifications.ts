import { mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { compareIsoInstant } from '@alteroid/core';
import type {
  NotificationCursorRead,
  NotificationReadCursor,
  NotificationStore,
} from '@alteroid/core';
import { z } from 'zod';

import { writeFileAtomic } from './atomic.js';
import { withPathLock } from './file-lock.js';

const cursorFileSchema = z.object({
  readThrough: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
});

/**
 * 人間への通知の既読の位置（既定 `~/.alteroid/jobs/notifications.json`。issue #2515）。
 *
 * 承認待ち（`jobs.json`）と同じディレクトリに置く——一覧の元が承認待ちキューで、
 * ここはその「どこまで読んだか」だけを持つ。
 *
 * **進めるのは `withPathLock` の中で読み直してから。** 読んでから書くまでの間に
 * 別の入口が進めた位置を、古い値で踏み戻さない（`NotificationStore.advanceReadCursor`
 * の「戻らない」）。
 */
export class FsNotificationStore implements NotificationStore {
  readonly #path: string;

  constructor(dir: string) {
    this.#path = join(dir, 'notifications.json');
  }

  async readCursor(): Promise<NotificationCursorRead> {
    let raw: string;
    try {
      raw = await readFile(this.#path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { state: 'none' };
      return { state: 'unreadable', reason: describeError(error) };
    }
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch (error) {
      return { state: 'unreadable', reason: `JSON として読めない: ${describeError(error)}` };
    }
    const parsed = cursorFileSchema.safeParse(json);
    if (!parsed.success) {
      const fields = parsed.error.issues.map((issue) => issue.path.join('.') || '(根)');
      return { state: 'unreadable', reason: `不正な欄: ${[...new Set(fields)].join(', ')}` };
    }
    return { state: 'ok', cursor: parsed.data };
  }

  async advanceReadCursor(through: string): Promise<NotificationReadCursor> {
    await mkdir(dirname(this.#path), { recursive: true });
    return withPathLock(this.#path, async () => {
      const current = await this.readCursor();
      if (current.state === 'ok' && compareIsoInstant(through, current.cursor.readThrough) <= 0) {
        return current.cursor;
      }
      const next: NotificationReadCursor = {
        readThrough: through,
        updatedAt: new Date().toISOString(),
      };
      await writeFileAtomic(this.#path, `${JSON.stringify(next, null, 2)}\n`);
      return next;
    });
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
