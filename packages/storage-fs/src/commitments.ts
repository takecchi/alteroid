import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  assertNoNul,
  commitmentClosedBySchema,
  commitmentSchema,
  compareIsoInstant,
  findOpenManagerDuplicate,
  stripNul,
  UnreadableCommitmentError,
  unreadableCommitmentSchema,
} from '@alteroid/core';
import type {
  Commitment,
  CommitmentClosedBy,
  CommitmentEditedBy,
  CommitmentList,
  CommitmentOpenResult,
  CommitmentStore,
  UnreadableCommitment,
} from '@alteroid/core';
import { z } from 'zod';

import { writeFileAtomic } from './atomic.js';
import { withPathLock } from './file-lock.js';

// 読めない行の生の値は書き換えず、別欄に「閉じた」印を持つ: 本体が読めず、`closedAt` をどこへどう足せばよいか決めようがないため
const closedUnreadableRowSchema = z.object({
  id: z.string(),
  at: z.string(),
  reason: z.string(),
  by: commitmentClosedBySchema,
});

const rawFileSchema = z.object({
  commitments: z.array(z.unknown()).default([]),
  trimmedClosedCount: z.number().int().nonnegative().default(0),
  closedUnreadable: z.array(closedUnreadableRowSchema).default([]),
});

type UnreadableRow = {
  // 生の値を保持する: 書き戻しのたびに、読めなかった行が気づかれないままディスクから永久に消えるため
  value: unknown;
  id?: string;
  at?: string;
  reason: string;
  closed?: { at: string; reason: string; by: CommitmentClosedBy };
};

type CommitmentFile = {
  entries: Commitment[];
  unreadable: UnreadableRow[];
  trimmedClosedCount: number;
};

// `list()` の返り値は必ずこれを経由する: `file.unreadable` をそのまま返すと、行の本体（`value`）に実行時にアクセスできる状態で外へ渡るため
function toPublicUnreadable(row: UnreadableRow): UnreadableCommitment {
  return { id: row.id, at: row.at, reason: row.reason };
}

// `id` / `at` 以外を覗かない: 抽出を広げて `body` まで拾うと、「本文を載せない」制約が抽出のほうから破れるため
function stringFieldOf(value: unknown, key: 'id' | 'at'): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === 'string' ? field : undefined;
}

function splitFileRows(rows: unknown[]): Omit<CommitmentFile, 'trimmedClosedCount'> {
  const entries: Commitment[] = [];
  const unreadable: UnreadableRow[] = [];
  for (const value of rows) {
    const parsed = commitmentSchema.safeParse(value);
    if (parsed.success) {
      entries.push(parsed.data);
      continue;
    }
    const id = stringFieldOf(value, 'id');
    const atCandidate = stringFieldOf(value, 'at');
    // `at` の判定は公開スキーマ（`unreadableCommitmentSchema`）から借りる: 規則を二重定義すると、片方だけ直して食い違うため
    const at =
      atCandidate !== undefined &&
      unreadableCommitmentSchema.shape.at.safeParse(atCandidate).success
        ? atCandidate
        : undefined;
    unreadable.push({ value, id, at, reason: parsed.error.message });
  }
  return { entries, unreadable };
}

// 読めなかった行の生の値（`unreadable[].value`）を必ず含める: `entries` だけにすると、書き戻しのたびに読めない行が消えるため
// `trimmedClosedCount` も書き戻す: 落とすと次回の起動で0へ戻り、それまでの削除が無かったことになるため
function toDiskShape(file: CommitmentFile): {
  commitments: unknown[];
  trimmedClosedCount: number;
  closedUnreadable: { id: string; at: string; reason: string; by: CommitmentClosedBy }[];
} {
  return {
    commitments: [...file.entries, ...file.unreadable.map((row) => row.value)],
    trimmedClosedCount: file.trimmedClosedCount,
    closedUnreadable: file.unreadable.flatMap((row) =>
      row.closed !== undefined && row.id !== undefined
        ? [{ id: row.id, at: row.closed.at, reason: row.closed.reason, by: row.closed.by }]
        : [],
    ),
  };
}

// 上限は片付いた行だけに掛ける: 未了を切るとこの器の目的（忘れさせないこと）が消えるため
// 上限が要る: 毎回ファイル全体を書き直す器なので、片付いた行を積み続けると open の費用が台帳の齢に比例して増えるため
export const CLOSED_HISTORY_LIMIT = 500;

export class FsCommitmentStore implements CommitmentStore {
  readonly #dir: string;
  readonly #path: string;

  constructor(dir: string) {
    this.#dir = dir;
    this.#path = join(dir, 'commitments.json');
  }

