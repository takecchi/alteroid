import type { ChatStreamEvent } from './schema.js';

export class CloneProgress {
  readonly #events = new Map<string, ChatStreamEvent[]>();

  record(conversationId: string, event: ChatStreamEvent): void {
    if (event.type === 'done' || event.type === 'error') {
      this.#events.delete(conversationId);
      return;
    }
    const events = this.#events.get(conversationId);
    if (events === undefined) {
      this.#events.set(conversationId, [event]);
      return;
    }
    const last = events[events.length - 1];
    if (event.type === 'text' && last?.type === 'text') {
      // 渡された event を書き換えない: 呼び出し側のものなので
      events[events.length - 1] = { type: 'text', text: last.text + event.text };
      return;
    }
    events.push(event);
  }

  snapshot(conversationId: string): ChatStreamEvent[] | null {
    const events = this.#events.get(conversationId);
    return events === undefined ? null : [...events];
  }

  clear(conversationId: string): void {
    this.#events.delete(conversationId);
  }

  clearAll(): void {
    this.#events.clear();
  }

  get size(): number {
    return this.#events.size;
  }
}
