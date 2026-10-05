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
  /** `post` が受理した時刻（ISO 8601）。 */
  at: z.string(),
  deliveries: z.number().int().nonnegative(),
});

/**
 * トップレベルの形だけを見る。**行（`events` の要素）は `#read()` が1行ずつ
 * `inboxEntrySchema.safeParse` で検査する**（issue #1966）。以前はここで
 * `z.array(inboxEntrySchema)` を1回に検査していたので、1行の不正で受信箱の
 * 読み書きが丸ごと例外になっていた（jobs の #1868 / approvals の #1928 /
 * permission-grants の #1941 と同じ形の穴）。
 */
const fileSchema = z.object({
  events: z.array(z.unknown()).default([]),
});

type InboxEntry = z.infer<typeof inboxEntrySchema>;

interface InboxFile {
  events: InboxEntry[];
  /** 行の形が不正で読めなかった、生の要素（パース前のまま）。書き戻しで残す。 */
  invalidEventsRaw: unknown[];
}

const EMPTY: InboxFile = { events: [], invalidEventsRaw: [] };

/** 生の行から、値を出さずに合図の id だけを安全に取り出す（取れなければ `undefined`）。 */
function extractEventId(raw: unknown): string | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const event = (raw as Record<string, unknown>).event;
  if (typeof event !== 'object' || event === null) return undefined;
  const id = (event as Record<string, unknown>).id;
  return typeof id === 'string' ? id : undefined;
}

/** 生の行から、受信時刻（`at`）を安全に取り出す（文字列でなければ `undefined`）。 */
function extractEntryAt(raw: unknown): string | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const at = (raw as Record<string, unknown>).at;
  return typeof at === 'string' ? at : undefined;
}

/**
 * 不正な欄の名前だけを `,` でつなぐ（値は出さない。zod のメッセージは受け取った値を含みうる）。
 * 欄が取れなければ「不正な行」。
 */
function summarizeInvalidFields(paths: readonly (readonly PropertyKey[])[]): string {
  const fields = [
    ...new Set(paths.map((path) => (path.length > 0 ? path.map(String).join('.') : '(root)'))),
  ];
  return fields.length > 0 ? `不正な欄: ${fields.join(',')}` : '不正な行';
}

/**
 * 読み飛ばした行の跡（stderr へ1行）。**id と不正な欄の名前だけで、本文は出さない**
 * （`jobs.ts` の `describeSkippedJobRow` と同じ作法）。
 */
function describeSkippedInboxRow(params: {
  index: number;
  fields: readonly string[];
  id?: string;
}): string {
  const idNote = params.id === undefined ? '' : ` id=${JSON.stringify(params.id)}`;
  const reason = params.fields.length > 0 ? `不正な欄: ${params.fields.join(',')}` : '不正な行';
  return `alteroid: 受信箱の不正な行を読み飛ばしました（${params.index + 1} 行目、${reason}）${idNote}`;
}

/**
 * まだ処理し終えていない受信箱の合図 = 1枚の JSON（`store.ts` の `InboxStore`）。
 *
 * ジョブ台帳・継続中の依頼（`FsScheduleStore`）と同じディレクトリに置き、同じ作法
 * （`withPathLock` による直列化、`writeFileAtomic` による原子的な書き込み）を
 * 踏襲する。
 */
export class FsInboxStore implements InboxStore {
  readonly #dir: string;
  readonly #path: string;

  constructor(dir: string) {
    this.#dir = dir;
    this.#path = join(dir, 'inbox.json');
  }

