/**
 * `RunnerSession`（`runner.ts`）が持っていた **作業者を待つ窓の状態3フィールド**
 * （`#openTasks` / `#window` / `#windowClosing`）を、独立の単位として切り出した
 * もの（Issue #1190 案X）。
 *
 * **前例は PR #1565（`runner-resume-state.ts`）・PR #1551
 * （`runner-cut-off-workers.ts`）・PR #1550（`runner-resume-recovery.ts`）・
 * PR #1523（`runner-turn-tally.ts`）——同じ形にそろえてある。** 新しいクラスは
 * 完全に private な状態の器だけを持ち、`#emit`（実際に `worker_wait` を日誌へ
 * 書く口）にも `#turnTally`（このターンの契機カウンタを持つ別の器）にも一切
 * 触れない。**`worker_wait` を出すかどうかの判断・`#turnTally.takeAtResult()`
 * の呼び出しは、これまでどおり `RunnerSession` が持つ。**
 *
 * **`#inputWaiters` はこの切り出しの対象外である。** 名前や役どころが紛らわしい
 * が、あれは入力ストリーム側の待ち手（`#wakeInput` / `#inputStream` が触る）
 * であって、この窓（委譲を待つ区間の集計）とは別の状態である。触っていない。
 *
 * ## 何を持っているか
 *
 * - **`#openTasks`** —— いま開いている委譲（Task）の `task_id` 集合
 *   （{@link RunnerWorkerWaitWindow.taskStarted} で追加、
 *   {@link RunnerWorkerWaitWindow.notified} で削除）
 * - **`#window`** —— 開いている委譲区間の集計（`worker_wait` イベントの材料。
 *   `sources` だけ `Map` で持つのは途中で加算し続けるため）
 * - **`#windowClosing`** —— `#openTasks` が空になったが、まだ閉じていない
 *   （最後の完了通知そのものを契機に回ったターンを数え落とさないよう、次の
 *   `turn_ended` でそのターンを数えてから閉じるための足場）
 *
 * 3フィールドの詳しい意味は、元々 `runner.ts` のフィールド宣言に付いていた doc
 * から1文字も削らずに下の各フィールドの doc へ移した。
 *
 * ## なぜ切り出したか、そして切り出しの限界（前例と同じ形の申告）
 *
 * **この節を読まずに「無駄な間接層だ」と思って `RunnerSession` へ戻さないこと。**
 *
 * 1. **束として孤立してはいない。** 3フィールドの生の読み書き（切る前は
 *    `grep -n '#openTasks\b\|#window\b\|#windowClosing\b'
 *    packages/core/src/runner.ts` で当たる）は、`RunnerSession` 側の4本の
 *    メンバー（`#onTaskStarted` / `#onTaskNotification` / `#apply` の
 *    `case 'turn_ended'` / `#closeWorkerWaitWindow`）と、`#resumeRecoveryHost`
 *    のプロパティ初期化子の中の `discardCarriedOverWork`（`ResumeRecoveryHost`
 *    ——PR #1550 案Zが先に切り出した口）に散っていた。**丸ごとは移さず、3
 *    フィールドへの生の読み書きの部分だけをこのクラスのメソッド呼び出しに
 *    置き換えた**——PR #1565 の `RunnerResumeState` と同じ形の切り分けである。
 * 2. **テストの分離は買えない。** `worker_wait` の黒箱テスト
 *    （`runner-wakeup.test.ts` / `runner-failure.test.ts` /
 *    `runner-resume-recreate-worker-count.test.ts` /
 *    `runner-post-tool-use-failure.test.ts` /
 *    `runner-post-tool-use-failure-resume.test.ts` /
 *    `runner-resume-recovery.test.ts` 等）は、切り出しの前後で一体のまま
 *    `RunnerSession` を通して動く——ここで直接テストするのは、このクラス自身の
 *    状態遷移だけである。
 * 3. **挙動は1ビットも変えていない。** 呼び出し側（`RunnerSession`）の `await`
 *    の位置・操作の順序・分岐の条件は1つも動かしていない。**唯一、形が変わって
 *    見えるのは `#onTaskNotification` である**——元は
 *
 *    ```
 *    const had = taskId !== undefined && this.#openTasks.delete(taskId);
 *    this.#turnTally.incrementNotificationsSinceResult();
 *    if (had && this.#openTasks.size === 0) this.#windowClosing = true;
 *    ```
 *
 *    という3行だったが、{@link RunnerWorkerWaitWindow.notified} は「削除する→
 *    1→0 の遷移なら閉じ待ちを立てる」の2行分を1回のメソッド呼び出しへまとめて
 *    おり、呼び出し側では
 *
 *    ```
 *    this.#workerWaitWindow.notified(taskId);
 *    this.#turnTally.incrementNotificationsSinceResult();
 *    ```
 *
 *    の順になる——**`#turnTally.incrementNotificationsSinceResult()` を呼ぶ
 *    位置が、削除より後ろから「削除＋閉じ待ち判定の両方より後ろ」へ動く。**
 *    この1点は安全だと判断した——`RunnerTurnTally` の通知カウンタと、この窓の
 *    `#openTasks`/`#windowClosing` は互いの値を読まない独立した状態で、
 *    どちらも同期（`await` を挟まない）なので、間に何を挟んでも最終状態は
 *    変わらない。PR #1565 の `observeSessionStarted`（「比較→代入」の2行を
 *    1回の呼び出しへまとめた）と同じ判断である。
 * 4. **`close()` と `clear()` の順序の約束はこの器の外にある。** 「**`close()`
 *    を先に、`clear()` を後に。**」（`runner-resume-recovery.ts` 冒頭の逐語。
 *    `grep -Fn -- '`close()` を先に、`clear()` を後に。' packages/core/src/runner-resume-recovery.ts`
 *    で当たる）は、`recoverFromFailedResume` が
 *    `host.closeWorkerWaitWindow()` → `host.discardCarriedOverWork()` の順に
 *    ハードコードしている箇所に在り、**この切り出しは1文字も触っていない**。
 *    このクラスは順序を自分では強制しない（できない——{@link close} と
 *    {@link clear} はそれぞれ独立に呼べる public メソッドである）。
 *    {@link close} 自身は `#openTasks` を1バイトも変えない——`settled` を
 *    導くために読むだけである。**先に {@link clear} を呼ぶと、{@link close}
 *    は `#openTasks` が既に空になった状態しか見られず、`settled` が常に
 *    `true` に化ける**（`runner-resume-recovery.ts` の同じ逐語が説明する事故
 *    そのもの）。呼び出し側（`RunnerSession` の
 *    `#resumeRecoveryHost.discardCarriedOverWork`）が、{@link close} の戻り値
 *    を読み終えた後で {@link clear} を呼ぶ、という順序を守ることに変わりはない
 *    ——守るのは引き続き呼び出し側の責任である。
 *
 * 得られるのは「この状態の組み合わせ（1→0 の遷移・閉じ待ちの取り消し・ターンの
 * 足し込み）は、この器の中だけで読めばよい」というレビューのしやすさだけである
 * （PR #1565 / #1551 / #1550 / #1523 と同じ言い方）。
 */

