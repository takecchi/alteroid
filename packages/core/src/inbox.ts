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
   * 外部イベント）より後から届いた発言を先に読むことになり、**並んでいる順に
   * 読む**という約束が崩れる。
   *
   * **⚠️ 「並んでいる順」は「届いた順」ではなくなった。** 人間が待っている合図
   * （`human_message` / `human_answer`）は `push` の `insertAfterLast` で
   * 待ち行列の人間の最後尾へ入るので、**人間以外より前に並ぶ**（人間の決定。
   * `clone.ts` の `CLONE_HUMAN_PRIORITY_ENV_KEY` に逐語がある）。**それでも
   * ここは変えなくてよい** — 並べ替えは `push` の時点で済んでおり、ここは
   * 「いま並んでいる順に、先頭から連続する分だけ」を守るだけである。
   * **飛び越えて拾わない、という約束は同じ強さで生きている。**
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

  /**
   * イベントを積む。**既定は末尾**（純粋な先入れ先出し）。
   *
   * ## `insertAfterLast` — 割り込ませる口
   *
   * 渡すと、**その述語に最後に一致した要素の直後**へ入れる。1つも一致しなければ
   * **先頭**へ入れる。省略すれば末尾で、これまでと1文字も変わらない。
   *
   * **「誰が割り込んでよいか」はここに持たない。** 述語を受け取るだけにしてある
   * ので、この器は「人間」も「マネージャー」も知らない。判断は呼び出し側
   * （`Clone#post`）が持つ — 器が起点の種類を知り始めると、**優先順位の方針が
   * 器の中へ散る**（`hasPending` / `drainWhile` を述語で受けているのと同じ理由）。
   *
   * **この形が「人間どうしは FIFO」を同時に満たす。** 述語を「人間起点か」に
   * すると、新しい人間の発言は**既に並んでいる人間の後ろ**へ入る（追い越さない）
   * 一方、人間より後ろに居る人間以外は全部飛び越す。**2つの規則を1つの操作で
   * 表しているので、片方だけ実装される形が作れない。**
   *
   * **待ち手が居るときは順序の話にならない。** 待ち行列が空だから待っているので、
   * そのまま渡す（＝クローンが暇なときは、この口は何もしない）。
   */
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
    // **後ろから探す。** 「最後に一致したものの直後」なので、前から探して
    // 数えるより、末尾から最初の一致を見つけるほうが同じ答えを短く出せる。
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

  /**
   * 取り出したイベントを**待ち行列の先頭へ、渡した順のまま**戻す。
   *
   * **`push` では代用できない。** 戻したいのは「もう取り出したが、実はもっと
   * 早く届いていた」ものなので、末尾へ積むと到着順（FIFO）が壊れる。使うのは
   * クローンが枠（利用上限）の解除をするときで、**保持していた合図と、いま
   * 取り出したばかりの合図を、到着順に並べ直して受信箱へ返す**
   * （`clone.ts` の `#pump` 先頭の解除。あちらの doc に経緯がある）。
   *
   * **待っている取り出しが居れば先頭から渡す。** いまの唯一の呼び出し元
   * （`#pump` の本体）は自分が処理中なので待ち手は居ないが、居ないことを
   * 前提に黙って queue へ積む形にすると、将来別の場所から呼ばれたときに
   * 「積んだのに誰も起きない」＝**静かに止まる**（AGENTS.md「静かに失敗する
   * 道具」）。順序は queue の並びが決めるので、ここで渡しても FIFO は崩れない。
   */
  unshift(events: readonly InboxEvent[]): void {
    if (this.#closed) throw new Error('受信箱は既に閉じている');
    this.#queue.unshift(...events);
    while (this.#waiters.length > 0 && this.#queue.length > 0) {
      const waiter = this.#waiters.shift();
      const next = this.#queue.shift();
      if (waiter !== undefined && next !== undefined) waiter(next);
    }
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
