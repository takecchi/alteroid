import { mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import {
  assertEventReceiptWritable,
  compareIsoInstant,
  eventReceiptCutoff,
  hasNul,
} from '@alteroid/core';
import type { EventReceipt, EventReceiptStore } from '@alteroid/core';
import { z } from 'zod';

import { writeFileAtomic } from './atomic.js';
import { withPathLock } from './file-lock.js';

const receiptSchema = z.object({
  scope: z.string(),
  source: z.string(),
  idempotencyKey: z.string(),
  eventId: z.string(),
  at: z.string().datetime({ offset: true }),
});

const fileSchema = z.object({ receipts: z.array(receiptSchema) });

// 読めないファイルを空として扱わない: 書くときに空で上書きすると、覚えていた重複キーが黙って消えるため
export class FsEventReceiptStore implements EventReceiptStore {
  readonly #path: string;

  constructor(dir: string) {
    this.#path = join(dir, 'event-receipts.json');
  }

  async #load(): Promise<EventReceipt[]> {
    let raw: string;
    try {
      raw = await readFile(this.#path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const parsed = fileSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) {
      const fields = parsed.error.issues.map((issue) => issue.path.join('.') || '(根)');
      throw new Error(`${this.#path} が読めない（不正な欄: ${[...new Set(fields)].join(', ')}）`);
    }
    return parsed.data.receipts;
  }

  async findEventReceipt(
    scope: string,
    source: string,
    idempotencyKey: string,
    now: string,
  ): Promise<EventReceipt | null> {
    if (hasNul(scope) || hasNul(source) || hasNul(idempotencyKey)) return null;
    const cutoff = eventReceiptCutoff(now);
    const found = (await this.#load()).find(
      (row) =>
        row.scope === scope &&
        row.source === source &&
        row.idempotencyKey === idempotencyKey &&
        compareIsoInstant(row.at, cutoff) >= 0,
    );
    return found ?? null;
  }

  async recordEventReceipt(receipt: EventReceipt): Promise<EventReceipt> {
    assertEventReceiptWritable(receipt);
    const value = receiptSchema.parse(receipt);
    return withPathLock(this.#path, async () => {
      const cutoff = eventReceiptCutoff(value.at);
      const kept = (await this.#load()).filter((row) => compareIsoInstant(row.at, cutoff) >= 0);
      const existing = kept.find(
        (row) =>
          row.scope === value.scope &&
          row.source === value.source &&
          row.idempotencyKey === value.idempotencyKey,
      );
      if (existing !== undefined) return existing;
      await mkdir(dirname(this.#path), { recursive: true });
      await writeFileAtomic(this.#path, `${JSON.stringify({ receipts: [...kept, value] })}\n`);
      return value;
    });
  }
}
