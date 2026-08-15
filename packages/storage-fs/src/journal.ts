import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { journalEntrySchema } from '@alteroid/core';
import type { JournalEntry, JournalEntryInput, JournalQuery, JournalStore } from '@alteroid/core';

/**
 * 日誌 = 追記専用 JSONL（日付ごとに1ファイル）。
 *
 * 「聞かずに実行した判断は必ず日誌に残る」（PRD「権限境界」）のが、人間の
 * 事後否定＝最終承認の実体である。したがって追記だけを提供し、書き換えの口は
 * 用意しない。
 */
export class FsJournalStore implements JournalStore {
  readonly #dir: string;
  #chain: Promise<unknown> = Promise.resolve();

  constructor(dir: string) {
    this.#dir = dir;
  }

  async append(input: JournalEntryInput): Promise<JournalEntry> {
    const entry = journalEntrySchema.parse({
      ...input,
      id: randomUUID(),
      at: new Date().toISOString(),
    });

    // 同時追記で行が混ざらないよう直列化する
    const run = this.#chain.then(async () => {
      await mkdir(this.#dir, { recursive: true });
      await appendFile(this.#file(entry.at), `${JSON.stringify(entry)}\n`, 'utf8');
    });
    this.#chain = run.catch(() => undefined);
    await run;

    return entry;
  }

  async list(query: JournalQuery = {}): Promise<JournalEntry[]> {
    const files = await this.#files();
    const found: JournalEntry[] = [];
    const limit = query.limit ?? Number.POSITIVE_INFINITY;
    // ファイル名は追記時の UTC 日付なので、`since` より古い日のファイルは開かなくてよい。
    // 件数指定の無い `since` 問い合わせ（日報・要約）は M3 から常時走るため、
    // ここで打ち切らないと日誌全部を毎回読むことになる。
    const sinceDay = query.since?.slice(0, 10);
    // `until` より新しい日のファイルは開かなくてよい。**`break` ではなく `continue`**
    // — 走査は新しい日から始まるので、ここで止めると窓そのものへ辿り着けない。
    const untilDay = query.until?.slice(0, 10);

    // 新しい日付のファイルから読み、必要な件数が揃ったら止める
    for (const file of files) {
      if (sinceDay !== undefined && file.slice(0, 10) < sinceDay) break;
      if (untilDay !== undefined && file.slice(0, 10) > untilDay) continue;
      const raw = await readFile(join(this.#dir, file), 'utf8');
      const lines = raw.split('\n').filter((line) => line.length > 0);
      for (let i = lines.length - 1; i >= 0; i -= 1) {
        const entry = parseLine(lines[i]);
        if (!entry) continue;
        if (query.types && !query.types.includes(entry.type)) continue;
        if (query.since && entry.at < query.since) continue;
        if (query.until && entry.at > query.until) continue;
        found.push(entry);
        if (found.length >= limit) return found;
      }
    }
    return found;
  }

  /**
   * id で1件引く。
   *
   * 日付を持たない id なので、新しい日から順に開いて突き合わせる。掘るための
   * 一発引きであって定常経路ではないため、走査の重さは受け入れる（当たれば
   * その時点で止まる）。
   */
  async get(id: string): Promise<JournalEntry | null> {
    for (const file of await this.#files()) {
      const raw = await readFile(join(this.#dir, file), 'utf8');
      const lines = raw.split('\n').filter((line) => line.length > 0);
      for (let i = lines.length - 1; i >= 0; i -= 1) {
        const entry = parseLine(lines[i]);
        if (entry?.id === id) return entry;
      }
    }
    return null;
  }

  #file(at: string): string {
    return join(this.#dir, `${at.slice(0, 10)}.jsonl`);
  }

  /** 新しい日付が先。 */
  async #files(): Promise<string[]> {
    try {
      const names = await readdir(this.#dir);
      return names
        .filter((name) => name.endsWith('.jsonl'))
        .sort()
        .reverse();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }
}

function parseLine(line: string | undefined): JournalEntry | null {
  if (!line) return null;
  try {
    const parsed = journalEntrySchema.safeParse(JSON.parse(line));
    return parsed.success ? parsed.data : null;
  } catch {
    // 壊れた行があっても日誌全体を読めなくしない（追記専用ゆえ先頭は健全なはず）
    return null;
  }
}
