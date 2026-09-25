import type { SdkFailure } from './sdk-failure.js';

/**
 * `RunnerSession`（`runner.ts`）が持っていた**ターン区切りで畳む集計12フィールド**
 * を、独立の単位として切り出したもの（Issue #1190 の続き。**10→12 は Issue #1373
 * 続きで足した2本**——切り出し自体は #1190 のままである）。
 *
 * **前例は PR #1433（`packages/core/src/runner-subagent-stop-state.ts`）・
 * PR #1359（`packages/core/src/clone-notices.ts`）——同じ形にそろえてある。**
 * 新しいクラスは完全に private な状態の器だけを持ち、`#emit` / `#id`（`RunnerEvent`
 * を実際に日誌へ出す口と、このセッションの id）には触れない。日誌へ出すかどうか・
 * 何を報告本文へ組み立てるかの判断は、これまでどおり `RunnerSession` が持つ。
 *
 * ## 何を持っているか
 *
 * - **マネージャーが喋った本文の列**（{@link RunnerTurnTally.recordSaid}で積む
 *   `said` と、それに紐づく assistant メッセージの `uuid`）
 * - **SDK が「これは応答ではない」と印を付けた事実**
 *   （{@link RunnerTurnTally.setRejected}）
 * - **`worker_wait` の契機を数える4カウンタ**——入力消費・`task_notification`・
 *   マネージャー自身の道具・`UserPromptSubmit`（{@link RunnerTurnTally.incrementInputsSinceResult} /
 *   {@link RunnerTurnTally.incrementNotificationsSinceResult} /
 *   {@link RunnerTurnTally.incrementToolsSinceResult} /
 *   {@link RunnerTurnTally.incrementSubmitsSinceResult}）と、`UserPromptSubmit`
 *   の `source` ごとの内訳（{@link RunnerTurnTally.recordSubmitSource}）
 * - **#1373 の状況証拠4本**——このターンで開いた作業者の taskId の集合
 *   （{@link RunnerTurnTally.addOpenedWorker}）、作業者の発言に付いた拒否の印
 *   （{@link RunnerTurnTally.pushWorkerRejection}）、`task_notification` が
 *   `status: 'failed'` で終わった件数とそのうち枠(429)を名乗った件数
 *   （{@link RunnerTurnTally.recordFailedWorkerNotification}。値としては2欄
 *   だが1本のメソッドで一緒に積むので、束としては4本と数える）
 *
 * ## なぜ切り出したか、そして切り出しの限界（PR #1433 / #1359 と同じ形の申告）
 *
 * **この節を読まずに「無駄な間接層だ」と思って `RunnerSession` へ戻さないこと。**
 *
 * 1. **束として孤立してはいない。** 12フィールドを触るメンバーは `RunnerSession`
 *    側に8本在る（`#inputStream` / `#apply` の `case 'assistant_message'` /
 *    `case 'turn_ended'` / `#onTaskStarted` / `#onTaskNotification` /
 *    `#onPostToolUse` / `#onPostToolUseFailure` / `#onUserPromptSubmit` /
 *    `#flushUnreported` / `#recoverFromFailedResume`）——どれも `#emit` か
 *    `#window`（`worker_wait` の集計）か報告本文の組み立てを併せて使う。
 *    「集計だけを触るメンバー」は0本である。⟹ この切り出しの実体は「疎結合な
 *    部分を剥がす」案ではなく、「暗黙の参照（`this.#said` 等への直接アクセス）
 *    を、明示のメソッド呼び出し（`this.#turnTally.recordSaid(...)` 等）に
 *    変える」案である——PR #1433 / #1359 と同じ限界。
 * 2. **テストの分離は買えない。** `runner-failure.test.ts` / `runner-wakeup.test.ts`
 *    / `runner-unreported.test.ts` / `runner-resume-recreate-worker-count.test.ts`
 *    はブラックボックスのまま、切り出しの前後で一体で動く。保証しているのは
 *    「この状態の組み合わせは、この器の中だけで読めばよい」というレビューの
 *    しやすさだけである。
 * 3. **挙動は1ビットも変えていない。** 出力・代入の時点と順序・エラーの倒れ先は
 *    すべて `RunnerSession` に在ったときのままである。変わったのは「どこに
 *    書いてあるか」だけである。
 *
 * ## 畳む場所が3つあり、それぞれ畳む範囲が違う。この差はそのまま保つ
 *
 * 12フィールドは**一括で畳めるものではない**——呼び出し側の3箇所が、それぞれ
 * 違う範囲を畳む。だから「読み出して畳む」操作を3本に分けてあり、
 * どれも「全部畳む」へまとめない。
 *
 * - {@link RunnerTurnTally.takeAtResult}——`#apply` の `case 'turn_ended'`
 *   （`result` を受け取った回）が呼ぶ。**12フィールド全部**を読み出して
 *   同じ場で畳む。呼び出し元はこの中で `await` を挟まない（`turn_ended` 内の
 *   `await this.#observeContextUsage()` は、この呼び出しより**前**に済んで
 *   いる）。
 * - {@link RunnerTurnTally.takeSaid}——`#flushUnreported`（`result` を受け取ら
 *   ないまま畳む回。#323）が呼ぶ。畳むのは `said` と、それに紐づく `uuid`
 *   **の2本だけ**——`rejected` はここでは読まない（`result` が来ていない
 *   ので「失敗として終わった」と名乗れないため。`#flushUnreported` 自身の
 *   doc を見よ）。残り10本にも触れない。
 * - {@link RunnerTurnTally.discardOpenedWorkersAndRejections}——
 *   `#recoverFromFailedResume`（前のセッションへ戻れなかったときの後始末）が
 *   呼ぶ。畳むのは「このターンで開いた作業者」「作業者の拒否の印」
 *   「`task_notification` が `status: 'failed'` で終わった件数（枠を名乗った
 *   件数を含む）」の**3本だけ**で、しかも**読み出さずに捨てる**（戻り値を
 *   返さない）。前のセッションが開いていた委譲は次のセッションに一切
 *   引き継がれないので、読んでも使い道が無い——`#openTasks.clear()` と
 *   同じ理由（`runner.ts` の `#recoverFromFailedResume` 内のコメントを見よ）。
 *   この経路が呼ばれる3箇所のうち1箇所（`turn_ended` の失敗分岐）は既に
 *   {@link RunnerTurnTally.takeAtResult} で空になった後に来るので、そこでは
 *   事実上の空振りになる——残り2箇所（`#reopen` 相当の再接続経路）では、
 *   畳まれていない値を読まずに捨てる、という本来の役目を果たす。
 *
 * **⟹ 3本のうちどれか2本を1本へ統合しないこと。** 統合すると、統合されな
 * かった側の呼び出し元が「畳まなくていいフィールドまで畳まれる」か「畳み
 * たいフィールドが畳まれない」のどちらかで壊れる。
 */
