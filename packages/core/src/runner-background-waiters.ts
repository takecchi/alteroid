/**
 * 「`liveBackgroundTasks` に載っていない」だけでは終わったとしない: `background_tasks_changed` の `task_id` が
 * フックの `background_tasks[].id` と同じ id 空間かはライブで確かめていない。違えば「載っていない」は常に真になり、
 * 待たずに毎回起こし直す空転が無限に続く。載っていたのを見てからでないと終わりにせず、見られなければ通知か時間の上限に任せる。
 */

export type BackgroundWaitOutcome = 'settled' | 'timeout' | 'released';

const FINISHED_TASK_LIMIT = 500;

interface Waiter {
  readonly check: () => boolean;
  readonly resolve: (outcome: BackgroundWaitOutcome) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

export class RunnerBackgroundWaiters {
  readonly #waiters = new Set<Waiter>();

  readonly #finished = new Map<string, string | null>();

  isFinished(taskId: string): boolean {
    return this.#finished.has(taskId);
  }

  outputFileOf(taskId: string): string | null {
    return this.#finished.get(taskId) ?? null;
  }

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

  recheck(): void {
    // `check` が投げた待ちは `released` で解く: 起こし直さずに返す側へ倒す。
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

  releaseAll(): void {
    for (const waiter of [...this.#waiters]) this.#settle(waiter, 'released');
  }

  get waitingCount(): number {
    return this.#waiters.size;
  }

  #settle(waiter: Waiter, outcome: BackgroundWaitOutcome): void {
    if (!this.#waiters.delete(waiter)) return;
    clearTimeout(waiter.timer);
    waiter.resolve(outcome);
  }
}
