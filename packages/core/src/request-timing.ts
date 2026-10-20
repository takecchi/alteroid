import { AsyncLocalStorage } from 'node:async_hooks';

// HTTP の1要求の中で打った DB の問い合わせを数える器（#5089）。
// 器の持ち主はデーモンの HTTP の口で、足し込むのは storage-pg のプール。core に置く: 両方が依存できる場所がここだけのため

const SQL_HEAD_CHARS = 120;

export interface RequestDbTiming {
  /** 問い合わせの本数 */
  count: number;
  /** 問い合わせごとの時間の和（並行して打てば合計の時間を超えうる） */
  totalMs: number;
  /** 1本以上の問い合わせが走っていた時間（重なりを1回に数える） */
  wallMs: number;
  /** プールの空きを待った時間の和 */
  waitMs: number;
  /** 最も長かった1本 */
  slowestMs: number;
  /** その1本の SQL の頭（値はバインドされた引数なので載らない） */
  slowestSql?: string;
}

export class RequestTiming {
  readonly db: RequestDbTiming = { count: 0, totalMs: 0, wallMs: 0, waitMs: 0, slowestMs: 0 };
  readonly #now: () => number;
  #active = 0;
  #activeSince = 0;

  constructor(now: () => number = () => performance.now()) {
    this.#now = now;
  }

  /** 問い合わせを打つ直前に呼び、返った関数を答えが届いたら（失敗でも）呼ぶ */
  queryStarted(sql?: string): () => void {
    const started = this.#now();
    if (this.#active === 0) this.#activeSince = started;
    this.#active += 1;
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      const now = this.#now();
      const took = now - started;
      this.db.count += 1;
      this.db.totalMs += took;
      if (took >= this.db.slowestMs) {
        this.db.slowestMs = took;
        const head = sqlHead(sql);
        if (head === undefined) delete this.db.slowestSql;
        else this.db.slowestSql = head;
      }
      this.#active -= 1;
      if (this.#active === 0) this.db.wallMs += now - this.#activeSince;
    };
  }

  /** プールの空きを待った時間を足す */
  waited(ms: number): void {
    if (ms > 0) this.db.waitMs += ms;
  }

  /** 走っている問い合わせがあれば、そこまでを wall に入れた写しを返す（SSE のように問い合わせの途中で数え終える口のため） */
  snapshot(): RequestDbTiming {
    const db = { ...this.db };
    if (this.#active > 0) db.wallMs += this.#now() - this.#activeSince;
    return db;
  }
}

function sqlHead(sql: string | undefined): string | undefined {
  if (sql === undefined) return undefined;
  const flat = sql.replace(/\s+/g, ' ').trim();
  if (flat === '') return undefined;
  return flat.length > SQL_HEAD_CHARS ? `${flat.slice(0, SQL_HEAD_CHARS)}…` : flat;
}

const storage = new AsyncLocalStorage<RequestTiming>();

/** `fn` の中で打つ問い合わせを `timing` へ数える */
export function runWithRequestTiming<T>(timing: RequestTiming, fn: () => T): T {
  return storage.run(timing, fn);
}

/** いまの要求の器。HTTP の要求の外（クローンのターン・定期処理）では undefined */
export function currentRequestTiming(): RequestTiming | undefined {
  return storage.getStore();
}
