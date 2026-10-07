import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { compareIsoInstant, earliestIsoInstant, inboxEventSchema } from '@alteroid/core';
import type {
  InboxEvent,
  InboxPeek,
  InboxStore,
  PendingInboxEvent,
  UnreadableInboxEvent,
} from '@alteroid/core';
import { z } from 'zod';

import { writeFileAtomic } from './atomic.js';
import { withPathLock } from './file-lock.js';

const inboxEntrySchema = z.object({
  event: inboxEventSchema,
  at: z.string(),
  deliveries: z.number().int().nonnegative(),
});

// 行の中身はここで検査しない: `z.array(inboxEntrySchema)` にすると、1行の不正で受信箱の読み書きが丸ごと例外になるため
const fileSchema = z.object({
  events: z.array(z.unknown()).default([]),
});

type InboxEntry = z.infer<typeof inboxEntrySchema>;

interface InboxFile {
  events: InboxEntry[];
  invalidEventsRaw: unknown[];
}

const EMPTY: InboxFile = { events: [], invalidEventsRaw: [] };

function extractEventId(raw: unknown): string | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const event = (raw as Record<string, unknown>).event;
  if (typeof event !== 'object' || event === null) return undefined;
  const id = (event as Record<string, unknown>).id;
  return typeof id === 'string' ? id : undefined;
}

function extractEntryAt(raw: unknown): string | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const at = (raw as Record<string, unknown>).at;
  return typeof at === 'string' ? at : undefined;
}

// zod のメッセージは使わず欄の名前だけを出す: 受け取った値を含みうるため
function summarizeInvalidFields(paths: readonly (readonly PropertyKey[])[]): string {
  const fields = [
    ...new Set(paths.map((path) => (path.length > 0 ? path.map(String).join('.') : '(root)'))),
  ];
  return fields.length > 0 ? `不正な欄: ${fields.join(',')}` : '不正な行';
}

function describeSkippedInboxRow(params: {
  index: number;
  fields: readonly string[];
  id?: string;
}): string {
  const idNote = params.id === undefined ? '' : ` id=${JSON.stringify(params.id)}`;
  const reason = params.fields.length > 0 ? `不正な欄: ${params.fields.join(',')}` : '不正な行';
  return `alteroid: 受信箱の不正な行を読み飛ばしました（${params.index + 1} 行目、${reason}）${idNote}`;
}

export class FsInboxStore implements InboxStore {
  readonly #dir: string;
  readonly #path: string;

  constructor(dir: string) {
    this.#dir = dir;
    this.#path = join(dir, 'inbox.json');
  }

