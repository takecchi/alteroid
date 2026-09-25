import { INBOX_EVENT_TYPE_ORDER } from './inbox-backlog.js';
import type { InboxEvent } from './schema.js';

/**
 * `Clone`（`clone.ts`）が持っていた**受信箱の到着・配達・消し込みを数える
 * 4フィールド**を、独立の単位として切り出したもの（Issue #783 段0。
 * Issue #1190 の続き）。
 *
 * **前例は PR #1359（`clone-notices.ts`）／ PR #1433（`runner-subagent-stop-state.ts`）——
 * 同じ形にそろえてある。** 新しいクラスは完全に private な状態の器だけを持ち、
 * `#journal` / `#stores`（実際に日誌へ書く口とストアそのもの）には一切触れない。
 * いつ書くか・書けなかったときにどう倒すかの判断は、これまでどおり `Clone`
 * （`#writeInboxFlow`）が持つ。
 *
 * ## 何を持っているか
 *
 * - **窓の始まり**（{@link CloneInboxFlow.snapshot} が返す `windowStartedAt`）——
 *   前回この窓を書いた時刻（器が入れ替わった直後は、このインスタンスが
 *   作られた時刻）。
 * - **到着・配達・消し込みの3本**（{@link CloneInboxFlow.arrived} /
 *   {@link CloneInboxFlow.delivered} / {@link CloneInboxFlow.settled}）——
 *   種類（`InboxEvent['type']`）別の、この窓で起きた回数。数える場所が
 *   それぞれ別であることは `schema.ts` の `inbox_flow` の doc（`arrived` は
 *   `#remember`、`delivered` は `#inbox.push` の3箇所、`settled` は `#forget`
 *   ほか）。**3本に分けている理由も、その doc が持つ**——ここは値の器だけを
 *   持つ。
 *
 * ## なぜ切り出したか、そして切り出しの限界（PR #1359 / #1433 と同じ形の申告）
 *
 * **この節を読まずに「無駄な間接層だ」と思って `Clone` へ戻さないこと。**
 *
 * 1. **束として孤立してはいない。** この4フィールドを触っていたメンバーは
 *    `Clone` 側に7本在る（`post` / `#postAndWait` / `#removeStaleRedeliveryChunk` /
 *    `#remember` / `#forget` / `#restoreUnreadPass` / `#writeInboxFlow`）——
 *    どれも受信箱そのものの状態（`#inbox` / `#unread` / `#redelivered` /
 *    `#redeliveredClosed` / `#pendingCollapse` / `#stores`）を併せて触る、
 *    受信箱の生死そのものを扱うメンバーである。**「この4フィールドだけを
 *    触るメンバー」は0本**である。⟹ この切り出しの実体は「疎結合な部分を
 *    剥がす」案ではなく、「暗黙の参照（`this.#inboxFlowArrived` 等への
 *    直接アクセス）を、明示のメソッド呼び出し（`this.#inboxFlow.arrived(...)` /
 *    `.snapshot()` / `.reset()`）に変える」案である——PR #1359・#1433 と
 *    同じ限界。
 * 2. **テストの分離は買えない。** `clone.test.ts` の `inbox_flow` 系の
 *    `describe` ブロックはどれも `#writeInboxFlow` が書く日誌の行を通した
 *    ブラックボックスのテストで、切り出しの前後で一体のまま動く——検証は
 *    `journal.list({ types: ['inbox_flow'] })` の中身であって、この
 *    クラスの内部を直接読んでいない。
 * 3. **挙動は1ビットも変えていない。** `#writeInboxFlow` の中で
 *    「`InboxStore.pending()` を待つ → 3本のカウンタを読む（`#journal` の
 *    引数を組み立てる時点）→ `#journal` を待つ → その後にだけ3本を空にして
 *    窓の開始時刻を進める」という順序と、`pending()` が失敗したら何もせず
 *    return する（カウンタを戻しも消しもしない）という分岐は、すべて
 *    `Clone` に在ったときのままである。変わったのは「どこに書いてあるか」
 *    だけである。
 *
 * 得られるのは「この状態の組み合わせは、この器の中だけで読めばよい」という
 * レビューのしやすさだけである（PR #1433 と同じ言い方）。
 */
