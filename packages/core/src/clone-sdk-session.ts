import type { Query, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

import type { Turn } from './clone.js';

/**
 * `Clone`（`clone.ts`）が持っていた**「SDK セッションの生存」の状態13
 * フィールド**を、独立の単位として切り出したもの（Issue #1190 の続き）。
 * `RunnerSession` の `RunnerSdkSession`（#1611、`packages/core/src/runner-sdk-session.ts`）が
 * 近い前例——名前も同じ理由で揃えた。
 *
 * **前例と同じ形にそろえてある。** 新しいクラスは完全に private な状態の器
 * だけを持ち、`#journal` / `#stores`（実際に日誌へ書く口・記憶ストアの実体）・
 * `#queryFn` / `#mcpServerFactory`（注入された依存そのもの）には一切触れない。
 * **SDK セッションをいつ開く／畳むか・ターンをどう回すか・日誌へ何を書くかの
 * 判断はこれまでどおり `Clone` が持ち、この器は状態と、局所的な遷移だけを
 * 持つ。**
 *
 * ## 何を持っているか
 *
 * - **`#query` / `#reader` / `#pumpLoop`**——いま生きている SDK セッション
 *   （器＝CLI プロセス）そのものと、その読み手ループ、受信箱のループ。
 * - **`#turn`**——いま走っている1本のターン（`Clone` は直列にしか回さない
 *   ので高々1本）。
 * - **`#stopped`**——このセッションが止められたか。
 * - **`#input` / `#inputWaiter`**——SDK へ流す入力の待ち行列と、次の入力を
 *   待っている `#inputStream` の起こし待ち（`RunnerSdkSession` と違い、
 *   待ち手は常に高々1本——`Clone` の `#inputStream` はループが1本しか
 *   無いので `Set` にする理由が無い。元から `#inputWaiter`という単数形の
 *   フィールドだった）。
 * - **`#recycleForToken` / `#recycleForContextWindow`**——認証トークンを
 *   回した・文脈窓で畳んだので、次のターンの境界でセッションを畳んで
 *   作り直す意図。
 * - **`#resumedFrom` / `#sawInit`**——resume を試みた session id と、init を
 *   観測したか。
 * - **`#sdkSessionId`**——init で SDK が報告してきた、いまの SDK セッション
 *   id。
 * - **`#sessionTokenIdentity`**——このセッションが起きたときのトークンの
 *   身元。
 *
 * 13フィールドそれぞれの詳しい意味・不変・相互の関係は、元々 `clone.ts` の
 * フィールド宣言に付いていた doc から要点を保ったまま、下の各フィールド・
 * メソッドの doc へ移した。
 *
 * ## ⛔ 器に入れていないもの（19本の割り当てのうち6本。issuecomment-5843050193）
 *
 * - **`#queryFn` / `#mcpServerFactory`**——注入された依存そのもの
 *   （`typeof query` / `typeof createCloneMcpServer`）。ただ持っていて直接
 *   呼ぶだけで、生存に関わる遷移がこれらを使わない——依頼の判断基準
 *   「注入された依存は、その遷移が使うかどうかで決める」に従い、背骨として
 *   `Clone` に残した。
 * - **`#cloneToolsTransport` / `#cloneToolRelaySocketDir`**——構築時に1度だけ
 *   解決する `readonly` の設定値。走行中には変わらず、遷移も持たない。
 * - **`#cloneToolRelayHostPromise` / `#cloneToolRelayChildEntry`**——`??=` に
 *   よる遅延初期化という局所的な状態機械を持つが、**SDK セッション（本体の
 *   query）の生存とは別の資源**（クローンの道具を stdio 中継するための
 *   ホスト・子プロセスの入口パス）である。`#mcpServerConfigFor` /
 *   `#ensureCloneToolRelayHost` からしか読み書きされず、`#query` /
 *   `#turn` / `#stopped` など本体のどれとも1行も絡まない——「SDK セッションの
 *   生存」という名前の器に、別の資源の生存を混ぜないために外した。
 *
 * ## なぜ切り出したか、そして切り出しの限界（前例と同じ形の申告）
 *
 * **この節を読まずに「無駄な間接層だ」と思って `Clone` へ戻さないこと。**
 *
 * 1. **切る根拠は価値の軸の測定であって、構造的な孤立ではない**
 *    （issuecomment-5843050193）。19フィールドの母集団に対し3/4定義で有意
 *    ——ただし**この束は費用がいちばん大きい**（跨ぐ重み397、境界の相手58）
 *    と同コメントが明記している。実際、13フィールドだけを触るメンバーは
 *    `Clone` 側に無数にあり（`#read` / `#apply` / `#runTurn` / `#inputStream` /
 *    `#ensureQuery` / `stop()` / `#finishTurn` / `#noteContextWindowFold` /
 *    `#noteUnproductiveUsageBlockFold` / `#toolContext` / `interruptTurn` /
 *    `recycleSessionForToken` ほか多数）、この切り出しの実体は「疎結合な
 *    部分を剥がす」案ではなく「暗黙の参照を明示のメソッド呼び出しに変える」
 *    案である。
 * 2. **畳みの順序はここに持ち込んでいない。** `stop()` が畳む手順の並び
 *    （`#postAndWait` の蒸留 → `#inbox.close()` → `#pumpLoop` を待つ →
 *    `#stopped` を立てる → `#flushSessionUsage` → `#query.close()` →
 *    `#reader` を待つ → マネージャー・道具中継を畳む）は、すべて `Clone` に
 *    残る。この器が持つのは「畳み中の1本の Promise を控える」ような下請けの
 *    機構ではなく、**個々の状態そのもの**である——`RunnerSdkSession` の
 *    `trackClosing` に相当する共通化は、`Clone` 側には重複した畳みの手順が
 *    無かったため作っていない（`stop()` は1本しか無く、`#finish()` に相当
 *    する2本目の畳み口も無い）。
 * 3. **テストの分離は買えない。** `clone.test.ts` の SDK セッションを名指し
 *    する黒箱テストは、切り出しの前後で一体のまま `Clone` を通して動く——
 *    ここで直接テストするのは、このクラス自身の状態遷移だけである。
 * 4. **挙動は1ビットも変えていない。** 呼び出し側（`Clone`）の `await` の
 *    位置・操作の順序・分岐の条件は1つも動かしていない。
 *    - {@link CloneSdkSession.finishTurn} は元の `#finishTurn()` の全身
 *      （ターンを取り出して `null` にし、`resolve()` を呼び、回す印が立って
 *      いれば起こす）をそのまま持つ——**触る4フィールド
 *      （`#turn`・`#recycleForToken`・`#recycleForContextWindow`・
 *      `#inputWaiter`）がすべてこの器の中にあるため、丸ごと1つの遷移として
 *      移せた**（`RunnerSdkSession` には無かった形——あちらは畳みの順序が
 *      複数の器・ハブをまたぐため、`#finish` 自体はハブに残した）。
 *    - {@link CloneSdkSession.open} は「`#query` を先に、`#reader` を後に
 *      代入する」という元の2行を1回の呼び出しへまとめている。`#read`
 *      （`reader` の中身）は同期の前置きの中で `this.#query` を読まない
 *      ので、まとめても観測できる違いは無い（`RunnerSdkSession#open` と
 *      同じ判断・同じ根拠）。
 *    - {@link CloneSdkSession.takeTokenRecycle} /
 *      {@link CloneSdkSession.takeContextWindowRecycle} は、元の「読んで
 *      から下ろす」2行を1回の呼び出しへ畳んだだけで、呼ぶ回数・下ろす
 *      タイミングは変えていない。**境界の判定そのもの**（`(wantsTokenRecycle
 *      || wantsContextWindowRecycle) && turn === null` という `#inputStream`
 *      の条件、`#read` の `finally` の `if (wantsContextWindowRecycle)`）は
 *      `Clone` に残る——複数の状態を1つの `if` で組み合わせる判断はハブの
 *      仕事である。
 *
 * 得られるのは「この状態の組み合わせは、この器の中だけで読めばよい」という
 * レビューのしやすさだけである（前例と同じ言い方）。
 */
export class CloneSdkSession {
  // ---------------------------------------------------------------------
  // SDK セッション本体（`#query` / `#reader`）と受信箱のループ（`#pumpLoop`）
  // ---------------------------------------------------------------------

  /** いま開いている SDK クエリ（器＝CLI プロセス）。無ければ `null`。 */
  #query: Query | null = null;
  /** `#query` を読み続けている `#read` ループの Promise。無ければ `null`。 */
  #reader: Promise<void> | null = null;
  /**
   * 受信箱のループ（`#pump()`）そのもの。**畳むときに読み切るために保持
   * する**（Issue #564 (a)）。`stop()` が待ち行列を読み切ってから畳むには、
   * その1本を `await` できる形で持っておく必要がある。
   *
   * **`.catch(...)` まで含めた Promise を控えること。** 呼び出し側
   * （`Clone` のコンストラクタ）が `.catch()` を外して素の `#pump()` を
   * 渡すと、ループが投げたときに `stop()` が待つ前の時点で unhandled
   * rejection になる——このクラスはその判断をせず、渡された Promise を
   * そのまま保持するだけである。
   */
  #pumpLoop: Promise<void> | null = null;

  get query(): Query | null {
    return this.#query;
  }

  get reader(): Promise<void> | null {
    return this.#reader;
  }

  get pumpLoop(): Promise<void> | null {
    return this.#pumpLoop;
  }

  /**
   * 新しく開いた SDK セッションを控える（`Clone#ensureQuery` が呼ぶ）。
   *
   * **`#query` を先に、`#reader` を後に代入する元の2行を1回の呼び出しへ
   * まとめている。** `#read`（`reader` の中身）は同期の前置きの中で
   * `this.#query` を読まないので、まとめても観測できる違いは無い。
   */
  open(query: Query, reader: Promise<void>): void {
    this.#query = query;
    this.#reader = reader;
  }

  /**
   * `#read` が正常に（あるいは例外で）終わったとき、`Clone#read` の
   * `finally` が呼ぶ。**閉じない。** この経路では SDK 側が既に終わって
   * いるので、`close()` を試みる必要が無い——`stop()` 側の
   * {@link closeQuery} とは別の口である。
   */
  clearQuery(): void {
    this.#query = null;
  }

  /**
   * いま開いている `#query` を閉じる（既に閉じていれば何もしない）。
   * `Clone#stop` が呼ぶ。**`#query` を `null` に戻さない**——`stop()` は
   * このセッションを畳んで捨てるだけで作り直さないので、戻す意味が無い
   * （`RunnerSdkSession#closeQuery` と同じ判断）。
   */
  closeQuery(): void {
    try {
      this.#query?.close();
    } catch {
      // 既に閉じている
    }
  }

  /**
   * 受信箱のループの Promise を控える。**`Clone` のコンストラクタで1度だけ
   * 呼ぶ。** それ以降は書き換えない——`Clone` の生涯で受信箱のループは
   * 1本しか無い。
   */
  beginPumpLoop(promise: Promise<void>): void {
    this.#pumpLoop = promise;
  }

  // ---------------------------------------------------------------------
  // 停止フラグ
  // ---------------------------------------------------------------------

  #stopped = false;

  get stopped(): boolean {
    return this.#stopped;
  }

  /** `stop()` が立てる。一度立てたら二度と下ろさない（元と同じ一方向の遷移）。 */
  markStopped(): void {
    this.#stopped = true;
  }

  // ---------------------------------------------------------------------
  // いま走っているターン（高々1本。直列にしか進まない）
  // ---------------------------------------------------------------------

  #turn: Turn | null = null;

  get turn(): Turn | null {
    return this.#turn;
  }

  /** `Clone#runTurn` が、新しいターンを登録するときに呼ぶ。 */
  beginTurn(turn: Turn): void {
    this.#turn = turn;
  }

  /**
   * 元の `#finishTurn()` の全身をそのまま持つ。**触る4フィールド
   * （`#turn`・`#recycleForToken`・`#recycleForContextWindow`・
   * `#inputWaiter`）がすべてこの器の中にあるため、丸ごと1つの遷移として
   * 移せた。**
   *
   * ターンを取り出して `null` にし、控えていた `resolve()` を呼ぶ。回す
   * 印（トークン・文脈窓のどちらか）が立っていれば、入力待ちで止まって
   * いる `#inputStream` を起こす——起こさないと、次に入力が届くまで古い
   * トークンのまま走り続ける。
   */
  finishTurn(): void {
    const turn = this.#turn;
    this.#turn = null;
    turn?.resolve();
    if (this.#recycleForToken || this.#recycleForContextWindow) this.wakeInput();
  }

  // ---------------------------------------------------------------------
  // SDK へ流す入力の待ち行列と、次の入力を待つ側の起こし待ち
  // ---------------------------------------------------------------------

  /** SDK へ流す入力の待ち行列。 */
  readonly #input: SDKUserMessage[] = [];
  /**
   * 次の入力を待っている `#inputStream` を起こすための待ち手。**高々1本**
   * ——`Clone` の `#inputStream` はループが1本しか無いので、`RunnerSdkSession`
   * の `Set` のような複数待ち手の仕組みは要らない。
   */
  #inputWaiter: (() => void) | null = null;

  /** `Clone#pushInput` が呼ぶ。待ち行列の末尾へ積む。 */
  enqueueInput(message: SDKUserMessage): void {
    this.#input.push(message);
  }

  /** `#inputStream` が呼ぶ。先頭から1件取り出す（無ければ `undefined`）。 */
  dequeueInput(): SDKUserMessage | undefined {
    return this.#input.shift();
  }

  /**
   * 次の入力が来るまで待つ（`#inputStream` が呼ぶ）。**`wakeInput` が
   * 呼ばれるまで解決しない。**
   */
  waitForInput(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.#inputWaiter = resolve;
    });
  }

  /** 待っている1本を起こす（居なければ何もしない）。 */
  wakeInput(): void {
    const waiter = this.#inputWaiter;
    this.#inputWaiter = null;
    waiter?.();
  }

  // ---------------------------------------------------------------------
  // 認証トークン・文脈窓の畳み直しの意図
  // ---------------------------------------------------------------------

  /**
   * 認証トークンを回したので、次のターンの境界で SDK セッションを畳んで
   * 作り直す意図（Issue #393 PR4）。**印だけを持つ。**
   */
  #recycleForToken = false;
  /**
   * 文脈窓（プロンプトの長さ）で落ちた・枠に当たり続けたので、次のターンの
   * 境界でセッションを畳んで作り直す意図（#553 / Issue #1240）。
   * `#recycleForToken` と違い、**作り直すときに resume しない**（会話を
   * 切る）——この違いは呼び出し側（`Clone`）が持つ。
   */
  #recycleForContextWindow = false;

  /** `Clone#recycleSessionForToken` が立てる。 */
  requestTokenRecycle(): void {
    this.#recycleForToken = true;
  }

  get wantsTokenRecycle(): boolean {
    return this.#recycleForToken;
  }

  /**
   * 消費する読み——読んで、無条件に下ろす。`#inputStream` が境界条件
   * （`turn === null` かつ、どちらかの回す印が立っている）を認めたときに
   * 呼ぶ。
   */
  takeTokenRecycle(): boolean {
    const wanted = this.#recycleForToken;
    this.#recycleForToken = false;
    return wanted;
  }

  /** `Clone#noteContextWindowFold` / `#noteUnproductiveUsageBlockFold` が立てる。 */
  armContextWindowRecycle(): void {
    this.#recycleForContextWindow = true;
  }

  get wantsContextWindowRecycle(): boolean {
    return this.#recycleForContextWindow;
  }

  /**
   * 消費する読み——読んで、無条件に下ろす。`#read` の `finally` が、
   * セッションが閉じた後の退避（`#salvageTranscript`）を行うかどうかの
   * 判定に使う。
   */
  takeContextWindowRecycle(): boolean {
    const wanted = this.#recycleForContextWindow;
    this.#recycleForContextWindow = false;
    return wanted;
  }

  // ---------------------------------------------------------------------
  // resume の試みと init の観測
  // ---------------------------------------------------------------------

  /** resume を試みた session id。init が来る前に落ちたら捨てる。 */
  #resumedFrom: string | null = null;
  /** このセッションで init を観測したか。 */
  #sawInit = false;

  get resumedFrom(): string | null {
    return this.#resumedFrom;
  }

  get sawInit(): boolean {
    return this.#sawInit;
  }

  /**
   * `Clone#ensureQuery` が、新しいセッションを起こす直前に呼ぶ。**2本
   * まとめて立てる**——元の2行の代入順序・値は変えていない。
   */
  beginSession(resume: string | null): void {
    this.#resumedFrom = resume;
    this.#sawInit = false;
  }

  /** `case 'session_started'`（init を観測した回）が呼ぶ。 */
  markSawInit(): void {
    this.#sawInit = true;
  }

  // ---------------------------------------------------------------------
  // init が報告した SDK セッション id
  // ---------------------------------------------------------------------

  /**
   * init で SDK が報告してきた、いまの SDK セッション id。`#resumedFrom`
   * とは別（あちらは resume 元）。
   *
   * **`#forgetObservedFacts` / `#captureInitFacts`（`Clone`）と同時に、
   * 観測事実の他のフィールドと一緒に読み書きされる**——あちらの束
   * （issuecomment-5843050193 の「観測事実」16本）はこの切り出しの対象で
   * はないので、このフィールドは呼び出し側の該当行だけを置き換える形に
   * なっている。
   */
  #sdkSessionId: string | null = null;

  get sdkSessionId(): string | null {
    return this.#sdkSessionId;
  }

  /**
   * `#captureInitFacts`（init を観測した回）と `#forgetObservedFacts`
   * （セッションを開き直す前）の両方が呼ぶ。**`null` を渡すのは後者だけ**
   * ——前者は `facts.sessionId`（`string | null`。SDK が読めなかった回は
   * `null`）をそのまま渡す。
   */
  setSdkSessionId(id: string | null): void {
    this.#sdkSessionId = id;
  }

  // ---------------------------------------------------------------------
  // このセッションが起きたときのトークンの身元
  // ---------------------------------------------------------------------

  /**
   * このセッションが起きたときのトークンの身元（Issue #393 PR3）。
   *
   * `Clone#childEnv()` で1度だけ捕まえる——**観測のたびに読み直さない。**
   * 読み直すと、回した後に届いた「前のセッションの観測」が新しい身元を
   * 名乗り、世代の照合がそのまま素通しになる。
   */
  #sessionTokenIdentity: { tokenId: string; generation: number } | undefined;

  get sessionTokenIdentity(): { tokenId: string; generation: number } | undefined {
    return this.#sessionTokenIdentity;
  }

  /** `Clone#childEnv()` が、セッションが起きるその瞬間に呼ぶ。 */
  captureSessionTokenIdentity(identity: { tokenId: string; generation: number } | undefined): void {
    this.#sessionTokenIdentity = identity;
  }
}
