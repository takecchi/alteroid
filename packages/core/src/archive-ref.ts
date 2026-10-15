import { randomUUID } from 'node:crypto';

/**
 * 生ログの退避（`archive` の出来事）の本文を、SSE の1行で運ばずに runner に預け、デーモンが HTTP で取りに行く（#4485）。
 *
 * 2026-10-12T03:20Z、担当が一斉に畳まれたとき、6〜35MB の `archive` の出来事が SSE の1行で届き、デーモンのループが
 * 1.2〜1.4 秒ずつ6回塞がり、ヒープが 1.2GB まで膨らんだ（クローン teto の観測）。
 *
 * デーモンは SSE（`GET /events`）を開くときに {@link ARCHIVE_REF_ACCEPT_HEADER} で {@link ARCHIVE_REF_ACCEPT_TOKEN} を名乗る。
 * runner は、いま繋がっているデーモンが名乗っていれば本文を預けて参照だけを送り、名乗っていなければこれまでどおり本文を載せる
 * （版のずれた組でも、退避を黙って落とさない）。
 */

export const ARCHIVE_REF_ACCEPT_HEADER = 'x-alteroid-accepts';
export const ARCHIVE_REF_ACCEPT_TOKEN = 'archive-ref';

/** ヘッダの値（カンマ区切りの名前の並び）が `archive-ref` を含むか。 */
export function acceptsArchiveRef(headerValue: string | undefined | null): boolean {
  if (headerValue === undefined || headerValue === null) return false;
  return headerValue
    .split(',')
    .map((token) => token.trim())
    .includes(ARCHIVE_REF_ACCEPT_TOKEN);
}

const ARCHIVE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** 預けた本文の id の形（`randomUUID()`）。パスの部品になるので、形を先に検める。 */
export function isArchiveRefId(id: string): boolean {
  return ARCHIVE_ID_PATTERN.test(id);
}

/** 取りに来ないまま残った本文を捨てるまでの時間。デーモンが居ない間（器の入れ替え・再起動）も、この間は待つ。 */
export const ARCHIVE_STASH_TTL_MS = 60 * 60_000;
/** 預かる本数と文字数の上限。超えたら古いものから捨てる（runner のメモリを退避で食い尽くさないため）。 */
export const ARCHIVE_STASH_MAX_ENTRIES = 32;
export const ARCHIVE_STASH_MAX_CHARS = 256 * 1024 * 1024;

interface StashedArchive {
  readonly managerId: string;
  readonly body: string;
  readonly at: number;
  /** デーモンが本文を全部取り終えた（GET の応答を返し終えた）。DELETE が落ちても、畳みの待ちと送り直しの対象にしない（#4899）。 */
  fetched: boolean;
}

export interface ArchiveStashDrop {
  readonly managerId: string;
  readonly archiveId: string;
  readonly chars: number;
  readonly reason: 'expired' | 'over-capacity';
}

/**
 * runner が預かる退避の本文。読み出しは消さない（デーモンが置き場へ入れた後に `delete` を呼ぶ）。
 * 捨てた分は `onDrop` で知らせる: 黙って消すと、退避が取れなかった理由が残らないため。
 */
export class ArchiveStash {
  readonly #entries = new Map<string, StashedArchive>();
  #chars = 0;
  readonly #now: () => number;
  readonly #onDrop: (drop: ArchiveStashDrop) => void;
  readonly #ttlMs: number;
  readonly #maxEntries: number;
  readonly #maxChars: number;

  constructor(
    options: {
      now?: () => number;
      onDrop?: (drop: ArchiveStashDrop) => void;
      ttlMs?: number;
      maxEntries?: number;
      maxChars?: number;
    } = {},
  ) {
    this.#now = options.now ?? Date.now;
    this.#onDrop = options.onDrop ?? (() => undefined);
    this.#ttlMs = options.ttlMs ?? ARCHIVE_STASH_TTL_MS;
    this.#maxEntries = options.maxEntries ?? ARCHIVE_STASH_MAX_ENTRIES;
    this.#maxChars = options.maxChars ?? ARCHIVE_STASH_MAX_CHARS;
  }

  put(managerId: string, body: string): { id: string; chars: number } {
    this.#expire();
    const id = randomUUID();
    this.#entries.set(id, { managerId, body, at: this.#now(), fetched: false });
    this.#chars += body.length;
    // 入れたばかりの1本は捨てない: 1本で上限を超える本文でも、デーモンが取りに来るまでは持つ
    while (
      this.#entries.size > 1 &&
      (this.#entries.size > this.#maxEntries || this.#chars > this.#maxChars)
    ) {
      const oldest = this.#entries.keys().next().value;
      if (oldest === undefined || oldest === id) break;
      this.#drop(oldest, 'over-capacity');
    }
    return { id, chars: body.length };
  }

  /** 本文。無い・別の委譲の id なら `undefined`。 */
  get(managerId: string, id: string): string | undefined {
    this.#expire();
    const entry = this.#entries.get(id);
    return entry === undefined || entry.managerId !== managerId ? undefined : entry.body;
  }

  /** デーモンが本文を取り終えた印を付ける。消しはしない（TTL が消す）。無い・別の委譲の id なら何もしない。 */
  markFetched(managerId: string, id: string): void {
    const entry = this.#entries.get(id);
    if (entry === undefined || entry.managerId !== managerId) return;
    entry.fetched = true;
  }

  /** 冪等。別の委譲の id は消さない。 */
  delete(managerId: string, id: string): void {
    const entry = this.#entries.get(id);
    if (entry === undefined || entry.managerId !== managerId) return;
    this.#entries.delete(id);
    this.#chars -= entry.body.length;
  }

  get size(): number {
    return this.#entries.size;
  }

  /** いま預かっている退避（本文は含めない）。畳み始めに、まだ取られていない分を数えるのに使う（#4896）。 */
  list(): { managerId: string; id: string; chars: number; fetched: boolean }[] {
    this.#expire();
    return [...this.#entries].map(([id, entry]) => ({
      managerId: entry.managerId,
      id,
      chars: entry.body.length,
      fetched: entry.fetched,
    }));
  }

  #expire(): void {
    const now = this.#now();
    for (const [id, entry] of this.#entries) {
      if (now - entry.at < this.#ttlMs) break;
      this.#drop(id, 'expired');
    }
  }

  #drop(id: string, reason: ArchiveStashDrop['reason']): void {
    const entry = this.#entries.get(id);
    if (entry === undefined) return;
    this.#entries.delete(id);
    this.#chars -= entry.body.length;
    this.#onDrop({ managerId: entry.managerId, archiveId: id, chars: entry.body.length, reason });
  }
}