  async put(event: InboxEvent, at: string): Promise<void> {
    const value = inboxEventSchema.parse(event);
    // `Z` 付きの ISO 表記に正規化して保存する: pg（`timestamptz`）と表記をそろえるため
    const normalizedAt = new Date(at).toISOString();
    await this.#update((file) => {
      const existing = file.events.find((entry) => entry.event.id === value.id);
      return {
        next: {
          events: [
            ...file.events.filter((entry) => entry.event.id !== value.id),
            { event: value, at: normalizedAt, deliveries: existing?.deliveries ?? 0 },
          ],
          invalidEventsRaw: file.invalidEventsRaw.filter((raw) => extractEventId(raw) !== value.id),
        },
        result: undefined,
      };
    });
  }

  async remove(id: string): Promise<void> {
    // id が一致する読めない行も消す: 「読めない行は残す」線は黙って失わないためのもので、名指しの削除は意図した操作のため
    await this.#update((file) => ({
      next: {
        ...file,
        events: file.events.filter((entry) => entry.event.id !== id),
        invalidEventsRaw: file.invalidEventsRaw.filter((raw) => extractEventId(raw) !== id),
      },
      result: undefined,
    }));
  }

  async claimPending(): Promise<PendingInboxEvent[]> {
    return this.#update((file) => {
      const sorted = [...file.events].sort((a, b) => compareIsoInstant(a.at, b.at));
      const claimed = sorted.map((entry) => ({ ...entry, deliveries: entry.deliveries + 1 }));
      return {
        next: { ...file, events: claimed },
        result: claimed.map((entry) => ({
          event: entry.event,
          at: entry.at,
          deliveries: entry.deliveries,
        })),
      };
    });
  }

  async pending(): Promise<{ count: number; oldestAt?: string }> {
    const file = await this.#read();
    const oldest = earliestIsoInstant(file.events.map((entry) => entry.at));
    return {
      // 壊れた行も件数に数える: pg の `count(*)` と同じく、受信箱に残っている行の数のため
      count: file.events.length + file.invalidEventsRaw.length,
      ...(oldest === undefined ? {} : { oldestAt: oldest }),
    };
  }

  async peekPending(): Promise<InboxPeek> {
    const file = await this.#read();
    return {
      entries: [...file.events]
        .sort((a, b) => compareIsoInstant(a.at, b.at))
        .map((entry) => ({ event: entry.event, at: entry.at, deliveries: entry.deliveries })),
      unreadable: file.invalidEventsRaw.map((raw): UnreadableInboxEvent => {
        const id = extractEventId(raw);
        const at = extractEntryAt(raw);
        const result = inboxEntrySchema.safeParse(raw);
        const reason = result.success
          ? '不正な行'
          : summarizeInvalidFields(result.error.issues.map((issue) => issue.path));
        return {
          ...(id === undefined ? {} : { id }),
          ...(at === undefined ? {} : { at }),
          reason,
        };
      }),
    };
  }

  // `remove()` を件数分呼ばず `#update` の排他区間1回で処理する: 排他区間を件数分取る形にしないため
  async removeMany(ids: readonly string[]): Promise<string[]> {
    // `ids` が空なら `#update` を呼ばない: ファイルの中身が1バイトも変わらないため
    if (ids.length === 0) return [];
    const targets = new Set(ids);
    return this.#update((file) => {
      const removedIds: string[] = [];
      const events = file.events.filter((entry) => {
        if (!targets.has(entry.event.id)) return true;
        removedIds.push(entry.event.id);
        return false;
      });
      const invalidEventsRaw = file.invalidEventsRaw.filter((raw) => {
        const id = extractEventId(raw);
        if (id === undefined || !targets.has(id)) return true;
        if (!removedIds.includes(id)) removedIds.push(id);
        return false;
      });
      return { next: { ...file, events, invalidEventsRaw }, result: removedIds };
    });
  }

  async clear(): Promise<number> {
    return this.#update((file) => ({
      next: EMPTY,
      result: file.events.length + file.invalidEventsRaw.length,
    }));
  }

  async #read(): Promise<InboxFile> {
    let top: z.infer<typeof fileSchema>;
    try {
      const raw = await readFile(this.#path, 'utf8');
      top = fileSchema.parse(JSON.parse(raw));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return EMPTY;
      throw error;
    }
    const events: InboxEntry[] = [];
    const invalidEventsRaw: unknown[] = [];
    top.events.forEach((rawEntry, index) => {
      const result = inboxEntrySchema.safeParse(rawEntry);
      if (result.success) {
        events.push(result.data);
        return;
      }
      invalidEventsRaw.push(rawEntry);
      const fields = [
        ...new Set(
          result.error.issues.map((issue) =>
            issue.path.length > 0 ? issue.path.map(String).join('.') : '(root)',
          ),
        ),
      ];
      process.stderr.write(
        `${describeSkippedInboxRow({ index, fields, id: extractEventId(rawEntry) })}\n`,
      );
    });
    return { events, invalidEventsRaw };
  }

  // 読んだ結果に基づいて書く操作（`claimPending`）を、この区間の外へ出さない: 読んでから書くまでに割り込まれるため
  async #update<T>(mutate: (file: InboxFile) => { next: InboxFile; result: T }): Promise<T> {
    return withPathLock(this.#path, async () => {
      const { next, result } = mutate(await this.#read());
      await mkdir(this.#dir, { recursive: true });
      const onDisk = { events: [...next.events, ...next.invalidEventsRaw] };
      await writeFileAtomic(this.#path, `${JSON.stringify(onDisk, null, 2)}\n`);
      return result;
    });
  }
}
