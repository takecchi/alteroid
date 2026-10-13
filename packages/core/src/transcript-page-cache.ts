/**
 * `manager_transcript` の頁送りで、1枚目に取り寄せて絞った生ログを、続きの頁のあいだだけ覚えておく器（#4638）。
 *
 * - 覚えるのは1件だけ（担当1人・絞り1組）: 生ログは退避なら数十〜百 MB 級で、何件も持つとデーモンのヒープを食うため。
 *   別の担当・別の絞りで読めば、前の1件は捨てて置き換わる。
 * - 期限（{@link TRANSCRIPT_PAGE_CACHE_TTL_MS}）が来たら、次の呼び出しを待たずにタイマーで捨てる: 読み手が頁送りをやめた後も
 *   大きな本文が残り続けないため。タイマーはプロセスの終了を止めない（`unref`）。
 * - 範囲で読む口（PostgreSQL 側で substring）にしない: 絞り（since・until・type・contains）のある頁は全文が要り、範囲の口では解けないため。
 *   それに頁送りの offset は1枚目を読んだときの本文に対する位置で、同じ本文を使い回すほうが頁の間で位置がずれない。
 */

/** 頁送りの続きを読む間だけ覚える時間。読み手（クローン）が続けて頁をめくる間を越え、放置された本文を長く残さない長さ。 */
export const TRANSCRIPT_PAGE_CACHE_TTL_MS = 2 * 60_000;

export interface TranscriptPageSnapshot {
  /** 絞った後の本文（絞りが無ければ生ログそのまま）。 */
  readonly body: string;
  /** 絞り込みの断り書き（無ければ空文字）。 */
  readonly filterNote: string;
  readonly archiveId?: string;
  /** 1枚目を取り寄せた時刻（ISO 8601）。続きの頁に「いつの生ログか」を添えるため。 */
  readonly fetchedAt: string;
}

export class TranscriptPageCache {
  readonly #ttlMs: number;
  readonly #now: () => number;
  #entry: { key: string; snapshot: TranscriptPageSnapshot; expiresAt: number } | undefined;
  #timer: ReturnType<typeof setTimeout> | undefined;

  constructor(options: { ttlMs?: number; now?: () => number } = {}) {
    this.#ttlMs = options.ttlMs ?? TRANSCRIPT_PAGE_CACHE_TTL_MS;
    this.#now = options.now ?? Date.now;
  }

  get(key: string): TranscriptPageSnapshot | undefined {
    const entry = this.#entry;
    if (entry === undefined || entry.key !== key) return undefined;
    if (this.#now() >= entry.expiresAt) {
      this.clear();
      return undefined;
    }
    return entry.snapshot;
  }

  set(key: string, snapshot: TranscriptPageSnapshot): void {
    this.clear();
    this.#entry = { key, snapshot, expiresAt: this.#now() + this.#ttlMs };
    const timer = setTimeout(() => this.clear(), this.#ttlMs);
    timer.unref?.();
    this.#timer = timer;
  }

  clear(): void {
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#entry = undefined;
  }

  /** 覚えている本文があるか（テストと観測用）。 */
  get holding(): boolean {
    return this.#entry !== undefined;
  }
}

/** 担当と絞りの組から鍵を作る。区切りの衝突を避けるため配列を JSON にする。 */
export function transcriptPageCacheKey(input: {
  readonly managerId: string;
  readonly since?: string;
  readonly until?: string;
  readonly type?: string;
  readonly contains?: string;
}): string {
  return JSON.stringify([
    input.managerId,
    input.since ?? null,
    input.until ?? null,
    input.type ?? null,
    input.contains ?? null,
  ]);
}