/**
 * `worker_wait` イベント（`runner-protocol.ts`）から `type` / `managerId` を
 * 除いた形——{@link RunnerWorkerWaitWindow.close} と
 * {@link RunnerWorkerWaitWindow.foldTurn} が窓を閉じたときに返す。`type` /
 * `managerId` を足して `#emit` するのは呼び出し側（`RunnerSession`）の仕事の
 * ままである。
 */
export interface WorkerWaitClosed {
  readonly openedAt: string;
  readonly tasks: number;
  readonly turns: number;
  readonly byCause: {
    readonly input: number;
    readonly notification: number;
    readonly continuation: number;
  };
  readonly toolless: number;
  readonly notifications: number;
  readonly submits: number;
  /** 取れた分だけ載せる。1件も取れなければフィールドごと省く（呼び出し側の `sources` の doc と同じ理由）。 */
  readonly sources?: Record<string, number>;
  readonly settled: boolean;
}

export class RunnerWorkerWaitWindow {
  /**
   * いま開いている作業者への委譲（Task）の `task_id` 集合。
   *
   * `task_started`（{@link taskStarted}）で追加、`task_notification`
   * （{@link notified}）で削除する。**`skip_transcript: true` の
   * `task_started`（SDK の JSDoc 曰く ambient = activity ではない task）も
   * 間引かずに数える** — 何を除外してよいかの判断を誰も持っていないので、
   * 数える側では絞らない。
   */
  #openTasks = new Set<string>();

