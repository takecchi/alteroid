import type { InboxEvent } from './schema.js';

/**
 * クローンの受信箱（docs/architecture.md「同時実行モデル」）。
 *
 * 仕事の起点は人間に限らない（PRD「自律」）。M1 で積まれるのは人間の発言だけだが、
 * 「イベントが積まれ、クローンが一件ずつ取り出す」構造をここで固定しておく。
 * chat 専用の作りにしないための土台であり、M3 でタイマー・外部イベント・発意が
 * 同じ口から入る。
 */
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

  /**
   * まだ取り出されていないイベントに、条件を満たすものがあるか。
   *
   * 「同じ合図が処理前に二重に積まれた」を呼び出し側が判断するためのもの。
   * 処理中のものは既に取り出されているのでここには居ない。
   */
  hasPending(predicate: (event: InboxEvent) => boolean): boolean {
    return this.#queue.some(predicate);
  }

  /**
   * まだ取り出されていないものを、**先頭から連続して条件を満たす分だけ**取り出す。
   *
   * `next()` で1件取り出した呼び出し側が、その続きを一緒に読むためのもの
   * （`Clone#pump` の、処理待ちのあいだに積み上がった人間の発言）。
   *
   * **条件を満たさないものに当たったらそこで止める。走査して拾い集めない。**
   * 飛び越えて集めると、間に挟まった別の起点（タイマー・マネージャーからの報告・
   * 外部イベント）より後から届いた発言を先に読むことになり、受信箱が純粋な
   * 先入れ先出しであること（＝器が順序を並べ替えないこと）が崩れる。
   *
   * **待っている取り出し（`#waiters`）には触れない。** ここに居るのは既に
   * 積まれているものだけで、待ち受けが居る状態＝queue は空である。
   */
  drainWhile(predicate: (event: InboxEvent) => boolean): InboxEvent[] {
    const taken: InboxEvent[] = [];
    for (;;) {
      const head = this.#queue[0];
      if (head === undefined || !predicate(head)) return taken;
      this.#queue.shift();
      taken.push(head);
    }
  }

  push(event: InboxEvent): void {
    if (this.#closed) throw new Error('受信箱は既に閉じている');
    const waiter = this.#waiters.shift();
    if (waiter) {
      waiter(event);
      return;
    }
    this.#queue.push(event);
  }

  /** 次のイベントを待つ。閉じられて空になったら null。 */
  async next(): Promise<InboxEvent | null> {
    const queued = this.#queue.shift();
    if (queued !== undefined) return queued;
    if (this.#closed) return null;
    return new Promise<InboxEvent | null>((resolve) => {
      this.#waiters.push(resolve);
    });
  }

  /** 待っている取り出しを全部起こしてから閉じる。 */
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
