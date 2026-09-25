import type { Commitment } from './schema.js';
import type { PendingInboxEvent } from './store.js';

/**
 * `Clone`（`clone.ts`）が持っていた**再配達の在り高2フィールド**
 * （`#redelivered` / `#redeliveredClosed`）を、独立の単位として切り出したもの
 * （Issue #1190 の続き）。
 *
 * **前例は PR #1359（`clone-notices.ts`）／ PR #1433（`runner-subagent-stop-state.ts`）／
 * PR #1507（`clone-inbox-flow.ts`）／ PR #1523（`runner-turn-tally.ts`）——
 * 同じ形にそろえてある。** 新しいクラスは完全に private な状態の器だけを持ち、
 * `#journal` / `#stores`（実際に日誌へ書く口とストアそのもの）には一切触れない。
 * いつ書くか・書けなかったときにどう倒すかの判断は、これまでどおり `Clone`
 * が持つ。
 *
 * **`CloneOptions.redeliveryGate`（`#redeliveryGate`）はここへは移していない。**
 * あれは構築時に注入される公開面（`CloneOptions` の必須フィールド）であり、
 * 状態ではなく振る舞いの委譲である——このクラスが持つのは「配り直しの
 * 在り高」という状態2つだけで、門（いま配る意味が在るかを決める述語）は
 * 呼び出し側（`Clone#restoreUnreadPass`）に残したまま、ここからは呼ばない。
 *
 * ## 何を持っているか
 *
 * - **`#redelivered`**——起動時に拾い直した合図。id → 何度目の配達か
 *   （{@link CloneRedeliveryState.markRedelivered} で記録し、
 *   {@link CloneRedeliveryState.get} で読む）。
 * - **`#redeliveredClosed`**——拾い直した合図のうち、台帳が既に片付いている
 *   と言っているもの（**閉じた主体は問わない** — クローンの `commitment_close`
 *   に限らず、人間の `POST /commitments/:id/close` で閉じたものも同じくここに
 *   載る。`commitment.closedBy` を見て区別するのは `closedRedeliveryNotice`
 *   の側である）。id → 台帳の記録（`closedAt` が立っている）
 *   （{@link CloneRedeliveryState.markClosed} で記録し、
 *   {@link CloneRedeliveryState.getClosed} で読む）。
 *
 * **`#redelivered` と `#redeliveredClosed` は対で持つ。** あちらは「二度目だと
 * 分かる」ための印、こちらは「本文を短くしてよい」ための印で、`Clone#forget`
 * （消し込み）で一緒に消す。`#redeliveredClosed` に載っているかどうかは
 * `Clone#restoreUnreadPass` が `stores.commitments` を引いて決める — **決める
 * のはそこだけ**（`#handle` の側では引き直さない）。**載っていない合図は、
 * これまでどおり全文で配る。** `commitments.get` が投げたときも載せない
 * （安全側は「全文で配る」— 雑音であって喪失ではない側へ倒す。
 * `Clone#restoreUnreadPass` の catch を見よ）。
 *
 * ## なぜ切り出したか、そして切り出しの限界（PR #1507 / #1433 / #1359 と同じ形の申告）
 *
 * **この節を読まずに「無駄な間接層だ」と思って `Clone` へ戻さないこと。**
 *
 * 1. **束として孤立してはいない。** この2フィールドを触っていたメンバーは
 *    `Clone` 側に8本在る（`dropQueuedInboxEvents` / `#removeStaleRedeliveryChunk` /
 *    `#restoreUnreadPass`（2箇所——台帳の片付き確認と `#droppedWhileRestoring`
 *    分岐）/ `#redeliveryNoticeFor` / `#closedRedeliveryNoticeFor` / `#forget` /
 *    `#writeInboxFlow`）——どれも `#unread` / `#dropPendingCollapse` /
 *    `stores.commitments` / `#redeliveryGate` のいずれかを併せて触る、受信箱
 *    そのものの状態を扱うメンバーである。**「この2フィールドだけを触る
 *    メンバー」は0本**である。⟹ この切り出しの実体は「疎結合な部分を剥がす」
 *    案ではなく、「暗黙の参照（`this.#redelivered` / `this.#redeliveredClosed`
 *    への直接アクセス）を、明示のメソッド呼び出し（`this.#redeliveryState.get(...)`
 *    等）に変える」案である——PR #1507・#1433・#1359 と同じ限界。
 * 2. **テストの分離は買えない。** `clone.test.ts` / `inbox-persistence.test.ts` /
 *    `stale-redelivery-batch.test.ts` の配り直し系の `it` / `describe` はどれも
 *    `Clone` をブラックボックスとして通した統合テストで、切り出しの前後で一体の
 *    まま動く——検証は `journal.list(...)` の中身や `retained.redelivered` /
 *    `retained.redeliveredClosed` の値であって、このクラスの内部を直接読んで
 *    いない。
 * 3. **挙動は1ビットも変えていない。** 呼び出し側（`Clone`）の `await` の位置・
 *    操作の順序・分岐の条件は1つも動かしていない——変わったのは「どこに
 *    書いてあるか」だけである。とくに次の2点は、切り出しの前後で1文字も
 *    変わっていない:
 *    - **`#redeliveredClosed` への書き込みは、`await this.#stores.commitments.get(...)`
 *      の**後ろ**に来る。** この境界はクラスをまたいでも動かない——
 *      {@link CloneRedeliveryState.markClosed} は同期メソッドのままで、
 *      いつ呼ぶか（＝ `await` の前か後か）は呼び出し側（`Clone#restoreUnreadPass`）
 *      が決める。
 *    - **4箇所の「id を削る」複合操作**（`dropQueuedInboxEvents` /
 *      `#removeStaleRedeliveryChunk` / `#restoreUnreadPass` の
 *      `#droppedWhileRestoring` 分岐 / `#forget`）は、いずれも
 *      `this.#redelivered.delete(id)` と `this.#redeliveredClosed.delete(id)`
 *      の間に `await` を挟まない（同期で連続して実行される）——だから
 *      {@link CloneRedeliveryState.drop} という1つの同期メソッドへ束ねて
 *      置き換えても、外から見える中間状態は増えない（束ねる前から、この2行
 *      の間で他の非同期処理が割り込む余地は無かった）。**`#unread.delete(id)`
 *      と `#dropPendingCollapse(...)` はこのクラスの外（`#unread` /
 *      `#pendingCollapse` はここに含まれない）にあるままで、呼び出し順序
 *      （`#unread.delete` → {@link CloneRedeliveryState.drop} →
 *      `#dropPendingCollapse`）も変えていない。**
 *
 * 得られるのは「この状態の組み合わせは、この器の中だけで読めばよい」という
 * レビューのしやすさだけである（PR #1507 / #1433 と同じ言い方）。
 */