  /**
   * いま開いている委譲区間（`worker_wait` の集計。`runner-protocol.ts` の
   * `worker_wait` イベントと同じ形で溜める。`sources` だけ `Map` にしてあるのは
   * 途中で加算し続けるため）。
   *
   * `#openTasks` が 0→1 になった瞬間に開く（{@link taskStarted}）。**閉じるのは
   * `#openTasks` が空になった瞬間ではない** — 最後の完了通知そのものを契機に
   * 回ったターン（実際に仕事をする回）を数え落とさないため、`#windowClosing`
   * を立てて次の `turn_ended`（{@link foldTurn}）でそのターンを数えてから閉じる
   * （{@link close}）。
   */
  #window: {
    openedAt: string;
    tasks: number;
    turns: number;
    byCause: { input: number; notification: number; continuation: number };
    toolless: number;
    notifications: number;
    submits: number;
    sources: Map<string, number>;
  } | null = null;

  /**
   * `#openTasks` が空になった。**その場では `#window` を閉じない。**
   *
   * 次の `turn_ended`（{@link foldTurn}）でそのターンを数えてから
   * {@link close} を呼ぶ。{@link taskStarted} が閉じ待ちの間に次の委譲が
   * 始まったのを見つけたら、閉じずに取り消す（同じ区間として続ける）。
   */
  #windowClosing = false;

  /**
   * `task_started`。`#openTasks` が 0→1 になった瞬間に区間を開く。
   *
   * **#1373: このターンで開いた作業者を別勘定で数える `RunnerTurnTally`
   * （`addOpenedWorker`）は、ここでは触らない** —— 呼び出し側
   * （`RunnerSession#onTaskStarted`）がこのメソッドと並べて呼ぶ。
   */
  taskStarted(taskId: string): void {
    if (this.#openTasks.size === 0 && this.#window !== null) {
      // 閉じ待ちの間に次の委譲が始まった。**同じ区間として続ける** — ここで
      // 新しい区間を開き直すと、閉じていない集計を上書きして消してしまう。
      this.#windowClosing = false;
    }
    const window =
      this.#window ??
      (this.#window = {
        openedAt: new Date().toISOString(),
        tasks: 0,
        turns: 0,
        byCause: { input: 0, notification: 0, continuation: 0 },
        toolless: 0,
        notifications: 0,
        submits: 0,
        sources: new Map(),
      });
    this.#openTasks.add(taskId);
    window.tasks += 1;
  }

  /**
   * `task_notification`。開いている委譲から1件外し、1→0 の遷移（全部片付いた）
   * なら閉じ待ちにする。
   *
   * **対応の無い通知（本来起きない想定だが防御的に見る）で誤って閉じ待ちを
   * 立てない。** `taskId` が `#openTasks` に無かった（または `undefined`）
   * ときは、1→0 の遷移が起きていないのでここでは何もしない——`notifications`
   * を数える・#901/#1554 の付け替えを行う判断は、これまでどおり呼び出し側
   * （`RunnerSession#onTaskNotification`）が持つ。
   */
  notified(taskId: string | undefined): void {
    const had = taskId !== undefined && this.#openTasks.delete(taskId);
    if (had && this.#openTasks.size === 0) this.#windowClosing = true;
  }

  /**
   * `turn_ended`。開いている区間へ、このターンの集計を足し込む。**`#window`
   * が null（委譲の外で起きたターン——人間・クローンと直接話しているだけの回）
   * なら何もせず `null` を返す。**
   *
   * `#turnTally.takeAtResult()` が畳んで返す値のうち、この窓が使う5本
   * （`inputsThisTurn` / `notificationsThisTurn` / `toolsThisTurn` /
   * `submitsThisTurn` / `sourcesThisTurn`）を受け取る——`takeAtResult()` の
   * 呼び出し自体は呼び出し側（`RunnerSession`）が持つ。
   *
   * **最後の完了通知そのものを契機に回ったこのターンを数え終えてから閉じる。**
   * `#windowClosing` が立っていれば、足し込んだ直後に {@link close} を呼んで
   * その戻り値をそのまま返す——呼び出し側はこれが非 `null` のときだけ
   * `worker_wait` を emit する。
   */
  foldTurn(input: {
    readonly inputsThisTurn: number;
    readonly notificationsThisTurn: number;
    readonly toolsThisTurn: number;
    readonly submitsThisTurn: number;
    readonly sourcesThisTurn: ReadonlyMap<string, number>;
  }): WorkerWaitClosed | null {
    const window = this.#window;
    if (window === null) return null;
    window.turns += 1;
    // **契機は排他で1件だけ数える。** 3つの合計が `turns` と必ず一致する
    // （`runner-wakeup.test.ts` がこの不変を固定する）。
    if (input.inputsThisTurn > 0) {
      window.byCause.input += 1;
    } else if (input.notificationsThisTurn > 0) {
      window.byCause.notification += 1;
    } else {
      window.byCause.continuation += 1;
    }
    if (input.toolsThisTurn === 0) window.toolless += 1;
    window.notifications += input.notificationsThisTurn;
    window.submits += input.submitsThisTurn;
    for (const [source, count] of input.sourcesThisTurn) {
      window.sources.set(source, (window.sources.get(source) ?? 0) + count);
    }
    // **`#openTasks` が空になった瞬間に閉じないのはこのためである**
    // （`#windowClosing` の doc）。`settled` は {@link close} の中で導く —
    // この時点で `#openTasks` は必ず空なので（`#windowClosing` はそのときにしか
    // 立たない）、中で導く `settled` は自動的に `true` になる。
    if (this.#windowClosing) return this.close();
    return null;
  }

  /**
   * 開いている委譲区間を1件ぶんの `worker_wait` の中身として組み立てて返し、
   * 空へ戻す。
   *
   * **`#window` が null なら何もしない（`null` を返す）。** `#finish` / `stop` /
   * 引き継ぎのどこから呼んでも安全に重ねられるようにするための無害化である。
   *
   * **`settled` はここで `#openTasks` の状態から導く。** `#openTasks.size ===
   * 0` は「呼ばれた時点で委譲した全員から通知を受け切っているか」をそのまま
   * 表すので、これを直接使う（呼び出し側の意図の言い換えを挟まない）。
   *
   * **`#openTasks` 自体はここでは1バイトも変えない。** クリアするのは
   * {@link clear} の役目——このクラスの doc 冒頭「順序の約束」を参照。
   *
   * `sources` は取れた分だけ載せる——`Map` が1件も無ければフィールドごと省く
   * （取れない軸に0の行を作らない。AGENTS.md 地雷）。
   */
  close(): WorkerWaitClosed | null {
    const window = this.#window;
    if (window === null) return null;
    const settled = this.#openTasks.size === 0;
    this.#window = null;
    this.#windowClosing = false;
    const sources = Object.fromEntries(window.sources);
    return {
      openedAt: window.openedAt,
      tasks: window.tasks,
      turns: window.turns,
      byCause: window.byCause,
      toolless: window.toolless,
      notifications: window.notifications,
      submits: window.submits,
      ...(Object.keys(sources).length > 0 ? { sources } : {}),
      settled,
    };
  }

  /**
   * 前のセッションが開いていた作業者の `task_id` を持ち越さない——新しい
   * セッション（か、この後の終了）は前のセッションが開いていた作業者の
   * `task_id` を一切知らない。持ち越すと、二度と来ない `task_notification` を
   * 待ち続けて区間が永久に閉じない。
   *
   * **必ず {@link close} の後に呼ぶこと。** このクラスの doc 冒頭「順序の
   * 約束」——このクラス自身は順序を強制しない（呼び出し側の責任のまま）。
   */
  clear(): void {
    this.#openTasks.clear();
  }
}
