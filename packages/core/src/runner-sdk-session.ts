import type { Query, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

import { RunnerFenceError, type RunnerLease } from './runner-protocol.js';
import type { JobStatus } from './schema.js';

/**
 * `RunnerSession`（`runner.ts`）が持っていた **「SDK セッションの生存」の
 * 状態15フィールド**を、独立の単位として切り出したもの（Issue #1190 案X）。
 * これで `RunnerSession` から出した束は7つ目になる（前例は PR #1359
 * `clone-notices.ts` / #1433 `runner-subagent-stop-state.ts` / #1523
 * `runner-turn-tally.ts` / #1551 `runner-cut-off-workers.ts` / #1550
 * `runner-resume-recovery.ts` / #1565 `runner-resume-state.ts` / #1581
 * `runner-worker-wait-window.ts`）。
 *
 * **前例と同じ形にそろえてある。** 新しいクラスは完全に private な状態の器
 * だけを持ち、`#emit`（実際に日誌へ書く口）にも、resume/seed の状態
 * （`RunnerResumeState`）にも、作業者を待つ窓（`RunnerWorkerWaitWindow`）にも、
 * 確認への応答（`#pending` / `#resolved` / `#denied`）にも一切触れない。
 * **日誌へ出すかどうか・note や `closed` を出すかどうかの判断・SDK セッションを
 * いつ開く／畳むかの判断は、これまでどおり `RunnerSession` が持つ。**
 *
 * ## 何を持っているか
 *
 * - **`#query` / `#reader` / `#generation`** —— いま生きている SDK セッション
 *   （器＝CLI プロセス）そのものと、その読み手ループ、世代番号。
 * - **`#stopped` / `#status`** —— このセッションが止められたか、いまの
 *   `JobStatus`。
 * - **`#transcriptPath`** —— 生ログの場所。
 * - **`#liveBackgroundTasks`** —— 起こしっぱなしの背景処理（REPLACE 意味論）。
 * - **`#unclassifiedFailures`** —— 分類できなかった失敗の帳面（Issue #393）。
 * - **`#fence` / `#leaseTtlMs`** —— fencing token と貸し出し期限。
 * - **`#recycleForToken` / `#endedInputForTokenRotation`** —— 認証トークンの
 *   畳み直しの意図と、実際に自分から閉じたという事実の印。
 * - **`#input` / `#inputWaiters`** —— マネージャーへの一言の待ち行列と、
 *   次の入力を待っている `#inputStream` の起こし待ち。
 * - **`#closing`** —— いま走っている畳み処理（`stop()` 自身・`#finish()` の
 *   どちらか）の Promise（Issue #1602 / #1605）。
 *
 * 15フィールドそれぞれの詳しい意味・不変・相互の関係は、元々 `runner.ts` の
 * フィールド宣言に付いていた doc から要点を保ったまま、下の各フィールド・
 * メソッドの doc へ移した。
 *
 * ## なぜ切り出したか、そして切り出しの限界（前例6本と同じ形の申告）
 *
 * **この節を読まずに「無駄な間接層だ」と思って `RunnerSession` へ戻さないこと。**
 *
 * 1. **束として孤立してはいない。** 15フィールドだけを触るメンバーは無く、
 *    `RunnerSession` 側の約25本のメンバー（`checkFence` / `push` / `state` /
 *    `stop` / `#stopBody` / `selfFence` / `recycleForToken` / `#open` /
 *    `#wakeInput` / `#inputStream` / `#atTokenRecycleBoundary` / `#read` /
 *    `#reopenForTokenRotation` / `#recoverFromFailedResume` の `#resumeRecoveryHost`
 *    literal の `teardownForRecreate` / `#apply` / `#observeContextUsage` /
 *    `#flushUsage` / `#finish` / `#finishBody` / `#onPermission` /
 *    `#onPostToolUse` / `#onPostToolUseFailure` / `#onPreCompact` /
 *    `#readTranscript` / `transcript`）に散っていた。**このクラスが持つのは
 *    状態と、その状態だけで完結する局所的な遷移だけである。**
 * 2. **畳みの順序はここに持ち込んでいない。** `stop()` の `#stopBody` と
 *    `#finish()` の `#finishBody` が畳む手順の並び・`#closing` を誰が待つか
 *    という判断は、すべて `RunnerSession` に残る（このクラスが持つのは
 *    「畳み中の1本の Promise を控えて、後から来た呼び出しがそれを待てるように
 *    する」という**下請けの機構**だけで、いつ・何を・どの順で畳むかは1文字も
 *    知らない）。**今日この経路が4回直っている**（#1592 / #1599 / #1604 /
 *    #1608）ことの直接の帰結として、ここは前例のどれより保守的に切ってある。
 * 3. **テストの分離は買えない。** resume・token-rotation・stop/finish の畳み・
 *    fence の黒箱テスト（`runner-stop.test.ts` / `runner-stop-finish-order.test.ts` /
 *    `runner-closed-system-error.test.ts` / `runner-fence.test.ts` /
 *    `runner-token-rotation.test.ts` 等）は、切り出しの前後で一体のまま
 *    `RunnerSession` を通して動く——ここで直接テストするのは、このクラス自身の
 *    状態遷移だけである。
 * 4. **挙動は1ビットも変えていない。** 呼び出し側（`RunnerSession`）の `await`
 *    の位置・操作の順序・分岐の条件は1つも動かしていない。{@link open} が
 *    「`#query` を先に代入してから `#reader` を代入する」という元の2行の
 *    順序を1回のメソッド呼び出しへ畳んでいるが、`#read`（呼び出し元が渡す
 *    `reader` の中身）は同期の前置きの中で `#query` を1文字も読まないので、
 *    観測できる違いは無い（PR 本文にこの判断の根拠を書く）。
 * 5. **`#onPermission` の中身は変えていない。** 拒否・確認まわりの判断は別の
 *    担当の領域（`AGENTS.md`）なので、`#status` の生の読み書きをこのクラスの
 *    {@link status} / {@link setStatus} 呼び出しへ置き換えただけである。
 *
 * 得られるのは「この状態の組み合わせは、この器の中だけで読めばよい」という
 * レビューのしやすさだけである（前例6本と同じ言い方）。
 */
export class RunnerSdkSession {
  // ---------------------------------------------------------------------
  // SDK セッション本体（`#query` / `#reader`）と世代番号
  // ---------------------------------------------------------------------

  /** いま開いている SDK クエリ（器＝CLI プロセス）。無ければ `null`。 */
  #query: Query | null = null;
  /** `#query` を読み続けている `#read` ループの Promise。無ければ `null`。 */
  #reader: Promise<void> | null = null;
  /**
   * 開いている入力ストリームの世代。
   *
   * resume に失敗して新しいセッションを開くと、前の `#inputStream` がまだ
   * 入力を待っている。世代を進めて畳まないと、新しいセッション宛の指示を
   * 死んだストリームが横取りする。
   */
  #generation = 0;

  get query(): Query | null {
    return this.#query;
  }

  get reader(): Promise<void> | null {
    return this.#reader;
  }

  get generation(): number {
    return this.#generation;
  }

  /**
   * 新しく開いた SDK セッションを控える（`RunnerSession#open` が呼ぶ）。
   *
   * **`#query` を先に、`#reader` を後に代入する元の2行を1回にまとめている。**
   * 間で `#read`（`reader` の中身）が同期的に走る箇所は無く、`#read` は
   * 自分の引数 `q` だけを見て `this.#query` を読まないので、まとめても
   * 観測できる違いは無い。
   */
  open(query: Query, reader: Promise<void>): void {
    this.#query = query;
    this.#reader = reader;
  }

  /**
   * いま開いている `#query` を閉じる（既に閉じていれば何もしない）。
   * `#query` / `#reader` の null 化はしない——`stop()` / `#finish()` の畳み
   * （`#stopBody` / `#finishBody`）は、閉じた後もこのセッションを破棄するだけで
   * 作り直さないので、null に戻す意味が無い（元のコードもそうしていた）。
   */
  closeQuery(): void {
    try {
      this.#query?.close();
    } catch {
      // 既に閉じている
    }
  }

  /**
   * 作り直しのために、いまの SDK セッションを畳む（`#reopenForTokenRotation` /
   * `ResumeRecoveryHost.teardownForRecreate` の2箇所が、以前はまったく同じ
   * 4行 —— `#generation += 1;` → `#query?.close()`（try/catch）→
   * `#query = null;` → `#reader = null;` —— を重複して持っていた。ここへ1本化
   * した）。**世代を先に進めてから閉じる順序は変えていない。**
   */
  teardownForRecreate(): void {
    this.#generation += 1;
    this.closeQuery();
    this.#query = null;
    this.#reader = null;
  }

  // ---------------------------------------------------------------------
  // 停止フラグと JobStatus
  // ---------------------------------------------------------------------

  #stopped = false;
  #status: JobStatus = 'running';

  get stopped(): boolean {
    return this.#stopped;
  }

  /** `#stopped` を立てる。一度立てたら二度と下ろさない（元と同じ一方向の遷移）。 */
  markStopped(): void {
    this.#stopped = true;
  }

  get status(): JobStatus {
    return this.#status;
  }

  setStatus(status: JobStatus): void {
    this.#status = status;
  }

  // ---------------------------------------------------------------------
  // 生ログの場所
  // ---------------------------------------------------------------------

  #transcriptPath: string | undefined;

  get transcriptPath(): string | undefined {
    return this.#transcriptPath;
  }

  setTranscriptPath(path: string): void {
    this.#transcriptPath = path;
  }

  // ---------------------------------------------------------------------
  // 起こしっぱなしの背景処理
  // ---------------------------------------------------------------------

  /**
   * いま起こしっぱなしの背景処理（`agent-events.ts` の
   * `AgentBackgroundTasksEvent`）。**REPLACE 意味論**——SDK の JSDoc が
   * 「missed bookend cannot wedge a stale running indicator」と言っている
   * とおり、届いた `tasks` で丸ごと入れ替える。加算・削除の差分計算はしない。
   *
   * **空へ戻すのは「器（CLI プロセス）が本当に入れ替わったとき」だけ**——
   * 契機は `RunnerSession` 側が握っている（{@link resetLiveBackgroundTasks}
   * の呼び出し元のコメントを見よ）。ここは在り高を持つだけで、いつ空へ戻すかは
   * 判断しない。
   */
  #liveBackgroundTasks: readonly { id: string; taskType: string }[] = [];

  get liveBackgroundTasks(): readonly { id: string; taskType: string }[] {
    return this.#liveBackgroundTasks;
  }

  /** 器が入れ替わったときに呼ぶ（`#open` / `session_started` の保険）。 */
  resetLiveBackgroundTasks(): void {
    this.#liveBackgroundTasks = [];
  }

  /** `background_tasks` イベントの REPLACE 意味論そのもの。丸ごと入れ替える。 */
  replaceLiveBackgroundTasks(tasks: readonly { id: string; taskType: string }[]): void {
    this.#liveBackgroundTasks = tasks;
  }

  // ---------------------------------------------------------------------
  // 分類できなかった失敗の帳面（Issue #393）
  // ---------------------------------------------------------------------

  /**
   * SDK が失敗として出したのに、枠の文言としては分類できなかった回の帳面
   * （Issue #393。`種別 → 件数`）。**セッション1本ぶんである。**
   *
   * **これは計器であって、何も分岐させない。** `noteUnclassifiedFailure` /
   * `noteUnclassifiedFailuresSummary`（`dropped-record.ts`）が直接この Map を
   * 読み書きするので、ここは生の Map をそのまま渡すだけの器である。
   */
  readonly #unclassifiedFailures = new Map<string, number>();

  get unclassifiedFailures(): Map<string, number> {
    return this.#unclassifiedFailures;
  }

  // ---------------------------------------------------------------------
  // fencing token と貸し出し期限
  // ---------------------------------------------------------------------

  /**
   * 最後に受け取った世代番号（fencing token）。
   *
   * **`undefined` は「まだ lease を伴わずに起こされた」ことを表す。** そのときは
   * 判定しない（`lease.ts` の `undecidable` と同じ形——材料が無いことを
   * 「古くない」と読まない。ただし判定しない以上、拒む理由も無いので実質は
   * 「常に受ける」になる）。
   */
  #fence: number | undefined;
  /** いまの貸し出し期限（ミリ秒）。`Host` の自己失効の見張りが読む。 */
  #leaseTtlMs: number | undefined;

  get leaseTtlMs(): number | undefined {
    return this.#leaseTtlMs;
  }

  /**
   * `RunnerSession#checkFence` の中身（roadmap M5 PR4）。前回覚えた世代と
   * 比べる。古ければ `RunnerFenceError` を投げて**このセッションには一切
   * 触れない**——ここより後で、呼び出し元は何も書き換えない。同じ値は再送と
   * して受ける（更新も拒否もしない）。**新しい値**はここで覚え直すだけで、
   * セッションを作り直す判断はここには無い。
   *
   * `managerId` はエラーメッセージのためだけに受け取る——このクラス自身は
   * 「どのマネージャーか」を持たない。
   */
  checkFence(lease: RunnerLease | undefined, managerId: string): void {
    if (lease === undefined) return;
    if (this.#fence !== undefined && lease.fence < this.#fence) {
      throw new RunnerFenceError({
        managerId,
        expected: this.#fence,
        given: lease.fence,
      });
    }
    this.#fence = lease.fence;
    this.#leaseTtlMs = lease.ttlMs;
  }

  // ---------------------------------------------------------------------
  // 認証トークンの畳み直し
  // ---------------------------------------------------------------------

  /**
   * 認証トークンが差し替わったので、次のターンの境界で SDK セッションを畳んで
   * 開き直す意図。**印だけを持つ。** 立てた時点ではセッションに触らない——
   * 触ると、そのとき走っていたターンを殺すか、失敗として報告するかのどちらか
   * になる（`clone.ts` の `#recycleForToken` の doc と同じ理由）。
   *
   * **畳んでよいのは境界条件（`RunnerSession#atTokenRecycleBoundary`）が
   * 真を返すときだけ。** 1つでも条件が欠けていれば、この印を立てたまま
   * 次の境界まで待つ（下ろさない）。
   */
  #recycleForToken = false;

  /**
   * **`#inputStream` が、まさにいま `recycleForToken` の意図に基づいて
   * 自分から入力ストリームを終えた**、という事実の印。
   *
   * **`#recycleForToken`（「畳みたい」という意図）とは意味が違う。** `#read` は
   * `for await` が正常終了した理由を、こちらの印**だけ**で判定する——
   * 「自分から閉じた」(a) と「SDK が自分の理由で閉じた」(b) は、どちらも
   * `for await` の正常終了として同じ形で観測されるが、(a) のときだけ
   * 開き直りへ進んでよい。
   */
  #endedInputForTokenRotation = false;

  /** `RunnerSession#recycleForToken`（`Host#setCredentials` から呼ばれる）が立てる。 */
  requestTokenRecycle(): void {
    this.#recycleForToken = true;
  }

  get wantsTokenRecycle(): boolean {
    return this.#recycleForToken;
  }

  /**
   * `#inputStream` が境界条件（`RunnerSession#atTokenRecycleBoundary`）を
   * 認めたとき呼ぶ。**`#recycleForToken` を下ろすのと `#endedInputForTokenRotation`
   * を立てるのは、同じ1回の呼び出しの中の2つの代入のまま**——順序（下ろして
   * から立てる）も含め、元の2行をそのまま持つ。
   */
  consumeTokenRecycleAtBoundary(): void {
    this.#recycleForToken = false;
    this.#endedInputForTokenRotation = true;
  }

  /**
   * `#endedInputForTokenRotation` を読み出し、同時に false へ戻す
   * （`RunnerSession#read` の `if (flag) { flag = false; ... }` という元の形を
   * 1回の呼び出しへ畳んだだけ——false のときに戻しても代入は無害なので、
   * 呼び出し側の分岐の意味は変わらない）。
   */
  takeEndedForTokenRotation(): boolean {
    const ended = this.#endedInputForTokenRotation;
    this.#endedInputForTokenRotation = false;
    return ended;
  }

  // ---------------------------------------------------------------------
  // マネージャーへの一言の待ち行列と、次の入力を待つ側の起こし待ち
  // ---------------------------------------------------------------------

  readonly #input: SDKUserMessage[] = [];
  readonly #inputWaiters = new Set<() => void>();

  /** `RunnerSession#push` が呼ぶ。待ち行列の末尾へ積む。 */
  enqueueInput(message: SDKUserMessage): void {
    this.#input.push(message);
  }

  /** `#inputStream` が呼ぶ。先頭から1件取り出す（無ければ `undefined`）。 */
  dequeueInput(): SDKUserMessage | undefined {
    return this.#input.shift();
  }

  /**
   * 作り直しで前の器へ向けた入力を持ち越すため、待ち行列を空にしながら
   * 中身を丸ごと返す（`ResumeRecoveryHost.teardownForRecreate` が呼ぶ）。
   */
  drainInput(): SDKUserMessage[] {
    return this.#input.splice(0);
  }

  /**
   * 次の入力が来るまで待つ（`#inputStream` が呼ぶ）。**`#wakeInput` が呼ばれる
   * まで解決しない。** 待ち手を `#inputWaiters` へ積むだけの薄い口——起こす側
   * （{@link wakeInput}）と対になる。
   */
  waitForInput(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.#inputWaiters.add(resolve);
    });
  }

  /** 待っている全員を起こす（待ち行列は空にする）。 */
  wakeInput(): void {
    const waiters = [...this.#inputWaiters];
    this.#inputWaiters.clear();
    for (const waiter of waiters) waiter();
  }

  // ---------------------------------------------------------------------
  // 走っている畳み処理の Promise（Issue #1602 / #1605）
  // ---------------------------------------------------------------------

  /**
   * 走っている畳み処理の Promise。畳む手続きは `RunnerSession` に2本ある——
   * `stop()` 自身（中身は `#stopBody`）と、自然終了・resume 失敗などが呼ぶ
   * `#finish()`（中身は `#finishBody`）。どちらも、走り始めた直後にここへ
   * 自分の Promise を控える。
   *
   * `stop()` の入口（`#stopped` が既に立っている側の分岐）はこれを await
   * してから返る——「畳み中のものが `#finish()` 由来でも `stop()` 自身の畳み
   * 由来でも、`stop()` が戻った＝畳み終わった」という約束を、どちらが走って
   * いても・何本重なっても保つためである（詳しい経緯は `runner.ts` の
   * `stop()` の doc を見よ——**このクラスは「いつ・何を畳むか」を1文字も
   * 知らない**）。
   */
  #closing: Promise<void> | null = null;

  get closing(): Promise<void> | null {
    return this.#closing;
  }

  /**
   * `run()` が返す Promise を「走っている畳み処理」として控え、待ち、
   * 終わったら（自分が控えたものであれば）消す。`stop()` と `#finish()` が
   * 以前それぞれ持っていた、まったく同じ3行（控える → await → 自分の
   * ものだけ finally で消す）を1本化したもの。**`run` の中身（畳む順序・
   * 何を呼ぶか）は一切知らない**——`RunnerSession` が渡す関数がそれを持つ。
   */
  async trackClosing(run: () => Promise<void>): Promise<void> {
    const promise = run();
    this.#closing = promise;
    try {
      await promise;
    } finally {
      // **自分が控えた Promise のときだけ消す。** 後から始まった畳みが
      // `#closing` を握っている間に、先に始まっていた呼び出しの finally が
      // それを消してしまわないようにする。
      if (this.#closing === promise) this.#closing = null;
    }
  }
}