export class RunnerTurnTally {
  /**
   * このターンでマネージャーが出した本文（人間が Claude Code の画面で読むもの）。
   *
   * **報告を `result` 1本から作らない。** `result` はそのターンの最後の一片で
   * しかなく、道具を挟むたびに本文は切れる。`result` だけを渡すと、クローンには
   * 末尾だけが届き、**欠けていることが誰にも見えない**。人間は全部読めるのだから、
   * 受信側だけが読めないのは能力の削除である（north_star 禁止1）。
   */
  #said: string[] = [];

  /**
   * `#said` へ最後に積んだ assistant メッセージの `uuid`（SDK が払う id）。
   *
   * **{@link RunnerTurnTally.takeSaid} が `reportId` として運ぶためだけに持つ。**
   * 通常の報告は `result` メッセージの `message.uuid` を `reportId` に使う
   * （`runner-protocol.ts` の `report.reportId` の doc — 「runner が新しい値を
   * 毎回振るのではなく、SDK 側の識別子をそのまま運ぶ」）。**`result` が来ない
   * まま畳む回には、その id が存在しない。** そこで `randomUUID()` を振ると
   * その作法を破ることになるので、**同じ本文を運んできた assistant メッセージの
   * id をそのまま使う** — SDK 側の識別子であることは変わらず、再送しても
   * 同じ値になる。
   *
   * **`#said` と同じ区切りで畳む**（持ち越すと、前のターンの id が次の報告に
   * 付く）。
   */
  #saidUuid: string | undefined;

