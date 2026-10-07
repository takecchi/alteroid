import { INBOX_EVENT_TYPE_ORDER } from './inbox-backlog.js';
import type { InboxEvent } from './schema.js';

export class CloneInboxFlow {
  #windowStartedAt = new Date().toISOString();
  readonly #arrived = new Map<InboxEvent['type'], number>();
  readonly #delivered = new Map<InboxEvent['type'], number>();
  readonly #settled = new Map<InboxEvent['type'], number>();

  arrived(type: InboxEvent['type']): void {
    bump(this.#arrived, type);
  }

  delivered(type: InboxEvent['type']): void {
    bump(this.#delivered, type);
  }

  settled(type: InboxEvent['type']): void {
    bump(this.#settled, type);
  }

  // snapshot で窓を進めない: 呼び出し側は journal 書き込みの後にだけ reset() を呼び、pending() が読めなければ呼ばないため
  snapshot(): {
    windowStartedAt: string;
    arrived: InboxFlowByTypeCount;
    delivered: InboxFlowByTypeCount;
    settled: InboxFlowByTypeCount;
  } {
    return {
      windowStartedAt: this.#windowStartedAt,
      arrived: buildInboxFlowCount(this.#arrived, INBOX_EVENT_TYPE_ORDER),
      delivered: buildInboxFlowCount(this.#delivered, INBOX_EVENT_TYPE_ORDER),
      settled: buildInboxFlowCount(this.#settled, INBOX_EVENT_TYPE_ORDER),
    };
  }

  reset(): void {
    this.#arrived.clear();
    this.#delivered.clear();
    this.#settled.clear();
    this.#windowStartedAt = new Date().toISOString();
  }
}

export type InboxFlowByTypeCount = {
  total: number;
  byType: { type: InboxEvent['type']; count: number }[];
};

function bump(counter: Map<InboxEvent['type'], number>, type: InboxEvent['type']): void {
  counter.set(type, (counter.get(type) ?? 0) + 1);
}

export function buildInboxFlowCount(
  counts: ReadonlyMap<InboxEvent['type'], number>,
  order: readonly InboxEvent['type'][],
): InboxFlowByTypeCount {
  const byType = order
    .map((type) => ({ type, count: counts.get(type) ?? 0 }))
    .filter((entry) => entry.count > 0);
  const total = byType.reduce((sum, entry) => sum + entry.count, 0);
  return { total, byType };
}