  async put(event: InboxEvent, at: string): Promise<void> {
    const value = inboxEventSchema.parse(event);
    // 外側の `at` は pg（`timestamptz`）と同じ `Z` 付きの ISO 表記に正規化して保存する
    // （issue #2927 項目2）。読めない時刻は `RangeError` で拒む（pg の `new Date(at)` も同じ）。
    // 既に `+09:00` のまま書かれた行は書き換えない——読み側は `compareIsoInstant` /
    // `earliestIsoInstant` で実時刻を比べるので、表記の違う行と同居できる。
    const normalizedAt = new Date(at).toISOString();
    await this.#update((file) => {
      // 同じ id があれば配達回数を引き継ぐ（無ければ初回＝0）。
      const existing = file.events.find((entry) => entry.event.id === value.id);
      return {
        next: {
          events: [
            ...file.events.filter((entry) => entry.event.id !== value.id),
            { event: value, at: normalizedAt, deliveries: existing?.deliveries ?? 0 },
          ],
          // **書き込む id と一致する壊れた行は置き換える**（issue #1966。
          // `FsJobStore.putJob` / `FsPermissionGrantStore.put` と同じ）。
          invalidEventsRaw: file.invalidEventsRaw.filter((raw) => extractEventId(raw) !== value.id),
        },
        result: undefined,
      };
    });
  }

  async remove(id: string): Promise<void> {
    await this.#update((file) => ({
      next: { ...file, events: file.events.filter((entry) => entry.event.id !== id) },
      result: undefined,
    }));
  }

  /**
   * 残っている未読を古い順に返し、**同時に配達回数を1つ進める**。
   *
   * `ScheduleStore.claimRun` と同じ作法で、読みと書きを `#update` の1区間へ閉じる
   * （`withPathLock` による排他がそのまま効く）。返す `deliveries` は進めた後の値。
   */
  async claimPending(): Promise<PendingInboxEvent[]> {
    return this.#update((file) => {
      // 実時刻で比べる（issue #2451。pg は `at`〈timestamptz〉の `getTime()` で並べる）
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

  /**
   * 残っている未読の件数と、いちばん古いものが積まれた時刻（#358）。
   * **`claimPending` と違い、読むだけで書かない** — `#update` を通さない
   * ので `deliveries` は1つも進まない。
   */
  async pending(): Promise<{ count: number; oldestAt?: string }> {
    const file = await this.#read();
    // 実時刻でいちばん古いもの（issue #2451。pg の `min(at)` と揃える）
    const oldest = earliestIsoInstant(file.events.map((entry) => entry.at));
    return {
      // **壊れた行も件数に数える**（issue #1966）。pg の `count(*)` と同じく、
      // 受信箱に残っている行の数である。`oldestAt` は時刻を読める正しい行だけから取る。
      count: file.events.length + file.invalidEventsRaw.length,
      ...(oldest === undefined ? {} : { oldestAt: oldest }),
    };
  }

  /**
   * 残っている未読を古い順に返す。**`claimPending` と違い、`#update` を
   * 通さない — 1文字も書かない**（`InboxStore.peekPending` の doc）。
   */
  async peekPending(): Promise<InboxPeek> {
    const file = await this.#read();
    return {
      entries: [...file.events]
        .sort((a, b) => compareIsoInstant(a.at, b.at))
        .map((entry) => ({ event: entry.event, at: entry.at, deliveries: entry.deliveries })),
      // **読めない行も返す**（issue #2344。以前は黙って飛ばしていた）。`pending().count` は
      // 壊れた行も数えるので、`entries.length + unreadable.length` はそれに一致する。
      // id・受信時刻（取れれば）と不正な欄名だけで、本文は載せない。
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

  /**
   * 絞り込みで選んだ複数件をまとめて消す（`InboxStore.removeMany` の doc、
   * issue #972）。
   *
   * `FsCommitmentStore.closeMany` と同じ筋——`#update` の排他区間を1回だけ
   * 使い、対象の行を全部その中で処理する。`remove()` を `ids` の件数だけ
   * 呼ぶ形（＝ `#update` を件数分呼ぶ形）にしないのがこのメソッドの存在
   * 理由そのもの（`InboxStore.removeMany` の doc）。
   *
   * `ids` を `Set` にしてから見るので、重複があっても対象の判定は変わらない
   * ——同じ行が複数回消えることも、戻り値に同じ id が複数回入ることも無い。
   *
   * `ids` が空なら `#update` を呼ばずに `[]` を返す（`FsCommitmentStore
   * .closeMany` と同じ理由——ファイルの中身が1バイトも変わらない）。
   */
  async removeMany(ids: readonly string[]): Promise<string[]> {
    if (ids.length === 0) return [];
    const targets = new Set(ids);
    return this.#update((file) => {
      const removedIds: string[] = [];
      const events = file.events.filter((entry) => {
        if (!targets.has(entry.event.id)) return true;
        removedIds.push(entry.event.id);
        return false;
      });
      return { next: { ...file, events }, result: removedIds };
    });
  }

  /**
   * 全件を消す（`InboxStore.clear` の doc）。**壊れた行も消し、件数に数える**
   * （issue #1966。pg の `DELETE … RETURNING` と同じ。#1892 の jobs と同じ線）。
   */
  async clear(): Promise<number> {
    return this.#update((file) => ({
      next: EMPTY,
      result: file.events.length + file.invalidEventsRaw.length,
    }));
  }

  /**
   * `inbox.json` を読む。**`events` は行ごとに検査し、不正な1行だけを飛ばす**
   * （issue #1966）。飛ばした行は stderr へ1行の跡を残し、`invalidEventsRaw` として
   * 生の形のまま持ち回る——書き戻し（`#update`）で消さない。ファイルそのものが
   * JSON として読めない・トップレベルの形が違うときは、今までどおり例外にする
   * （1行の問題ではないため。`jobs.ts` と同じ線）。
   */
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

  /**
   * read-modify-write を直列化する（`FsScheduleStore#update` と同じ `withPathLock`
   * ベースの排他。issue #1113 / #1050）。
   *
   * `mutate` は書き込む内容と、呼び出し側へ返す値の両方を決める。**読んだ結果に
   * 基づいて書くかどうか・何を進めるかを決める操作**（`claimPending`）を、この
   * 区間の外へ出さないこと。
   */
  async #update<T>(mutate: (file: InboxFile) => { next: InboxFile; result: T }): Promise<T> {
    return withPathLock(this.#path, async () => {
      const { next, result } = mutate(await this.#read());
      await mkdir(this.#dir, { recursive: true });
      // 検査を通った行と、壊れた行（生の形のまま）を合わせて書き戻す（issue #1966）。
      const onDisk = { events: [...next.events, ...next.invalidEventsRaw] };
      await writeFileAtomic(this.#path, `${JSON.stringify(onDisk, null, 2)}\n`);
      return result;
    });
  }
}
