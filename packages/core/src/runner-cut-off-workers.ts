/**
 * `RunnerSession` へ戻さない: 5本のメンバーのうちこの状態だけを触るのは2本で、残りは `#emit` など
 * `RunnerSession` の他の状態も触る。ここは `#emit` に触れない純粋な状態の器にしてある。
 */
export class RunnerCutOffWorkers {
  /**
   * 背景処理の待ちの上限（30分）で打ち切った作業者の `agent_id`。注記したら消す（1回だけ）。
   * 同期の `Task` だけがここを通る。`async_launched` の完了は `PostToolUse` を経由せず
   * `task_notification` としてだけ届くので、`consumeCutOff` で消して `#pendingCutOffNotifications` へ付け替える。
   */
  readonly #cutOffWorkers = new Set<string>();

  /**
   * `task_notification` 経由で打ち切りと判明したが、まだ注記していない作業者の `agent_id`。
   *
   * `task_notification` に `additionalContext` を注げるフックは SDK に無い
   * （`TaskCompleted` / `TaskCreated` は別機能）ので、次にマネージャー自身の道具が
   * `PostToolUse` を通ったときに相乗りする。`push()` は使わない: 作業者の完了を契機に呼ぶと
   * SDK の自己継続と二重にターンが回る。配達はマネージャーが次に道具を呼ぶまで遅れる。
   */
  readonly #pendingCutOffNotifications = new Set<string>();

  /** 消費しない。`#cutOffWorkers` が尽きた後に届く背景処理の完了を、打ち切った作業者に結ぶために残す。 */
  readonly #cutOffAgentIds = new Set<string>();

  readonly #cutOffTasks = new Map<string, readonly CutOffBackgroundTaskSummary[]>();

  readonly #pendingBackgroundTaskOutputs: PendingBackgroundTaskOutput[] = [];

  recordCutOff(agentId: string, tasks: readonly CutOffBackgroundTaskSummary[] = []): void {
    // delete してから add する: Set は add だけでは既存の鍵の挿入順を動かさない。
    this.#cutOffWorkers.delete(agentId);
    this.#cutOffWorkers.add(agentId);
    while (this.#cutOffWorkers.size > CUT_OFF_WORKERS_LIMIT) {
      const oldest = this.#cutOffWorkers.values().next().value;
      if (oldest === undefined) break;
      this.#cutOffWorkers.delete(oldest);
    }

    this.#cutOffAgentIds.delete(agentId);
    this.#cutOffAgentIds.add(agentId);
    this.#cutOffTasks.delete(agentId);
    this.#cutOffTasks.set(agentId, tasks);
    while (this.#cutOffAgentIds.size > CUT_OFF_AGENT_TASKS_LIMIT) {
      const oldest = this.#cutOffAgentIds.values().next().value;
      if (oldest === undefined) break;
      this.#cutOffAgentIds.delete(oldest);
      this.#cutOffTasks.delete(oldest);
    }
  }

  isCutOff(agentId: string): boolean {
    return this.#cutOffAgentIds.has(agentId);
  }

  cutOffTasks(agentId: string): readonly CutOffBackgroundTaskSummary[] {
    return this.#cutOffTasks.get(agentId) ?? [];
  }

  recordPendingBackgroundTaskOutput(item: PendingBackgroundTaskOutput): void {
    this.#pendingBackgroundTaskOutputs.push(item);
    while (this.#pendingBackgroundTaskOutputs.length > PENDING_BACKGROUND_TASK_OUTPUT_LIMIT) {
      this.#pendingBackgroundTaskOutputs.shift();
    }
  }

  drainPendingBackgroundTaskOutputs(): PendingBackgroundTaskOutput[] {
    if (this.#pendingBackgroundTaskOutputs.length === 0) return [];
    const items = [...this.#pendingBackgroundTaskOutputs];
    this.#pendingBackgroundTaskOutputs.length = 0;
    return items;
  }

  consumeCutOff(agentId: string): boolean {
    return this.#cutOffWorkers.delete(agentId);
  }

  recordPendingNotification(agentId: string): void {
    this.#pendingCutOffNotifications.delete(agentId);
    this.#pendingCutOffNotifications.add(agentId);
    while (this.#pendingCutOffNotifications.size > PENDING_CUT_OFF_NOTIFICATIONS_LIMIT) {
      const oldest = this.#pendingCutOffNotifications.values().next().value;
      if (oldest === undefined) break;
      this.#pendingCutOffNotifications.delete(oldest);
    }
  }

  drainPendingNotifications(): string[] {
    if (this.#pendingCutOffNotifications.size === 0) return [];
    const agentIds = [...this.#pendingCutOffNotifications];
    this.#pendingCutOffNotifications.clear();
    return agentIds;
  }
}

export const CUT_OFF_WORKERS_LIMIT = 500;

export const PENDING_CUT_OFF_NOTIFICATIONS_LIMIT = 500;

/** `CUT_OFF_WORKERS_LIMIT` と値が同じでも共有しない: こちらは消費されず寿命が違い、片方の変更に巻き込まないため。 */
export const CUT_OFF_AGENT_TASKS_LIMIT = 500;

export const PENDING_BACKGROUND_TASK_OUTPUT_LIMIT = 500;

export interface CutOffBackgroundTaskSummary {
  readonly id: string;
  readonly command?: string;
}

export interface PendingBackgroundTaskOutput {
  readonly agentId: string;
  readonly taskId: string;
  readonly command?: string;
  /** 読めなかったときは `null`。作り物のパスを主張しない。 */
  readonly outputFile: string | null;
}