  /**
   * このターンで SDK が「これは応答ではない」と印を付けたメッセージ
   * （`assistant.error`）。
   *
   * **`#said` と同じ区切り（{@link RunnerTurnTally.takeAtResult}）で畳む。**
   * 持ち越すと、次のターンが成功しても失敗として報告されることになる。
   * **{@link RunnerTurnTally.takeSaid} では読まない**（`result` が来ていない
   * 経路では「失敗として終わった」と名乗れないため）。
   */
  #rejected: SdkFailure | null = null;

  /** このターンで `#inputStream` が実際に消費した入力の件数（`result` で畳む）。 */
  #inputsSinceResult = 0;

  /** このターンで受けた `task_notification` の件数（`result` で畳む）。 */
  #notificationsSinceResult = 0;

  /**
   * このターンでマネージャー自身の道具が動いた回数（`result` で畳む）。
   *
   * **作業者の道具は数えない**（`hook.agent_id` が付いているものは除く——
   * その判定は呼び出し側 `RunnerSession#onPostToolUse` / `#onPostToolUseFailure`
   * が持つ）。混ぜると「マネージャーは何もしていないターン」＝事故（「残り5体を
   * 待ちます」だけのターン）の再現条件そのものが消える。
   */
  #toolsSinceResult = 0;

  /** このターンで `UserPromptSubmit` がマネージャー自身に発火した回数（`result` で畳む）。 */
  #submitsSinceResult = 0;

  /**
   * このターンの中で1度でも `task_started`（`delegation_started`）を観測した
   * 作業者の taskId（`result` で畳む。#1373）。
   *
   * **`RunnerSession#openTasks`（`worker_wait` の区間の在り高）とは別の数え方
   * である。** `result` が来る時点では作業者はもう終わっていることが多く、
   * 「ターンの終わりに開いている数」ではなく「ターンの中で1度でも開いたことが
   * ある数」を数える —— 委譲の下で動く作業者が枠（429）に当たったとき、
   * デーモンがそれを委譲本体（マネージャー）のターンの失敗として名乗って
   * しまう問題（Issue #1373）に、状況証拠を1つ足すための数である。
   *
   * **同じ taskId を2度数えない**（`Set`。呼び出し側 `RunnerSession#onTaskStarted`
   * が provider の名乗った id、無ければ `randomUUID()` の代用値をそのまま
   * 足す）。
   *
   * `failedReportText`（`runner.ts`）はこの値（{@link RunnerTurnTally.takeAtResult}
   * が返す `.size`）が1以上のときだけ「このターンでは作業者が N 体開いていた」
   * という1行を本文に添える。**これは判定ではない** —— SDK の `result` は
   * 「誰の言葉が最後だったか」を運べる形をしていないので（Issue #1373 の
   * 調査）、どちらの層が枠に当たったかは決められない。断定を増やさず、
   * 状況証拠だけを渡す。
   */
  #openedWorkersThisTurn = new Set<string>();

  /**
   * このターンの中で、**作業者の発言**（`parentToolUseId` が非 null の
   * assistant メッセージ）に付いていた SDK の拒否の印（`errorCode`。
   * `rate_limit` / `billing_error` 等）。`result` で畳む（#1373 案 (a) の
   * 本文だけの形）。
   *
   * **{@link RunnerTurnTally.#openedWorkersThisTurn} との違いは、状況証拠か
   * 直接の証拠かである。** あちらは「作業者が開いていた」までしか言えず、
   * 当たったのが本体か作業者かは決められない。こちらは**作業者自身の発言に
   * 拒否の印が付いていた**ので、「作業者が当たった」ことは確かである。
   * ⚠ **ただし「本体は当たっていない」とは言えない** —— 同じ鍵・同じ枠なら
   * 本体も続けて当たりうる。
   *
   * **ターンの失敗にはしない。** 本体の `#rejected` へは入れない —— 作業者が
   * 1体枠に当たっても、本体は作業者を立て直して進めることがある（#1373 の
   * 実例 `mgr-4f6859d5`）。ここで持つのは、失敗で終わったターンの本文に添える
   * 材料だけである。構造化した欄（`runner-protocol.ts` の `failure`）には
   * 足していない —— 台帳と公開 API の形を変えることになる（#1373 のコメント）。
   */
  #workerRejectionsThisTurn: string[] = [];

