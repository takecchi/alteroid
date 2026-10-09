import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

import {
  journalEntrySchema,
  JournalAnchorNotFoundError,
  journalRowType,
  listPageByOverfetch,
  stripNulDeep,
  matchesJournalSearch,
  noteDroppedJournalRow,
  noteDroppedJournalRowsSummary,
  UnreadableJournalEntryError,
} from '@alteroid/core';
import type {
  JournalEntry,
  JournalEntryInput,
  JournalPage,
  JournalQuery,
  JournalStore,
} from '@alteroid/core';

// 書き換えの口は用意しない: 聞かずに実行した判断が日誌に残ることが、人間の事後否定の実体だから
export class FsJournalStore implements JournalStore {
  readonly #dir: string;
  #chain: Promise<unknown> = Promise.resolve();
  // 墓標（`conversation_deleted`）の集合（#4218）。初回の読み出しで全ファイルから集め、追記したらその場で足す。
  // Promise で持つ: 集めている最中の追記も、集め終わった集合へ足せるため。
  #tombstones: Promise<Tombstones> | null = null;

  constructor(dir: string) {
    this.#dir = dir;
  }

  async append(input: JournalEntryInput): Promise<JournalEntry> {
    const entry = journalEntrySchema.parse({
      ...stripNulDeep(input),
      id: randomUUID(),
      at: new Date().toISOString(),
    });

    // 直列化する: 同時追記で行が混ざるため
    const run = this.#chain.then(async () => {
      await mkdir(this.#dir, { recursive: true });
      await appendFile(this.#file(entry.at), `${JSON.stringify(entry)}\n`, 'utf8');
    });
    this.#chain = run.catch(() => undefined);
    await run;

    // 書いたあとに足す: 集めている最中だったとき、読み落とした可能性があるため
    if (entry.type === 'conversation_deleted' && this.#tombstones !== null) {
      try {
        addTombstone(await this.#tombstones, entry);
      } catch {
        // 集めるのが失敗していたら、次の読み出しがファイルから集め直す（書いた行は残っている）
      }
    }

    return entry;
  }

  async list(query: JournalQuery = {}): Promise<JournalEntry[]> {
    const order = query.order ?? 'desc';
    const found: JournalEntry[] = [];
    const dropped = new Map<string, number>();
    const limit = query.limit ?? Number.POSITIVE_INFINITY;
    // `limit: 0` は早期 return する: 下のループは push してから件数を判定するので、素通しすると1件返るため
    if (limit <= 0) return found;
    // `since` より古い日のファイルは開かない: 件数指定の無い `since` 問い合わせは常時走り、打ち切らないと日誌全部を毎回読むため
    const sinceDay = query.since?.slice(0, 10);
    const untilDay = query.until?.slice(0, 10);

    let anchor: { file: string; index: number } | null = null;
    let anchorDay: string | undefined;
    if (query.after !== undefined) {
      const after = query.after;
      anchor = await this.#locateAnchor(after, dropped);
      if (anchor === null) {
        noteDroppedJournalRowsSummary(dropped);
        throw new JournalAnchorNotFoundError(
          `after で指定された行（id=${after.id}, at=${after.at}）が見つからない`,
        );
      }
      anchorDay = after.at.slice(0, 10);
    }

    const files = await this.#files(order);
    const tombstoned = await this.#tombstoneSet();

    for (const file of files) {
      const fileDay = file.slice(0, 10);

      // 打ち切り（`break`）の向きを `order` で反転する: asc は古い日から走査するので、反転し忘れると窓の外を黙って落とすため
      if (order === 'desc') {
        if (sinceDay !== undefined && fileDay < sinceDay) break;
        if (untilDay !== undefined && fileDay > untilDay) continue;
      } else {
        if (untilDay !== undefined && fileDay > untilDay) break;
        if (sinceDay !== undefined && fileDay < sinceDay) continue;
      }

      if (anchor !== null && anchorDay !== undefined) {
        if (order === 'desc' && fileDay > anchorDay) continue;
        if (order === 'asc' && fileDay < anchorDay) continue;
      }

      const raw = await readFile(join(this.#dir, file), 'utf8');
      const lines = raw.split('\n').filter((line) => line.length > 0);

      const anchorIndexInThisFile = anchor !== null && file === anchor.file ? anchor.index : null;
      const startIndex =
        order === 'desc'
          ? anchorIndexInThisFile !== null
            ? anchorIndexInThisFile - 1
            : lines.length - 1
          : anchorIndexInThisFile !== null
            ? anchorIndexInThisFile + 1
            : 0;
      const step = order === 'desc' ? -1 : 1;

      for (let i = startIndex; order === 'desc' ? i >= 0 : i < lines.length; i += step) {
        const entry = parseLine(lines[i], dropped);
        if (!entry) continue;
        if (query.types && !query.types.includes(entry.type)) continue;
        // `limit` を数える前に外す（#4218）: 後で外すと窓が短くなり、`reachedStart` が誤るため
        if (isHiddenExchange(entry, tombstoned)) continue;
        if (query.with && (entry.type !== 'exchange' || !query.with.includes(entry.with))) continue;
        // 欄の選び方をここへ書き写さない: 照合は `journal-search.ts` が持ち、3実装が同じ答えを出すため
        if (query.q !== undefined && !matchesJournalSearch(entry, query.q)) continue;
        if (query.since && entry.at < query.since) continue;
        if (query.until && entry.at > query.until) continue;
        found.push(entry);
        if (found.length >= limit) {
          noteDroppedJournalRowsSummary(dropped);
          return found;
        }
      }
    }
    noteDroppedJournalRowsSummary(dropped);
    return found;
  }

  async listPage(query: JournalQuery = {}): Promise<JournalPage> {
    return listPageByOverfetch(this, query);
  }

  async get(id: string): Promise<JournalEntry | null> {
    const dropped = new Map<string, number>();
    const tombstoned = await this.#tombstoneSet();
    for (const file of await this.#files('desc')) {
      const raw = await readFile(join(this.#dir, file), 'utf8');
      const lines = raw.split('\n').filter((line) => line.length > 0);
      for (let i = lines.length - 1; i >= 0; i -= 1) {
        const entry = parseLine(lines[i], dropped);
        if (entry?.id === id) {
          noteDroppedJournalRowsSummary(dropped);
          return isHiddenExchange(entry, tombstoned) ? null : entry;
        }
        if (entry === null && rawRowId(lines[i]) === id) {
          noteDroppedJournalRowsSummary(dropped);
          throw new UnreadableJournalEntryError({ id });
        }
      }
    }
    noteDroppedJournalRowsSummary(dropped);
    return null;
  }

  async oldestAt(): Promise<string | null> {
    // 全件走査しない: ファイル名が追記時の UTC 日付なので、昇順の先頭から開いて最初に読めた行で止める
    const dropped = new Map<string, number>();
    for (const file of await this.#files('asc')) {
      const raw = await readFile(join(this.#dir, file), 'utf8');
      const lines = raw.split('\n').filter((line) => line.length > 0);
      for (const line of lines) {
        const entry = parseLine(line, dropped);
        if (entry) {
          noteDroppedJournalRowsSummary(dropped);
          return entry.at;
        }
      }
    }
    noteDroppedJournalRowsSummary(dropped);
    return null;
  }

  async clear(): Promise<number> {
    // `append()` と同じ `#chain` で直列化する: 消している最中に追記された日付ファイルを巻き込んで消さないため
    const run = this.#chain.then(async () => {
      const files = await this.#files('desc');
      let removed = 0;
      for (const file of files) {
        const raw = await readFile(join(this.#dir, file), 'utf8');
        removed += raw.split('\n').filter((line) => line.length > 0).length;
        await rm(join(this.#dir, file), { force: true });
      }
      return removed;
    });
    this.#chain = run.catch(() => undefined);
    const removed = await run;
    // 墓標も消えたので、集合も空へ戻す
    this.#tombstones = null;
    return removed;
  }

  #tombstoneSet(): Promise<Tombstones> {
    if (this.#tombstones === null) {
      const collecting = this.#collectTombstones();
      this.#tombstones = collecting;
      // 失敗を覚えない: 一時的な読み出しの失敗で、以降ずっと落ち続けないため
      collecting.catch(() => {
        if (this.#tombstones === collecting) this.#tombstones = null;
      });
    }
    return this.#tombstones;
  }

  async #collectTombstones(): Promise<Tombstones> {
    const found: Tombstones = { conversations: new Set(), entries: new Set() };
    for (const file of await this.#files('asc')) {
      const raw = await readFile(join(this.#dir, file), 'utf8');
      for (const line of raw.split('\n')) {
        if (line.length === 0) continue;
        // `parseLine` を使わない: 読めない行の跡（初出の1行）がここでも出て、`list` / `get` が読むときの跡と二重になるため
        let parsed: ReturnType<typeof journalEntrySchema.safeParse>;
        try {
          parsed = journalEntrySchema.safeParse(JSON.parse(line));
        } catch {
          continue;
        }
        if (parsed.success && parsed.data.type === 'conversation_deleted') {
          addTombstone(found, parsed.data);
        }
      }
    }
    return found;
  }

  #file(at: string): string {
    return join(this.#dir, `${at.slice(0, 10)}.jsonl`);
  }

  // `id` と `at` の両方が一致する行だけを錨と認める: `at` だけでは同一ミリ秒の同着を割れず、`id` だけではファイル名が `at` から決まる事実と揃わないため
  async #locateAnchor(
    after: {
      id: string;
      at: string;
    },
    dropped: Map<string, number>,
  ): Promise<{ file: string; index: number } | null> {
    const file = `${after.at.slice(0, 10)}.jsonl`;
    let raw: string;
    try {
      raw = await readFile(join(this.#dir, file), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    const lines = raw.split('\n').filter((line) => line.length > 0);
    for (let i = 0; i < lines.length; i += 1) {
      const entry = parseLine(lines[i], dropped);
      if (entry !== null && entry.id === after.id && entry.at === after.at) {
        return { file, index: i };
      }
    }
    return null;
  }

  async #files(order: 'asc' | 'desc'): Promise<string[]> {
    try {
      const names = await readdir(this.#dir);
      const sorted = names.filter((name) => name.endsWith('.jsonl')).sort();
      return order === 'desc' ? sorted.reverse() : sorted;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }
}

// 墓標の会話 id と、墓標が名指しした日誌の行の id（会話 id を持たない本文の写し。#4355）
interface Tombstones {
  conversations: Set<string>;
  entries: Set<string>;
}

function addTombstone(
  tombstones: Tombstones,
  entry: Extract<JournalEntry, { type: 'conversation_deleted' }>,
): void {
  tombstones.conversations.add(entry.deletedConversationId);
  for (const id of entry.hiddenEntryIds ?? []) tombstones.entries.add(id);
}

function isHiddenExchange(entry: JournalEntry, tombstoned: Tombstones): boolean {
  if (tombstoned.entries.has(entry.id)) return true;
  return (
    entry.type === 'exchange' &&
    entry.conversationId !== undefined &&
    tombstoned.conversations.has(entry.conversationId)
  );
}

function rawRowId(line: string | undefined): string | undefined {
  if (!line) return undefined;
  try {
    const raw: unknown = JSON.parse(line);
    if (typeof raw !== 'object' || raw === null) return undefined;
    const id = (raw as { id?: unknown }).id;
    return typeof id === 'string' ? id : undefined;
  } catch {
    return undefined;
  }
}

// 飛ばした行は `dropped` へ残す: 「読めなかった」と「そんな行は無い」を跡なしで混ぜないため
function parseLine(line: string | undefined, dropped: Map<string, number>): JournalEntry | null {
  if (!line) return null;
  const bytes = Buffer.byteLength(line, 'utf8');
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    noteDroppedJournalRow(dropped, 'unparsable', undefined, bytes);
    return null;
  }
  const parsed = journalEntrySchema.safeParse(raw);
  if (parsed.success) return parsed.data;
  noteDroppedJournalRow(dropped, 'unknown-shape', journalRowType(raw), bytes);
  return null;
}