  async list(options?: { includeClosed?: boolean }): Promise<CommitmentList> {
    const file = await this.#read();
    // 未了は古い順にする: 齢が判断の材料なので、放置されているものから見せるため
    const open = file.entries
      .filter((entry) => entry.closedAt === undefined)
      // 実時刻で比べる: 文字列比較だとオフセット表記の違う行で、pg の `asc(at)` と並びが食い違うため
      .sort((a, b) => compareIsoInstant(a.at, b.at));
    // 閉じていない読めない行は `includeClosed` に関わらず常に返す: `closedAt` が読めず、片付いたとみなす根拠が無いため
    // `closed` は公開しない: pg 版も `unreadable` へ `closedAt` を出さず、fs だけ情報が増えるため
    const unreadableUnclosed = file.unreadable
      .filter((row) => row.closed === undefined)
      .map(toPublicUnreadable);
    if (options?.includeClosed !== true) {
      return {
        entries: open,
        unreadable: unreadableUnclosed,
        trimmedClosed: file.trimmedClosedCount,
      };
    }
    const closed = file.entries
      .filter((entry) => entry.closedAt !== undefined)
      .sort((a, b) => compareIsoInstant(b.closedAt ?? '', a.closedAt ?? ''));
    const unreadableClosed = file.unreadable
      .filter((row) => row.closed !== undefined)
      .map(toPublicUnreadable);
    return {
      entries: [...open, ...closed],
      unreadable: [...unreadableUnclosed, ...unreadableClosed],
      trimmedClosed: file.trimmedClosedCount,
    };
  }

  async get(id: string): Promise<Commitment | null> {
    const file = await this.#read();
    const found = file.entries.find((entry) => entry.id === id);
    if (found !== undefined) return found;
    const broken = file.unreadable.find((row) => row.id === id);
    if (broken !== undefined) {
      // `null` にせず `UnreadableCommitmentError` を投げる: 「無い」と「読めない」の区別が消えず、呼び出し側が `instanceof` で器の障害と見分けられるため
      throw new UnreadableCommitmentError(
        `引き受けた仕事 ${id} が読めない形で入っている（片付いたのではない）: ${broken.reason}`,
      );
    }
    return null;
  }

