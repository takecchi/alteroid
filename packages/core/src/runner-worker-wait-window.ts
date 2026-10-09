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
  readonly sources?: Record<string, number>;
  readonly settled: boolean;
}

export class RunnerWorkerWaitWindow {
  // 絞らない: `task_type` で絞る判断は呼び出し側（`RunnerSession#onTaskStarted`）に集約してある。
  #openTasks = new Set<string>();

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

  // `#openTasks` が空になった瞬間に閉じない: 最後の完了通知を契機に回ったターンを数え落とす。
  #windowClosing = false;

  taskStarted(taskId: string): void {
    if (this.#openTasks.size === 0 && this.#window !== null) {
      // 開き直さない: 閉じていない集計を上書きして消す。
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

  // 対応の無い通知では閉じ待ちを立てない: 作業者ではないタスクの通知が日常的に来る。
  notified(taskId: string | undefined): void {
    const had = taskId !== undefined && this.#openTasks.delete(taskId);
    if (had && this.#openTasks.size === 0) this.#windowClosing = true;
  }

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
    if (this.#windowClosing) return this.close();
    return null;
  }

  // `#openTasks` を変えない: 先に {@link clear} すると `settled` が常に `true` になる。
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

  // {@link close} の後に呼ぶ: 持ち越すと二度と来ない `task_notification` を待って区間が閉じない。
  clear(): void {
    this.#openTasks.clear();
  }
}
