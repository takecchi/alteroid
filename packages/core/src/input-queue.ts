/** 入力の FIFO と待ち手。`singleWaiter` は待ち手を高々1本にする（クローン側）。既定は複数で、`wake()` が全員起こす。 */
export class InputQueue<I> implements AsyncIterable<I> {
  readonly #items: I[] = [];
  readonly #waiters = new Set<() => void>();
  #closed = false;

  constructor(private readonly singleWaiter = false) {}

  enqueue = (item: I): number => this.#items.push(item);
  dequeue = (): I | undefined => this.#items.shift();
  drain = (): I[] => this.#items.splice(0);

  wait(): Promise<void> {
    return new Promise<void>((resolve) => {
      if (this.singleWaiter) this.#waiters.clear();
      this.#waiters.add(resolve);
    });
  }

  wake(): void {
    const waiters = [...this.#waiters];
    this.#waiters.clear();
    for (const waiter of waiters) waiter();
  }

  close(): void {
    this.#closed = true;
    this.wake();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<I> {
    for (;;) {
      const next = this.dequeue();
      if (next !== undefined) yield next;
      else if (this.#closed) return;
      else await this.wait();
    }
  }
}