  /**
   * このターンの中で `task_notification` が `status: 'failed'` として終わった
   * 件数と、その要旨（`summary`）が枠(429)を名乗っていた件数（`result` で畳む。
   * Issue #1373 続き）。
   *
   * **`#workerRejectionsThisTurn` とは経路が別である。** あちらは作業者自身の
   * 発言（`assistant.error`）に付いた拒否の印で、こちらは委譲の完了通知
   * （`task_notification`）が名乗る `status`。CLI の中の扱いを静的に読むと、
   * 作業者が枠で打ち切られてもそれまでの出力が1つでもあれば「失敗ではなく
   * 部分的な完了」として扱われ、そのとき**作業者のエラーの assistant メッセージ
   * は親へ返す履歴から除かれる**——`#workerRejectionsThisTurn` の経路では
   * 拾えない可能性がある（Issue #1373 の最新コメント）。背景で走らせた作業者
   * （出力を1つも持たない、または CLI がそう扱わない経路）は `status: 'failed'`
   * を名乗って完了通知が来ることが実機で観測されている——この2本目の経路が
   * それを拾う。
   *
   * **枠(429)を名乗っているかの判定は、手で書いた文言一致ではなく
   * `usage-limits.ts` の `classifyUsageNotice`（SDK 自身が定数で出す接頭辞）を
   * 使う**（`RunnerSession#onTaskNotification` を見よ）。自前の正規表現は
   * 腐り方が「検知しなくなる」なので書かない、という `usage-limits.ts` の doc
   * と同じ理由。**⚠️ 保守的な判定である**——`classifyUsageNotice` が拾うのは
   * SDK の `USAGE_LIMIT_ERROR_PREFIXES` 等の文言族（実機の例はこの族の
   * "You've hit your" に当たる）だけで、「error type rate_limit, HTTP 429」の
   * ような生の API エラー文言そのものを正規表現で拾ってはいない——1件も
   * 当たらなくても`枠を名乗った`が0件になるだけで、
   * `#failedWorkerNotificationsThisTurn`（下）自体は減らない。
   *
   * `failedReportText`（`runner.ts`）はこの値が1以上のときだけ、状況証拠の
   * 行を「作業者が N 体、失敗で終わった」の行へ差し替える。**これも判定では
   * ない**——`#workerRejectionsThisTurn` と同じく「本体は当たっていない」とは
   * 言わない。
   */
  #failedWorkerNotificationsThisTurn = 0;

  /** `#failedWorkerNotificationsThisTurn` のうち、要旨が枠(429)を名乗っていた件数。 */
  #failedWorkerNotificationsNamingLimitThisTurn = 0;

  /**
   * `UserPromptSubmit` の `source` ごとの件数（`result` で畳む）。
   *
   * **取れた分だけ載せる。** 取れない回に `'unknown': 1` のような行を作らない
   * （AGENTS.md 地雷「取れない軸に0の行を作る」）。
   *
   * `sources` が何を答え、何を答えないか（`system` が3つを畳んでいる・
   * 「付かない」が「必ず付かない」から「付かないこともある」へ変わった経緯・
   * SDK 0.3.239 の JSDoc の逐語）は、切り出しにあたり要約していない全文が
   * `runner.ts` の履歴（`git log -p -- packages/core/src/runner.ts` で
   * `#submitSources` を検索）に残る——ここでは繰り返さない（要約はしない、
   * という north_star 禁止2をここでも適用する。全文は移した先ではなく元の
   * 履歴のほうに置く判断は、この移設が「読める分量を減らさない」ことを
   * git 側の記録で保証する形である）。
   */
  #submitSources = new Map<string, number>();

  /** `#said` に積んだ本文が1件以上あるか。`#flushUnreported` の入口判定用。 */
  get hasSaid(): boolean {
    return this.#said.length > 0;
  }

  /**
   * `text`（マネージャー自身の発言本文）を積み、それを運んできた assistant
   * メッセージの `uuid` を控える（`RunnerSession#apply` の
   * `case 'assistant_message'` から、`said.length > 0` のときだけ呼ぶ）。
   */
  recordSaid(text: string, uuid: string | undefined): void {
    this.#said.push(text);
    this.#saidUuid = uuid;
  }

