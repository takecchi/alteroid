import { Inbox } from './inbox.js';
import { CloneRedeliveryState } from './clone-redelivery-state.js';
import type { CommitOutcome, Listener } from './clone.js';
import type { InboxEvent } from './schema.js';

/** token-pool の「戻った」通知のうち、いま未処理のまま残っている代表1件。 */
type PendingTokenPoolNotice = { id: string; at: string; key: string; folded: number };

/** 畳み込みの索引の1行（代表の `id` / `at` と、畳み込んだ件数）。 */
type PendingCollapseEntry = { readonly id: string; readonly at: string; collapsed: number };

/**
 * `Clone`（`clone.ts`）が持っていた**「配送」11フィールド**
 * （`#inbox` / `#listeners` / `#completions` / `#deferred` / `#unread` /
 * `#pendingCollapse` / `#pendingTokenPoolNotice` / `#recorded` /
 * `#recordChain` / `#redeliveryState` / `#committed`）を、独立の単位として
 * 切り出したもの（Issue #1190 の続き）。`RunnerSdkSession`（#1611）・
 * `CloneDistillMemoryState`（#1613）・`CloneSdkSession`（#1614）と同じ形に
 * そろえてある。
 *
 * ## 何をするか、何をしないか
 *
 * 新しいクラスは状態と、局所的な遷移（読み取りだけの問い合わせ・「記録した
 * ことを覚える」「確定したことを覚える」の1操作）だけを持つ。**受信箱・
 * 枠（利用上限）・未読の拾い直しの判断・処理そのものの順序
 * （`#pump` / `#handle` / `#restoreUnread*` / `post()`）は1つもここへ
 * 移していない**——それらは引き続き `Clone` が持ち、この器のメソッドを
 * 呼ぶだけである。
 *
 * ## この束に入らないもの（`Clone` に残したまま）
 *
 * - **枠停止**（`#usageBlocked` / `#restoringUnread` / `#droppedWhileRestoring` /
 *   `#heldForUsage` / `#releaseRequested` / `#usageBlockSuppressedRearms` /
 *   `#usageBlockFoldedInternalFailures` / `#restoredCohort`）。配送の遷移の
 *   一部がこれらを読む場合でも、読み方は変えていない——`Clone` 側でこれまで
 *   どおり読み、この器へは渡さない。
 * - **許可まわり**（`#deniedToolUses` 等、`agent-hooks.ts`）。触れていない。
 *
 * ## `#recordChain` — await の構造・Promise の同一性を変えない
 *
 * この11フィールドのうち `#recordChain` は最も危険な部分である
 * ——**受理の瞬間の日誌への追記を、受け取った順に1本ずつ直列化する点が
 * ただ1つであること**が、会話の順序（`GET /conversations` が追記順を
 * そのまま使うという不変条件）を守っている。{@link CloneDelivery.chainRecord}
 * は元の `Clone#record` が書いていた3行をそのまま1つのメソッドへ集めた
 * だけで、**新しい `async` 関数では包んでいない**（このメソッド自身は
 * 同期関数である）——`.then(write)` を呼ぶ地点は、呼び出しの深さが1段
 * 増えるだけで、元のコードが呼んでいた地点と完全に同じ刻みのまま
 * である。⟹ tick 数・Promise の同一性は1文字も変わらない。**このクラスは
 * `#recordChain` そのものを外へは一切出さない**（`get`/`set` のどちらも
 * 公開しない）——触れる操作を {@link CloneDelivery.chainRecord} 1つに
 * 絞ることで、「列に繋がずに書く」という誤りをこのクラスの外からは
 * 起こせなくしてある。
 *
 * ## `#unread` / `#committed` — 素通しの同期メソッドである理由
 *
 * `#unread`（`Clone#forget` が `await written;` で待つ）・`#committed`
 * （`#commitmentNoticeFor` が `await this.#committed.get(pending.id)` で待つ）は
 * どちらも `Promise` を値に持つ `Map` である。**この2つに対するメソッドは
 * すべて素通しの同期な `get`/`set`/`delete` にしてある**——`await` する
 * 側・`.then()` で複合の約束を組み立てる側は、いずれもこのクラスの外
 * （`Clone#forget` / `Clone#commit` / `Clone#commitmentNoticeFor`）に残した
 * ままである。ここで `async` メソッドとして包むと、返す約束がラップされて
 * 新しい tick が1つ増え、`await written` が「実際の書き込みの完了」より
 * 1 tick 遅れて解決するようになる——起動直後の配り直しの順序が変わりうる
 * （Issue #1190「配送」束の進め方の指示「新しい async 関数で包んで Promise
 * の同一性や tick 数を変える形は禁止」)。
 *
 * ## `#inbox` / `#redeliveryState` — フィールドとして1本持つだけ
 *
 * `#inbox`（`Inbox`。既に独立したクラス）と `#redeliveryState`
 * （`CloneRedeliveryState`。PR #1532 で既に器になっている）は、どちらも
 * このクラスが**フィールドとして1本持つだけ**で、中身には触れていない
 * （進め方の指示どおり）。`Clone` 側の71箇所・12箇所の参照は、
 * `this.#inbox.X` → `this.#delivery.inbox.X`、
 * `this.#redeliveryState.X` → `this.#delivery.redeliveryState.X`
 * という機械的な書き換えのみで、`Inbox` / `CloneRedeliveryState` 自身の
 * 実装・契約は1文字も変えていない。
 *
 * ## なぜ切り出したか、そして切り出しの限界（前例と同じ形の申告）
 *
 * **この節を読まずに「無駄な間接層だ」と思って `Clone` へ戻さないこと。**
 *
 * 1. **束として孤立してはいない。** ここに集めた状態を触っていたメンバーは
 *    `Clone` 側に多数在り（`post` / `#pump` / `#handle` / `#settleInboxEvent` /
 *    `#forget` / `#restoreUnreadPass` / `dropQueuedInboxEvents` /
 *    `#commit` / `#commitmentNoticeFor` / `#record` / `#runHumanTurn` /
 *    `#foldIntoPendingCollapse` / `#dropPendingCollapse` /
 *    `#foldPendingTokenPoolNotice` / `#evictPendingTokenPoolRepresentative` /
 *    `#removeStaleRedeliveryChunk` / `#queuedInMemoryCount` /
 *    `#writeInboxFlow` 等）、どれも枠停止・許可・蒸留といった他の状態も
 *    併せて読む、受信箱そのものを扱うメンバーである。**「この11フィールド
 *    だけを触るメンバー」は0本**である。⟹ 前例（`CloneRedeliveryState` 等）
 *    と同じ限界——この切り出しの実体は「暗黙の参照を、明示のメソッド呼び出し
 *    に変える」案である。
 * 2. **テストの分離は買えない。** `clone.test.ts` 等の配送系の `it` は
 *    どれも `Clone` をブラックボックスとして通した統合テストで、切り出しの
 *    前後で一体のまま動く。
 * 3. **挙動は1ビットも変えていない。** 呼び出し側（`Clone`）の `await` の
 *    位置・操作の順序・分岐の条件は1つも動かしていない——変わったのは
 *    「どこに書いてあるか」だけである。
 *
 * 得られるのは「この状態の組み合わせは、この器の中だけで読めばよい」という
 * レビューのしやすさだけである（前例と同じ言い方）。
 */