export class CloneRedeliveryState {
  readonly #redelivered = new Map<string, PendingInboxEvent>();
  readonly #redeliveredClosed = new Map<string, Commitment>();

  /**
   * `id` の合図が「配り直し」として記録されているか読む。
   *
   * 呼び出し側（`Clone#redeliveryNoticeFor`）は、戻り値が `undefined` なら
   * 「初回配達」として扱う——このクラスは「無ければ初回」という解釈を持たず、
   * 素の `Map#get` をそのまま返すだけである。
   */
  get(id: string): PendingInboxEvent | undefined {
    return this.#redelivered.get(id);
  }

  /**
   * `id` の合図について、台帳が既に片付いていると分かっているときの記録を読む。
   *
   * 呼び出し側（`Clone#closedRedeliveryNoticeFor`）は、戻り値が `undefined`
   * なら「片付いていない（＝全文で配る）」として扱う。
   */
  getClosed(id: string): Commitment | undefined {
    return this.#redeliveredClosed.get(id);
  }

  /**
   * `id` の合図を「配り直し」として記録する（`Clone#restoreUnreadPass` が
   * 拾い直した1件ごとに、無条件で呼ぶ）。
   *
   * 既に載っていても書き直す——同じ合図が同じ器の生涯で二度以上拾い直される
   * ことがあり（`record.deliveries` が2以上）、そのたびに最新の `record`
   * （最新の `deliveries` / `at`）へ更新する必要があるためである。
   */
  markRedelivered(id: string, record: PendingInboxEvent): void {
    this.#redelivered.set(id, record);
  }

  /**
   * `id` の合図について、台帳が既に片付いていることを記録する
   * （`Clone#restoreUnreadPass` が `stores.commitments.get(...)` を待った
   * *後*に、`closedAt` が立っているときだけ呼ぶ——その条件判定は呼び出し側が
   * 持つ。ここでは無条件に `set` するだけである）。
   */
  markClosed(id: string, commitment: Commitment): void {
    this.#redeliveredClosed.set(id, commitment);
  }

  /**
   * `id` の合図の配り直し状態を、`#redelivered` / `#redeliveredClosed` の
   * 両方からまとめて落とす。
   *
   * **呼び出し側の4箇所すべてで、この2つの `delete` は元から同期で連続して
   * いた（間に `await` を挟まない）。** 束ねても、外から観測できる中間状態は
   * 増えない（クラス冒頭の doc「なぜ切り出したか」を見よ）。呼び出し側は
   * これとは別に `#unread.delete(id)` と `#dropPendingCollapse(...)` を
   * 自分で呼ぶ——このクラスは `#unread` も `#pendingCollapse` も持たない。
   */
  drop(id: string): void {
    this.#redelivered.delete(id);
    this.#redeliveredClosed.delete(id);
  }

  /** `inbox_flow.retained.redelivered`（`Clone#writeInboxFlow`）が読む時点の値。 */
  get redeliveredSize(): number {
    return this.#redelivered.size;
  }

  /** `inbox_flow.retained.redeliveredClosed`（`Clone#writeInboxFlow`）が読む時点の値。 */
  get redeliveredClosedSize(): number {
    return this.#redeliveredClosed.size;
  }
}