  /**
   * SDK が「これは応答ではない」と印を付けた事実を控える（`RunnerSession#apply`
   * の `case 'assistant_message'` から、`rejected !== undefined` のときだけ
   * 呼ぶ）。
   */
  setRejected(rejected: SdkFailure): void {
    this.#rejected = rejected;
  }

  /** `#inputStream` が入力を1件消費した回に呼ぶ。 */
  incrementInputsSinceResult(): void {
    this.#inputsSinceResult += 1;
  }

  /** `task_notification` を受けた回に呼ぶ（`RunnerSession#onTaskNotification`）。 */
  incrementNotificationsSinceResult(): void {
    this.#notificationsSinceResult += 1;
  }

  /**
   * マネージャー自身の道具が動いた回に呼ぶ（`RunnerSession#onPostToolUse` /
   * `#onPostToolUseFailure` から、`hook.agent_id === undefined` のときだけ）。
   */
  incrementToolsSinceResult(): void {
    this.#toolsSinceResult += 1;
  }

  /**
   * `UserPromptSubmit` がマネージャー自身に発火した回に呼ぶ
   * （`RunnerSession#onUserPromptSubmit` から、`hook.agent_id === undefined`
   * のときだけ）。
   */
  incrementSubmitsSinceResult(): void {
    this.#submitsSinceResult += 1;
  }

  /** `UserPromptSubmit` の `source` を1件足す（取れたときだけ呼ぶ）。 */
  recordSubmitSource(source: string): void {
    this.#submitSources.set(source, (this.#submitSources.get(source) ?? 0) + 1);
  }

  /** このターンで `taskId` の作業者が開いたことを控える（同じ id は2度数えない）。 */
  addOpenedWorker(taskId: string): void {
    this.#openedWorkersThisTurn.add(taskId);
  }

  /** 作業者の発言に付いた拒否の印（`errorCode`）を1件足す。 */
  pushWorkerRejection(code: string): void {
    this.#workerRejectionsThisTurn.push(code);
  }

  /**
   * `task_notification` が `status: 'failed'` で終わった回に呼ぶ
   * （`RunnerSession#onTaskNotification`）。`limitNamed` はその要旨
   * （`summary`）が枠(429)を名乗っていたか（`classifyUsageNotice` で判定した
   * 結果を渡す——ここでは文言を見ない）。
   */
  recordFailedWorkerNotification(limitNamed: boolean): void {
    this.#failedWorkerNotificationsThisTurn += 1;
    if (limitNamed) this.#failedWorkerNotificationsNamingLimitThisTurn += 1;
  }

  /**
   * `result` を受け取った回（`#apply` の `case 'turn_ended'`）が呼ぶ、
   * **12フィールド全部**を読み出して同じ場で畳む操作。呼び出し元は
   * この中で `await` を挟まない——読み出しと初期化の間に他のイベントが
   * 割り込んで、畳んでいる最中の値を書き換える余地を作らないためである
   * （クラス冒頭の doc「畳む場所が3つ」を見よ）。
   *
   * `said` / `rejected` は{@link RunnerTurnTally.takeSaid} と同じ区切りで
   * （ただし `reportId` は返さない——`turn_ended` は `event.id` を別に持って
   * いるので使わない）。残り10本は `worker_wait` の集計とターン失敗時の本文
   * （`failedReportText`）の材料になる。
   */
  takeAtResult(): {
    said: string[];
    rejected: SdkFailure | null;
    inputsThisTurn: number;
    notificationsThisTurn: number;
    toolsThisTurn: number;
    submitsThisTurn: number;
    sourcesThisTurn: Map<string, number>;
    openedWorkersThisTurn: number;
    workerRejectionsThisTurn: string[];
    failedWorkerNotificationsThisTurn: number;
    failedWorkerNotificationsNamingLimitThisTurn: number;
  } {
    const said = this.#said;
    this.#said = [];
    this.#saidUuid = undefined;

    const rejected = this.#rejected;
    this.#rejected = null;

    const inputsThisTurn = this.#inputsSinceResult;
    const notificationsThisTurn = this.#notificationsSinceResult;
    const toolsThisTurn = this.#toolsSinceResult;
    const submitsThisTurn = this.#submitsSinceResult;
    const sourcesThisTurn = this.#submitSources;
    const openedWorkersThisTurn = this.#openedWorkersThisTurn.size;
    const workerRejectionsThisTurn = this.#workerRejectionsThisTurn;
    const failedWorkerNotificationsThisTurn = this.#failedWorkerNotificationsThisTurn;
    const failedWorkerNotificationsNamingLimitThisTurn =
      this.#failedWorkerNotificationsNamingLimitThisTurn;

    this.#inputsSinceResult = 0;
    this.#notificationsSinceResult = 0;
    this.#toolsSinceResult = 0;
    this.#submitsSinceResult = 0;
    this.#submitSources = new Map();
    this.#openedWorkersThisTurn = new Set();
    this.#workerRejectionsThisTurn = [];
    this.#failedWorkerNotificationsThisTurn = 0;
    this.#failedWorkerNotificationsNamingLimitThisTurn = 0;

    return {
      said,
      rejected,
      inputsThisTurn,
      notificationsThisTurn,
      toolsThisTurn,
      submitsThisTurn,
      sourcesThisTurn,
      openedWorkersThisTurn,
      workerRejectionsThisTurn,
      failedWorkerNotificationsThisTurn,
      failedWorkerNotificationsNamingLimitThisTurn,
    };
  }

