import type { InboxEvent } from './schema.js';

export class Inbox {
  readonly #queue: InboxEvent[] = [];
  readonly #waiters: ((event: InboxEvent | null) => void)[] = [];
  #closed = false;

  get size(): number {
    return this.#queue.length;
  }

  get closed(): boolean {
    return this.#closed;
  }

  hasPending(predicate: (event: InboxEvent) => boolean): boolean {
    return this.#queue.some(predicate);
  }

  findPending(predicate: (event: InboxEvent) => boolean): InboxEvent[] {
    return this.#queue.filter(predicate);
  }

  // 条件を満たさないものに当たったらそこで止める（走査して拾い集めない）: 飛び越えると、間に挟まった別の起点より後から届いた発言を先に読むことになるため
  drainWhile(predicate: (event: InboxEvent) => boolean): InboxEvent[] {
    const taken: InboxEvent[] = [];
    for (;;) {
      const head = this.#queue[0];
      if (head === undefined || !predicate(head)) return taken;
      this.#queue.shift();
      taken.push(head);
    }
  }

  // `drainWhile` で代用しない: 実際に取り出してしまい、上限の意味が消えるため
  countWhile(predicate: (event: InboxEvent) => boolean): number {
    let count = 0;
    for (const event of this.#queue) {
      if (!predicate(event)) break;
      count += 1;
    }
    return count;
  }

  // 述語で受け、起点の種類や消し込みの方針を持ち込まない: 方針が器の中へ散るため
  // 閉じていても投げない: 減らす操作なので、閉じた後に呼ばれても失われるものが増えないため
  removeWhere(predicate: (event: InboxEvent) => boolean): InboxEvent[] {
    const removed: InboxEvent[] = [];
    // 後ろから外す: 前から回して splice すると、後続の添字が詰まって次の1件を読み飛ばすため
    for (let i = this.#queue.length - 1; i >= 0; i--) {
      const queued = this.#queue[i];
      if (queued === undefined || !predicate(queued)) continue;
      this.#queue.splice(i, 1);
      removed.push(queued);
    }
    // 待ち行列に並んでいた順へ直して返す: 逆だと「何が配られるはずだったか」が読めなくなるため
    return removed.reverse();
  }

  // 「誰が割り込んでよいか」を持たない: 器が起点の種類を知り始めると、優先順位の方針が器の中へ散るため
  // 後から来た人間を `unshift` で戻した保持分の前へ出さない: 出すには人間どうしの FIFO か `unshift` の復元順を壊すしかないため
  push(event: InboxEvent, insertAfterLast?: (queued: InboxEvent) => boolean): void {
    if (this.#closed) throw new Error('受信箱は既に閉じている');
    const waiter = this.#waiters.shift();
    if (waiter) {
      waiter(event);
      return;
    }
    if (insertAfterLast === undefined) {
      this.#queue.push(event);
      return;
    }
    let at = 0;
    for (let i = this.#queue.length - 1; i >= 0; i--) {
      const queued = this.#queue[i];
      if (queued !== undefined && insertAfterLast(queued)) {
        at = i + 1;
        break;
      }
    }
    this.#queue.splice(at, 0, event);
  }

  // `push` で代用しない: 末尾へ積むと到着順（FIFO）が壊れるため
  // 待っている取り出しが居れば先頭から渡す: 居ない前提で queue へ積むと、「積んだのに誰も起きない」で静かに止まるため
  unshift(events: readonly InboxEvent[]): void {
    if (this.#closed) throw new Error('受信箱は既に閉じている');
    this.#queue.unshift(...events);
    while (this.#waiters.length > 0 && this.#queue.length > 0) {
      const waiter = this.#waiters.shift();
      const next = this.#queue.shift();
      if (waiter !== undefined && next !== undefined) waiter(next);
    }
  }

  async next(): Promise<InboxEvent | null> {
    const queued = this.#queue.shift();
    if (queued !== undefined) return queued;
    if (this.#closed) return null;
    return new Promise<InboxEvent | null>((resolve) => {
      this.#waiters.push(resolve);
    });
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    while (this.#waiters.length > 0) {
      this.#waiters.shift()?.(null);
    }
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<InboxEvent> {
    for (;;) {
      const event = await this.next();
      if (event === null) return;
      yield event;
    }
  }
}