export class CloneDelivery {
  // ---------------------------------------------------------------------
  // 受信箱そのもの・再配達の在り高2フィールドの器 — フィールドとして1本
  // 持つだけで、中身には触らない（クラス冒頭の doc）。
  // ---------------------------------------------------------------------

  readonly inbox = new Inbox();
  readonly redeliveryState = new CloneRedeliveryState();

  // ---------------------------------------------------------------------
  // 購読（会話ごとの listener 集合）
  // ---------------------------------------------------------------------

  readonly #listeners = new Map<string, Set<Listener>>();

  /**
   * 元の `Clone#subscribe` の本体のうち、購読1件を登録する部分。呼び出し側
   * （`Clone#subscribe`）は返した `set` をそのまま自分の閉包へ控えて、
   * {@link unsubscribeListener} へ渡す——`set` の同一性チェック（後述）は
   * 呼び出し元の閉包1つに対して一意でなければならないため、器の中では
   * 作り直せない。
   */
  subscribeListener(conversationId: string, listener: Listener): Set<Listener> {
    const set = this.#listeners.get(conversationId) ?? new Set<Listener>();
    set.add(listener);
    this.#listeners.set(conversationId, set);
    return set;
  }

  /**
   * 元の `Clone#subscribe` が返す解除関数の本体。**`set` の同一性を見る**
   * ——`this.#listeners.get(conversationId) === set` が崩れているとき
   * （別の購読が同じ conversationId で新しい `Set` を作り直した後）は、
   * 空でも消さない。
   */
  unsubscribeListener(conversationId: string, listener: Listener, set: Set<Listener>): void {
    set.delete(listener);
    if (this.#listeners.get(conversationId) === set && set.size === 0) {
      this.#listeners.delete(conversationId);
    }
  }