  /**
   * `result` を受け取らないまま畳む回（`RunnerSession#flushUnreported`。#323）が
   * 呼ぶ、`said` と `saidUuid` の**2本だけ**を読み出して畳む操作。
   *
   * **呼び出し元は先に {@link RunnerTurnTally.hasSaid} で「積んだ本文が在るか」
   * を見てから呼ぶこと**（空なら報告を作らない、という判断は `RunnerSession`
   * 側が持つ）。
   *
   * `rejected` と残り10本には触れない——`#flushUnreported` の doc（`runner.ts`）
   * のとおり、`result` が来ていないこの経路では `rejected` を「失敗として
   * 終わった」の根拠にできないため読まない。
   */
  takeSaid(): { said: string[]; reportId: string | undefined } {
    const said = this.#said;
    this.#said = [];
    const reportId = this.#saidUuid;
    this.#saidUuid = undefined;
    return { said, reportId };
  }

  /**
   * 前のセッションへ戻れなかったときの後始末（`RunnerSession#recoverFromFailedResume`）
   * が呼ぶ、「このターンで開いた作業者」「作業者の拒否の印」「`task_notification`
   * が `status: 'failed'` で終わった件数（枠を名乗った件数を含む）」の
   * **3本だけ**を**読み出さずに**捨てる操作。
   *
   * **戻り値を返さない。** 前のセッションが開いていた委譲は次のセッションに
   * 一切引き継がれないので、値を読んでも使い道が無い——`RunnerSession#openTasks.clear()`
   * と同じ理由（`recoverFromFailedResume` 内のコメントを見よ）。残り9本には
   * 触れない——この経路が捨てるのはこの3本だけで、他の集計（`inputsSinceResult`
   * 等）は `turn_ended` の {@link RunnerTurnTally.takeAtResult} でしか畳まれない
   * （呼び出し順によっては、そちらが先に空へ畳んでいるので、ここでの捨て直しは
   * 事実上の空振りになることがある——クラス冒頭の doc を見よ）。
   *
   * **`#failedWorkerNotificationsThisTurn` / `#failedWorkerNotificationsNamingLimitThisTurn`
   * も同じ理由で持ち越さない（Issue #1373 続き）。** 前のセッションで届いた
   * `task_notification` は、そのセッションが死んだ後に届いたものであっても
   * 「次のセッションの最初のターン」の集計ではない。持ち越すと、前のセッションの
   * 委譲が原因の失敗が、作り直した後の無関係な失敗の本文に紛れ込む。
   */
  discardOpenedWorkersAndRejections(): void {
    this.#openedWorkersThisTurn = new Set();
    this.#workerRejectionsThisTurn = [];
    this.#failedWorkerNotificationsThisTurn = 0;
    this.#failedWorkerNotificationsNamingLimitThisTurn = 0;
  }
}
