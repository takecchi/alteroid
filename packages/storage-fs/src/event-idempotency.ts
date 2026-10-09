import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  assertEventIdempotencyInput,
  claimInRows,
  releaseInRows,
  scopeHasNul,
} from '@alteroid/core';
import type {
  ClaimEventIdempotencyOutcome,
  EventIdempotencyRow,
  EventIdempotencyScope,
  EventIdempotencyStore,
} from '@alteroid/core';
import { z } from 'zod';

import { writeFileAtomic } from './atomic.js';
import { withPathLock } from './file-lock.js';

const rowSchema = z.object({
  sender: z.string(),
  source: z.string(),
  key: z.string(),
  eventId: z.string(),
  at: z.string(),
});
const fileSchema = z.object({ rows: z.array(z.unknown()).default([]) });

/** 全件を1ファイルに持つ（期限が7日なので行は流量の7日分で頭打ちになる）。排他区間の中で読んで書くので、並行しても取れるのは1本だけ。 */
export class FsEventIdempotencyStore implements EventIdempotencyStore {
  readonly #dir: string;
  readonly #path: string;

  constructor(dir: string) {
    this.#dir = dir;
    this.#path = join(dir, 'event-idempotency.json');
  }

  async claim(
    scope: EventIdempotencyScope,
    eventId: string,
    at: string,
  ): Promise<ClaimEventIdempotencyOutcome> {
    assertEventIdempotencyInput(scope, eventId, at);
    return this.#mutate((rows) => {
      const next = claimInRows(rows, scope, eventId, at);
      return { next: next.rows, result: next.outcome };
    });
  }

  async release(scope: EventIdempotencyScope, eventId: string): Promise<void> {
    if (scopeHasNul(scope)) return;
    await this.#mutate((rows) => {
      const next = releaseInRows(rows, scope, eventId);
      return { next: next.length === rows.length ? null : next, result: undefined };
    });
  }

  async #read(): Promise<EventIdempotencyRow[]> {
    let text: string;
    try {
      text = await readFile(this.#path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const top = fileSchema.parse(JSON.parse(text));
    const rows: EventIdempotencyRow[] = [];
    let skipped = 0;
    for (const raw of top.rows) {
      const parsed = rowSchema.safeParse(raw);
      if (parsed.success) rows.push(parsed.data);
      else skipped += 1;
    }
    // 重複キーの記録は「覚えておく」ためのもので、読めない行を持ち回らない: 落ちても起きるのは二重配達（受信箱の方針では消えるより安い）で、期限が来れば消える行だから。
    if (skipped > 0) {
      process.stderr.write(
        `alteroid: event-idempotency の読めない行を ${String(skipped)} 件読み飛ばしました\n`,
      );
    }
    return rows;
  }

  async #mutate<T>(
    mutate: (rows: EventIdempotencyRow[]) => { next: EventIdempotencyRow[] | null; result: T },
  ): Promise<T> {
    return withPathLock(this.#path, async () => {
      const { next, result } = mutate(await this.#read());
      if (next === null) return result;
      await mkdir(this.#dir, { recursive: true });
      await writeFileAtomic(this.#path, `${JSON.stringify({ rows: next })}\n`, { mode: 0o600 });
      return result;
    });
  }
}
