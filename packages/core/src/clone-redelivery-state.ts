import type { PendingInboxEvent } from './store.js';

export class CloneRedeliveryState {
  readonly #redelivered = new Map<string, PendingInboxEvent>();

  get(id: string): PendingInboxEvent | undefined {
    return this.#redelivered.get(id);
  }

  // 既に載っていても書き直す: 同じ合図が二度以上拾い直されることがあり、そのたびに最新の deliveries / at へ更新するため
  markRedelivered(id: string, record: PendingInboxEvent): void {
    this.#redelivered.set(id, record);
  }

  drop(id: string): void {
    this.#redelivered.delete(id);
  }

  get redeliveredSize(): number {
    return this.#redelivered.size;
  }
}
