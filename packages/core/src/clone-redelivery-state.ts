import type { Commitment } from './schema.js';
import type { PendingInboxEvent } from './store.js';

export class CloneRedeliveryState {
  readonly #redelivered = new Map<string, PendingInboxEvent>();
  readonly #redeliveredClosed = new Map<string, Commitment>();

  get(id: string): PendingInboxEvent | undefined {
    return this.#redelivered.get(id);
  }

  getClosed(id: string): Commitment | undefined {
    return this.#redeliveredClosed.get(id);
  }

  // 既に載っていても書き直す: 同じ合図が二度以上拾い直されることがあり、そのたびに最新の deliveries / at へ更新するため
  markRedelivered(id: string, record: PendingInboxEvent): void {
    this.#redelivered.set(id, record);
  }

  markClosed(id: string, commitment: Commitment): void {
    this.#redeliveredClosed.set(id, commitment);
  }

  drop(id: string): void {
    this.#redelivered.delete(id);
    this.#redeliveredClosed.delete(id);
  }

  get redeliveredSize(): number {
    return this.#redelivered.size;
  }

  get redeliveredClosedSize(): number {
    return this.#redeliveredClosed.size;
  }
}
