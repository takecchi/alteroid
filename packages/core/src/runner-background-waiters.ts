/**
 * `SubagentStop` のフックの中で、作業者が起こした背景処理の完了を待つ足場（Issue #3008）。
 *
 * ## 何のためにあるか
 *
 * 以前は、背景処理を残したまま畳もうとした作業者を、フックが**その場で**起こし直していた
 * （`additionalContext`）。完了していないので作業者は「待つ」と言って畳み、また起こされ、
 * 回数の上限（2 / 8）で打ち切られていた（#357 / #894）。**回数の上限は、実行回数で暴走を止める
 * 形の追加制限**（AGENTS.md の地雷「ターン数上限・実行回数上限で暴走を止める」）なので外し、
 * かわりに**フックの中で完了を待つ**。SDK は `SubagentStop` のフックの Promise を待つ
 * （待つ間、作業者のターンは進まない＝モデルを呼ばない。ただし実 SDK では未測）。
 *
 * ## 「終わった」の決め方（`isSettled` を呼び出し側が渡す。ここは待ちの器だけを持つ）
 *
 * 待つ対象は、フックの入力（`background_tasks`）に載っていた、**その作業者が起こした
 * running の背景処理の id** である（`#backgroundTaskOwners` と同じ id 空間。`PostToolUse` の
 * `backgroundTaskId` と `background_tasks[].id` が同じ値であることは #570 で実測済み）。
 * 各 id は、次のどちらかで「終わった」とする。
 *
 * 1. `task_notification`（`task_id`）が届いた。{@link noteFinished} が控える（出力の
 *    置き場所 `output_file` もここで控える）。**フックの発火より前に届いていてもよい。**
 * 2. `background_tasks_changed`（`liveBackgroundTasks`）に**載っているのを見たあとで、載らなく
 *    なった**。{@link RunnerBackgroundWaiters.wait} の `check` の中で呼び出し側が判定する。
 *
 * ⚠️ **「`liveBackgroundTasks` に載っていない」だけでは終わったとしない。** `background_tasks_changed`
 * の `task_id` がフックの `background_tasks[].id` と同じ id 空間かは、誰もライブで確かめていない
 * （`runner.ts` の `#renderSubagentStopTaskLines` 付近の doc）。違えば「載っていない」は常に真に
 * なり、**待たずに毎回起こし直す＝回数の上限を外した状態で空転が無限に続く。** 「載っていた」
 * ことを見てからでないと終わりにしない。載るのを見られなければ、通知（1.）か時間の上限に任せる。
 */

/** 待ちの結末。 */
export type BackgroundWaitOutcome = 'settled' | 'timeout' | 'released';

/** `task_notification` で終わりを見た背景処理の控えの件数の上限（FIFO）。 */
const FINISHED_TASK_LIMIT = 500;

interface Waiter {
  readonly check: () => boolean;
  readonly resolve: (outcome: BackgroundWaitOutcome) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

export class RunnerBackgroundWaiters {
  readonly #waiters = new Set<Waiter>();

  /** `task_notification` で終わりを見た背景処理の id → `output_file`（取れなければ `null`）。 */
  readonly #finished = new Map<string, string | null>();

  /** この id の `task_notification` が届いたか。 */
  isFinished(taskId: string): boolean {
    return this.#finished.has(taskId);
  }

  /** この id の `output_file`。届いていない・取れなかったときは `null`。 */
  outputFileOf(taskId: string): string | null {
    return this.#finished.get(taskId) ?? null;
  }

  /**
   * 背景処理 `taskId` の `task_notification` が届いたことを控え、待っている者の
   * 条件を見直す。
   */
  noteFinished(taskId: string, outputFile: string | null): void {
    this.#finished.delete(taskId);
    this.#finished.set(taskId, outputFile);
    while (this.#finished.size > FINISHED_TASK_LIMIT) {
      const oldest = this.#finished.keys().next();
      if (oldest.done === true) break;
      this.#finished.delete(oldest.value);
    }
    this.recheck();
  }

  /** `liveBackgroundTasks` が入れ替わったときなど、待っている者の条件を見直す。 */
  recheck(): void {
    // `check` が例外を投げても、他の待ちを巻き込まない・フックを宙に浮かせない
    // （投げた待ちは `released` として解く——起こし直さずに返す側へ倒す）。
    for (const waiter of [...this.#waiters]) {
      let settled: boolean;
      try {
        settled = waiter.check();
      } catch {
        this.#settle(waiter, 'released');
        continue;
      }
      if (settled) this.#settle(waiter, 'settled');
    }
  }

  /**
   * `check()` が真になるまで待つ。`timeoutMs` で `'timeout'`、{@link releaseAll} で `'released'`。
   * **呼んだ時点で既に真なら、待たずに `'settled'`。**
   */
  wait(check: () => boolean, timeoutMs: number): Promise<BackgroundWaitOutcome> {
    if (check()) return Promise.resolve('settled');
    return new Promise<BackgroundWaitOutcome>((resolve) => {
      const waiter: Waiter = {
        check,
        resolve,
        timer: setTimeout(() => this.#settle(waiter, 'timeout'), timeoutMs),
      };
      this.#waiters.add(waiter);
    });
  }

  /** 待っている者を全員、`'released'` で解く（セッションの stop / 畳み / 世代交代）。 */
  releaseAll(): void {
    for (const waiter of [...this.#waiters]) this.#settle(waiter, 'released');
  }

  /** いま待っている者の数（観測・テスト用）。 */
  get waitingCount(): number {
    return this.#waiters.size;
  }

  #settle(waiter: Waiter, outcome: BackgroundWaitOutcome): void {
    if (!this.#waiters.delete(waiter)) return;
    clearTimeout(waiter.timer);
    waiter.resolve(outcome);
  }
}
