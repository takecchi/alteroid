import type { ChatStreamEvent } from '@alteroid/core';

/** `/chat` 系の SSE の購読者1本あたりの送り待ちの上限（#4662）。件数と、書き出す JSON の字数の両方で締める。値は `/journal/stream`（#4617）に揃える。 */
export const CHAT_STREAM_QUEUE_MAX_EVENTS = 5_000;
export const CHAT_STREAM_QUEUE_MAX_CHARS = 16_000_000;

export interface QueuedChatEvent {
  readonly event: ChatStreamEvent;
  /** 書き出す `data`。積むときに1回だけ直列化し、字数の勘定と書き出しで使い回す。 */
  readonly data: string;
}

/**
 * `/chat` 系の SSE の購読者1本ぶんの送り待ち（#4662）。
 * 上限を超えたら溜めた分を捨てて「溢れた」に落ち、以後は何も積まない: 読まない受け手のためにターンの出来事をメモリに溜め続けないため。
 * 溢れた購読は送り出す側（`app.ts` の `chatEventPump`）が理由を1つ送って切る。クローンのターンは止めない。受け手は開き直せば続きから見える（`attach`）。
 */
export class ChatStreamQueue {
  readonly #maxEvents: number;
  readonly #maxChars: number;
  #items: QueuedChatEvent[] = [];
  #chars = 0;
  #overflow: { events: number; chars: number } | undefined;

  constructor(limits: { maxEvents?: number; maxChars?: number } = {}) {
    this.#maxEvents = limits.maxEvents ?? CHAT_STREAM_QUEUE_MAX_EVENTS;
    this.#maxChars = limits.maxChars ?? CHAT_STREAM_QUEUE_MAX_CHARS;
  }

  /** 溢れたときの件数と字数（溢れた1件を含む）。溢れていなければ `undefined`。 */
  get overflow(): { events: number; chars: number } | undefined {
    return this.#overflow;
  }

  push(event: ChatStreamEvent): void {
    if (this.#overflow !== undefined) return;
    const data = JSON.stringify(event);
    this.#items.push({ event, data });
    this.#chars += data.length;
    if (this.#items.length > this.#maxEvents || this.#chars > this.#maxChars) {
      this.#overflow = { events: this.#items.length, chars: this.#chars };
      this.#items = [];
      this.#chars = 0;
    }
  }

  shift(): QueuedChatEvent | undefined {
    const item = this.#items.shift();
    if (item !== undefined) this.#chars -= item.data.length;
    return item;
  }
}