  /** 元の `Clone#endConversation` の該当行。`set` を取り直して、空なら落とす。 */
  dropListenersIfEmpty(conversationId: string): void {
    const set = this.#listeners.get(conversationId);
    if (set && set.size === 0) this.#listeners.delete(conversationId);
  }

  /** 元の `Clone#emit` の該当行。無ければ空の反復可能を返す。 */
  listenersFor(conversationId: string): Iterable<Listener> {
    return this.#listeners.get(conversationId) ?? [];
  }

  // ---------------------------------------------------------------------
  // 完了待ち（受信箱に積んだイベントの処理完了を待つための約束）
  // ---------------------------------------------------------------------

  /** 受信箱に積んだイベントの処理完了を待つための約束。 */
  readonly #completions = new Map<string, () => void>();

  /**
   * 元の `Clone#postAndWait` が `new Promise` の実行子の中で同期に呼んで
   * いた1行。**新しい async 境界を作らない**——ただの同期な `Map#set` で、
   * `Promise` の同一性・tick 数は変わらない。
   */
  registerCompletion(id: string, resolve: () => void): void {
    this.#completions.set(id, resolve);
  }

  /** 元の `Clone#pump` 末尾の後始末。控えていた全部を呼んで、まとめて捨てる。 */
  settleAllCompletions(): void {
    for (const done of this.#completions.values()) done();
    this.#completions.clear();
  }

  /**
   * 元の `Clone#settleInboxEvent` 末尾の該当行。**消費する読み**——控えを
   * 読むと同時に消す。呼び出し側が返り値を自分で呼ぶ（呼ぶかどうか・
   * いつ呼ぶかは変えない——ここで呼んでしまうと呼び出し順序が変わる）。
   */
  takeCompletion(id: string): (() => void) | undefined {
    const done = this.#completions.get(id);
    this.#completions.delete(id);
    return done;
  }

  // ---------------------------------------------------------------------
  // 枠（利用上限）で保持している分の FIFO
  // ---------------------------------------------------------------------

  readonly #deferred: InboxEvent[] = [];

  /** 元の `Clone#settleInboxEvent` の `defer` 分岐。末尾へ積む。 */
  pushDeferred(event: InboxEvent): void {
    this.#deferred.push(event);
  }

  /** 元の `Clone#pump` 解除ブロックの該当行。全部を順序どおり取り出して空にする。 */
  drainDeferred(): InboxEvent[] {
    return this.#deferred.splice(0);
  }

  /**
   * 元の `Clone#dropQueuedInboxEvents` の該当ループ。**後ろから外す**
   * （前から `splice` すると添字がずれる）。見つかった順を反転して、
   * 到着順で返す——呼び出し側が期待する順序を1文字も変えない。
   */
  removeDeferredWhere(predicate: (event: InboxEvent) => boolean): InboxEvent[] {
    const found: InboxEvent[] = [];
    for (let i = this.#deferred.length - 1; i >= 0; i -= 1) {
      const held = this.#deferred[i];
      if (held === undefined || !predicate(held)) continue;
      this.#deferred.splice(i, 1);
      found.push(held);
    }
    found.reverse();
    return found;
  }

  /**
   * 元の `Clone#evictPendingTokenPoolRepresentative` の該当行。見つからなければ
   * `undefined`（呼び出し側が `null` への読み替えを持つ）。
   */
  removeDeferredById(id: string): InboxEvent | undefined {
    const index = this.#deferred.findIndex((held) => held.id === id);
    if (index === -1) return undefined;
    const [held] = this.#deferred.splice(index, 1);
    return held;
  }

  /** 元の `Clone#foldsIntoHeldTick` の該当行。 */
  someDeferred(predicate: (event: InboxEvent) => boolean): boolean {
    return this.#deferred.some(predicate);
  }

  /** 元の `Clone#noteFoldedTick` の該当行（日誌の文言に件数として載せる）。 */
  matchingDeferredCount(predicate: (event: InboxEvent) => boolean): number {
    return this.#deferred.filter(predicate).length;
  }

  /** 元の `Clone#queuedInMemoryCount` が `this.#inbox.size` に足していた値。 */
  get deferredCount(): number {
    return this.#deferred.length;
  }

  // ---------------------------------------------------------------------
  // 未読（器に置いた合図の書き込みの約束）
  // ---------------------------------------------------------------------

  /**
   * 未読として器に置いた合図。id → その書き込みの約束。**素通しの同期
   * メソッドだけを持つ**——クラス冒頭の doc「`#unread` / `#committed` —
   * 素通しの同期メソッドである理由」を見よ。
   */
  readonly #unread = new Map<string, Promise<void>>();

  getUnread(id: string): Promise<void> | undefined {
    return this.#unread.get(id);
  }

  setUnread(id: string, written: Promise<void>): void {
    this.#unread.set(id, written);
  }

  deleteUnread(id: string): void {
    this.#unread.delete(id);
  }

  get unreadSize(): number {
    return this.#unread.size;
  }

  // ---------------------------------------------------------------------
  // 畳み込みの索引（`inboxCollapseKey` の鍵 → 代表と件数）
  // ---------------------------------------------------------------------

  readonly #pendingCollapse = new Map<string, PendingCollapseEntry>();

  /**
   * 元の `Clone#foldIntoPendingCollapse` / `#dropPendingCollapse` が読んで
   * いた行。**返す値は `Map` が持つ実体そのもの**——`collapsed` は読み取り
   * 専用ではないので、呼び出し側は `existing.collapsed += 1` をこれまで
   * どおり直接書ける（オブジェクトの同一性は `Map` を介しても保たれる）。
   *
   * **`post()` の中だけで閉じる。** `Clone#foldIntoPendingCollapse` は同期
   * 関数（`post()` から呼ぶ）なので、この索引の照会（このメソッド）と書き込み
   * （{@link registerCollapseRepresentative}／`collapsed` を進める）は同じ
   * イベントループの刻みの中で不可分に起きる。⟹ #1041 が台帳側（`list()` と
   * `open()` の間）で指摘する TOCTOU は、この経路には構造的に存在しない——
   * ここは #1041 を直したものではなく、台帳側とは別の場所に同じ形の穴が無い
   * ことを最初から保証している、という違いである（`commitment.test.ts` の
   * 「上の『429 連投の再現』が測っていないもの」が同じ趣旨をもう1箇所で
   * 引いている）。
   */
  getCollapseEntry(key: string): PendingCollapseEntry | undefined {
    return this.#pendingCollapse.get(key);
  }

  /** 元の `#foldIntoPendingCollapse` / 再構築ループが「代表がまだ居ない」で通す行。 */
  registerCollapseRepresentative(key: string, id: string, at: string): void {
    this.#pendingCollapse.set(key, { id, at, collapsed: 0 });
  }

  /** 元の `Clone#restoreUnreadPass` 再構築ループの該当行。 */
  hasCollapseKey(key: string): boolean {
    return this.#pendingCollapse.has(key);
  }

  /**
   * 元の `Clone#dropPendingCollapse` の該当行。**id が一致するときだけ**
   * 落とす——一致しなければ何もせず `undefined` を返す（呼び出し側は戻り値の
   * 有無で「実際に落としたか」を判定し、`collapsed > 0` の日誌書き込みは
   * これまでどおり呼び出し側が決める）。
   */
  dropCollapseEntryIfMatches(key: string, id: string): PendingCollapseEntry | undefined {
    const existing = this.#pendingCollapse.get(key);
    if (existing === undefined || existing.id !== id) return undefined;
    this.#pendingCollapse.delete(key);
    return existing;
  }

  /** `inbox_flow.retained.pendingCollapse`（`Clone#writeInboxFlow`）が読む時点の値。 */
  get collapseSize(): number {
    return this.#pendingCollapse.size;
  }

  // ---------------------------------------------------------------------
  // token-pool の「戻った」通知の未処理代表1件
  // ---------------------------------------------------------------------

  #pendingTokenPoolNotice: PendingTokenPoolNotice | null = null;

  get pendingTokenPoolNotice(): PendingTokenPoolNotice | null {
    return this.#pendingTokenPoolNotice;
  }

  setPendingTokenPoolNotice(value: PendingTokenPoolNotice | null): void {
    this.#pendingTokenPoolNotice = value;
  }

  /**
   * `Clone#removeStaleRedeliveryChunk` / `Clone#forget` に逐語で2回現れて
   * いた `if (this.#pendingTokenPoolNotice?.id === id) this.#pendingTokenPoolNotice = null;`
   * を1つの遷移にまとめたもの。
   */
  clearPendingTokenPoolNoticeIfMatches(id: string): void {
    if (this.#pendingTokenPoolNotice?.id === id) this.#pendingTokenPoolNotice = null;
  }

  // ---------------------------------------------------------------------
  // 受理の瞬間の追記（`#recorded`）と、その直列化の点（`#recordChain`）
  // ---------------------------------------------------------------------

  readonly #recorded = new Map<string, Promise<void>>();
  #recordChain: Promise<void> = Promise.resolve();

  /**
   * 元の `Clone#record` の該当3行をまとめた、直列化そのものの遷移。
   * **クラス冒頭の doc「`#recordChain` — await の構造・Promise の同一性を
   * 変えない」を見よ。** `#recordChain` はこのメソッドの外には一切出さない
   * ——`get`/`set` のどちらも公開しない。
   *
   * `write` は元の `Clone#record` がその場で書いていた
   * `() => this.#journal({...})` と同じ形の引数として渡ってくるだけで、
   * このメソッド自身は同期関数（`async` ではない）——新しい tick を1つも
   * 足さない。戻り値（`written`）は呼び出し側が使わなくてよい（元の
   * `Clone#record` も戻り値は使っていなかった）——後から読み直したい場合は
   * {@link getRecorded} を使う。
   */
  chainRecord(id: string, write: () => Promise<void>): Promise<void> {
    const written = this.#recordChain.then(write);
    this.#recordChain = written.catch(() => undefined);
    this.#recorded.set(id, written);
    return written;
  }

  /** 元の `Clone#runHumanTurn` が `await` していた読み（`for (const event of events) await ...`）。 */
  getRecorded(id: string): Promise<void> | undefined {
    return this.#recorded.get(id);
  }

  /** 元の `Clone#settleInboxEvent` の該当行。「もう誰も待たない」という印だけを消す。 */
  deleteRecorded(id: string): void {
    this.#recorded.delete(id);
  }

  // ---------------------------------------------------------------------
  // 自動で開いた未了（`Clone#commit` が控える約束）
  // ---------------------------------------------------------------------

  /**
   * 自動で開いた未了。合図の id → その書き込みの約束。**`#unread` と同じ
   * 理由で素通しの同期メソッドだけを持つ**（クラス冒頭の doc）。約束の
   * 組み立て（`.then()` チェーンそのもの）は `Clone#commit` に残したまま
   * である。
   */
  readonly #committed = new Map<string, Promise<CommitOutcome>>();

  getCommitted(id: string): Promise<CommitOutcome> | undefined {
    return this.#committed.get(id);
  }

  setCommitted(id: string, outcome: Promise<CommitOutcome>): void {
    this.#committed.set(id, outcome);
  }

  deleteCommitted(id: string): void {
    this.#committed.delete(id);
  }
}