export class CloneInboxFlow {
  #windowStartedAt = new Date().toISOString();
  readonly #arrived = new Map<InboxEvent['type'], number>();
  readonly #delivered = new Map<InboxEvent['type'], number>();
  readonly #settled = new Map<InboxEvent['type'], number>();

  /**
   * この窓に `Clone#post`（`#remember` 経由）が受理した1件を数える
   * （`schema.ts` の `inbox_flow.arrived` の doc「受理した瞬間であって
   * 書けた時刻ではない」）。
   */
  arrived(type: InboxEvent['type']): void {
    bump(this.#arrived, type);
  }

  /**
   * この窓にメモリ上の待ち行列（`Inbox`）へ実際に載った1件を数える
   * （`schema.ts` の `inbox_flow.delivered` の doc）。
   */
  delivered(type: InboxEvent['type']): void {
    bump(this.#delivered, type);
  }

  /**
   * この窓に `Clone#forget`（＝ `InboxStore.remove` の成功）を通った1件を
   * 数える（`schema.ts` の `inbox_flow.settled` の doc）。
   */
  settled(type: InboxEvent['type']): void {
    bump(this.#settled, type);
  }

  /**
   * いまの窓を、日誌の `inbox_flow` が持つ形（`windowStartedAt` と
   * `arrived` / `delivered` / `settled` の `{ total, byType }`）に整えて返す。
   *
   * **読むだけで、何も変えない。** 窓を進めるのは {@link CloneInboxFlow.reset}
   * の役目であって、ここでは行わない——呼び出し側（`#writeInboxFlow`）が
   * `#journal` の引数を組み立てる時点でこれを呼び、`#journal` を待った
   * *あとに* 別途 `reset()` を呼ぶ、という2段の形をそのまま保つため
   * （`pending()` が読めなければ `reset()` を呼ばない、という分岐を
   * 呼び出し側に残す）。
   */
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

  /**
   * 3本のカウンタを空にし、窓の開始時刻を「いま」へ進める。
   *
   * **`snapshot()` を呼んだ後に、日誌への書き込みが終わってから呼ぶこと。**
   * ここより前に例外で抜ければ、この窓ぶんの到着・配達・消し込みは次の窓へ
   * 持ち越される（`#writeInboxFlow` の doc「`InboxStore.pending()` が
   * 読めなければこの窓は書かない。カウンタも戻さない」）——その分岐は
   * この関数を呼ぶかどうかで呼び出し側が表現する。
   */
  reset(): void {
    this.#arrived.clear();
    this.#delivered.clear();
    this.#settled.clear();
    this.#windowStartedAt = new Date().toISOString();
  }
}

/** {@link CloneInboxFlow.snapshot} が `arrived` / `delivered` / `settled` それぞれに返す形。 */
export type InboxFlowByTypeCount = {
  total: number;
  byType: { type: InboxEvent['type']; count: number }[];
};

/** `counter` の `type` の値を1増やす。 */
function bump(counter: Map<InboxEvent['type'], number>, type: InboxEvent['type']): void {
  counter.set(type, (counter.get(type) ?? 0) + 1);
}

/**
 * 受信箱の流量（Issue #783 段0）の生カウンタを、日誌の `inbox_flow` が持つ
 * `{ total, byType }` の形に整える純関数。
 *
 * **0件の型は載せない。足すと必ず `total` に一致する**
 * （`inbox-backlog.ts` の `byType` と同じ作法——`counts` に無い型を作らないので、
 * 算術で「省いた型は0だった」と読める）。
 *
 * **並びは `order` が決める。** 呼び出し側（{@link CloneInboxFlow.snapshot}）は
 * `INBOX_EVENT_TYPE_ORDER`（`inbox-backlog.ts`）を渡し、`journal_read` で
 * 複数行を並べたときに型の順序が揺れないようにする。
 *
 * 副作用を持たない——数える場所（{@link CloneInboxFlow.arrived} /
 * {@link CloneInboxFlow.delivered} / {@link CloneInboxFlow.settled}）と
 * ここを分けてあるので、足場を組まずにこの整形だけを直接検算できる
 * （`inbox-backlog.ts` と同じ「判定と副作用を分ける」作法）。
 */
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