  async open(rawEntry: Commitment): Promise<CommitmentOpenResult> {
    assertNoNul('commitment.id', rawEntry.id);
    const entry = {
      ...rawEntry,
      body: stripNul(rawEntry.body),
      ...(rawEntry.source === undefined ? {} : { source: stripNul(rawEntry.source) }),
    };
    // 読みと書きを同じ排他区間に入れる: 分けると同じ id の並行 open が両方「無い」を読み、後から書いた側が先の行を上書きして、片付けた仕事が配り直しのたびに開き直るため
    return this.#update<CommitmentOpenResult>((file) => {
      // 読めない行の id も見る: 同じ id が2行（壊れた生の値＋新しい行）並ぶと、どちらが本物か判定できなくなるため
      const known =
        file.entries.some((existing) => existing.id === entry.id) ||
        file.unreadable.some((row) => row.id === entry.id);
      if (known) return { next: file, result: { opened: false, folded: false } };
      // 判定を `#update` の閉包の中に置く: 外で `list()` してから `open()` を呼ぶと、読みと書きが別の排他区間になるため
      const duplicate = findOpenManagerDuplicate(file.entries, entry);
      if (duplicate !== undefined)
        return {
          next: file,
          result: { opened: false, folded: true, foldedInto: duplicate.id },
        };
      return {
        next: trimClosed({
          entries: [...file.entries, commitmentSchema.parse(entry)],
          unreadable: file.unreadable,
          trimmedClosedCount: file.trimmedClosedCount,
        }),
        result: { opened: true, folded: false },
      };
    });
  }

  async close(id: string, at: string, rawReason: string, by: CommitmentClosedBy): Promise<boolean> {
    const reason = stripNul(rawReason);
    // 読む→既に閉じていないか見る→書く、を同じ排他区間で行う: 分けると、二重に届いた片付けが両方 `true` を返し、二重に報告されるため
    return this.#update((file) => {
      const found = file.entries.find((entry) => entry.id === id);
      if (found !== undefined) {
        if (found.closedAt !== undefined) return { next: file, result: false };
        return {
          next: trimClosed({
            entries: file.entries.map((entry) =>
              entry.id === id
                ? { ...entry, closedAt: at, closedReason: reason, closedBy: by }
                : entry,
            ),
            unreadable: file.unreadable,
            trimmedClosedCount: file.trimmedClosedCount,
          }),
          result: true,
        };
      }
      const broken = file.unreadable.find((row) => row.id === id);
      if (broken === undefined) return { next: file, result: false };
      if (broken.closed !== undefined) return { next: file, result: false };
      return {
        next: {
          entries: file.entries,
          unreadable: file.unreadable.map((row) =>
            row === broken ? { ...row, closed: { at, reason, by } } : row,
          ),
          trimmedClosedCount: file.trimmedClosedCount,
        },
        result: true,
      };
    });
  }

  async closeMany(
    ids: readonly string[],
    at: string,
    rawReason: string,
    by: CommitmentClosedBy,
  ): Promise<string[]> {
    const reason = stripNul(rawReason);
    // `ids` が空なら `#update` を呼ばない: ファイルの中身が1バイトも変わらないため
    if (ids.length === 0) return [];
    const targets = new Set(ids);
    // `close()` を件数分呼ばず排他区間1回で処理する: 台帳全体を件数分書き直すことになるため
    return this.#update((file) => {
      const closedIds: string[] = [];
      const entries = file.entries.map((entry) => {
        if (!targets.has(entry.id) || entry.closedAt !== undefined) return entry;
        closedIds.push(entry.id);
        return { ...entry, closedAt: at, closedReason: reason, closedBy: by };
      });
      // 読めない行も閉じる: pg は `closed_at` 列を行の形と独立に進めるので、3実装で答えを揃えるため
      const unreadable = file.unreadable.map((row) => {
        if (row.id === undefined || !targets.has(row.id) || row.closed !== undefined) return row;
        if (!closedIds.includes(row.id)) closedIds.push(row.id);
        return { ...row, closed: { at, reason, by } };
      });
      return {
        next: trimClosed({
          entries,
          unreadable,
          trimmedClosedCount: file.trimmedClosedCount,
        }),
        result: closedIds,
      };
    });
  }

  async editBody(
    id: string,
    rawBody: string,
    at: string,
    by: CommitmentEditedBy,
  ): Promise<boolean> {
    const body = stripNul(rawBody);
    // `#update` の排他区間で行う: 読んでから書く形にすると、並行編集や片付けとの競合で後勝ちが先の書き込みを黙って踏み消すため
    return this.#update((file) => {
      const found = file.entries.find((entry) => entry.id === id);
      if (found === undefined || found.closedAt !== undefined) {
        return { next: file, result: false };
      }
      return {
        next: {
          entries: file.entries.map((entry) =>
            entry.id === id ? { ...entry, body, editedAt: at, editedBy: by } : entry,
          ),
          unreadable: file.unreadable,
          trimmedClosedCount: file.trimmedClosedCount,
        },
        result: true,
      };
    });
  }

  async clear(): Promise<number> {
    return this.#update((file) => ({
      next: { entries: [], unreadable: [], trimmedClosedCount: 0 },
      result: file.entries.length + file.unreadable.length,
    }));
  }

  async #read(): Promise<CommitmentFile> {
    try {
      const raw = await readFile(this.#path, 'utf8');
      const parsed = rawFileSchema.parse(JSON.parse(raw));
      const { entries, unreadable } = splitFileRows(parsed.commitments);
      // 読むたびに `closedUnreadable` を `unreadable` の行へ合流させる: 印は生の値（`commitments`）側に書かれていないため
      const closedById = new Map(parsed.closedUnreadable.map((row) => [row.id, row]));
      return {
        entries,
        unreadable: unreadable.map((row) => {
          if (row.id === undefined) return row;
          const closedRow = closedById.get(row.id);
          if (closedRow === undefined) return row;
          return {
            ...row,
            closed: { at: closedRow.at, reason: closedRow.reason, by: closedRow.by },
          };
        }),
        trimmedClosedCount: parsed.trimmedClosedCount,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        return { entries: [], unreadable: [], trimmedClosedCount: 0 };
      throw error;
    }
  }

  async #update<T>(
    mutate: (file: CommitmentFile) => { next: CommitmentFile; result: T },
  ): Promise<T> {
    return withPathLock(this.#path, async () => {
      const { next, result } = mutate(await this.#read());
      await mkdir(this.#dir, { recursive: true });
      // 書き出しは `toDiskShape` を必ず経由する: `next` をそのまま `JSON.stringify` すると、読めない行の生の値が次回の起動で永久に読み込み対象から外れるため
      await writeFileAtomic(this.#path, `${JSON.stringify(toDiskShape(next), null, 2)}\n`);
      return result;
    });
  }
}

// 未了の行と読めない行は切らない: 古い未了から捨てるのは忘れさせない目的の否定で、読めない行は `closedAt` が読めず片付いたとみなす根拠が無いため
// 切った件数は `trimmedClosedCount` へ足す: `close` の契約（行は消さない）を破る唯一の場所で、後から件数を逆算する材料が残らないため
function trimClosed(file: CommitmentFile): CommitmentFile {
  const closed = file.entries.filter((entry) => entry.closedAt !== undefined);
  if (closed.length <= CLOSED_HISTORY_LIMIT) return file;

  const kept = new Set(
    [...closed]
      .sort((a, b) => compareIsoInstant(b.closedAt ?? '', a.closedAt ?? ''))
      .slice(0, CLOSED_HISTORY_LIMIT)
      .map((entry) => entry.id),
  );
  const removed = closed.length - kept.size;
  return {
    entries: file.entries.filter((entry) => entry.closedAt === undefined || kept.has(entry.id)),
    unreadable: file.unreadable,
    trimmedClosedCount: file.trimmedClosedCount + removed,
  };
}
