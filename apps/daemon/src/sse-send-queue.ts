/** SSE の購読者1本あたりの送り待ちの上限（`/chat` 系は #4662、`/journal/stream` は #4617）。件数と、書き出す JSON の字数の両方で締める。 */
export const SSE_SEND_QUEUE_MAX_ITEMS = 5_000;
export const SSE_SEND_QUEUE_MAX_CHARS = 16_000_000;

export interface QueuedSseItem<T> {
  readonly value: T;
  /** 書き出す `data`。積むときに1回だけ直列化し、字数の勘定と書き出しで使い回す。 */
  readonly data: string;
}

/**
 * SSE の購読者1本ぶんの送り待ち。`/chat` 系と `/journal/stream` が同じ1つを使う（#5694）。
 * 上限を超えたら溜めた分を捨てて「溢れた」に落ち、以後は何も積まない: 読まない受け手のために出来事をメモリに溜め続けないため。
 * 溢れた購読は送り出す側（`app.ts`）が切る。理由の残し方と、受け手が続きを取り戻す道は口ごとに違う（`app.ts` の各ループの注記）。
 */
export class SseSendQueue<T> {
  readonly #maxItems: number;
  readonly #maxChars: number;
  #items: QueuedSseItem<T>[] = [];
  #chars = 0;
  #overflow: { items: number; chars: number } | undefined;

  constructor(limits: { maxItems?: number | undefined; maxChars?: number | undefined } = {}) {
    this.#maxItems = limits.maxItems ?? SSE_SEND_QUEUE_MAX_ITEMS;
    this.#maxChars = limits.maxChars ?? SSE_SEND_QUEUE_MAX_CHARS;
  }

  /** 溢れたときの件数と字数（溢れた1件を含む）。溢れていなければ `undefined`。 */
  get overflow(): { items: number; chars: number } | undefined {
    return this.#overflow;
  }

  push(value: T): void {
    if (this.#overflow !== undefined) return;
    const data = JSON.stringify(value);
    this.#items.push({ value, data });
    this.#chars += data.length;
    if (this.#items.length > this.#maxItems || this.#chars > this.#maxChars) {
      this.#overflow = { items: this.#items.length, chars: this.#chars };
      this.#items = [];
      this.#chars = 0;
    }
  }

  shift(): QueuedSseItem<T> | undefined {
    const item = this.#items.shift();
    if (item !== undefined) this.#chars -= item.data.length;
    return item;
  }

  /** `keep` が偽の分を捨て、字数からも外す（日誌の墓標で溜めた行を捨てるため）。 */
  retain(keep: (value: T) => boolean): void {
    this.#items = this.#items.filter((item) => keep(item.value));
    this.#chars = this.#items.reduce((sum, item) => sum + item.data.length, 0);
  }
}
