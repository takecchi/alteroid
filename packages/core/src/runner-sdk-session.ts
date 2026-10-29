import type { AgentManagerSession, AgentUserInput } from './agent-session.js';
import { RunnerBackgroundWaiters } from './runner-background-waiters.js';
import { type RunnerLease } from './runner-protocol.js';
import type { JobStatus } from './schema.js';

export class RunnerSdkSession {
  #query: AgentManagerSession | null = null;
  #reader: Promise<void> | null = null;
  /**
   * resume に失敗して新しいセッションを開くと、前の `#inputStream` がまだ
   * 入力を待っている。世代を進めて畳まないと、新しいセッション宛の指示を
   * 死んだストリームが横取りする。
   */
  #generation = 0;

  get query(): AgentManagerSession | null {
    return this.#query;
  }

  get reader(): Promise<void> | null {
    return this.#reader;
  }

  get generation(): number {
    return this.#generation;
  }

  open(query: AgentManagerSession, reader: Promise<void>): void {
    this.#query = query;
    this.#reader = reader;
  }

  /** `#query` / `#reader` は null に戻さない（畳んだ後は破棄するだけで作り直さない）。 */
  closeQuery(): void {
    try {
      this.#query?.close();
    } catch {
      // 既に閉じている
    }
  }

  teardownForRecreate(): void {
    this.#generation += 1;
    this.#backgroundWaiters.releaseAll();
    this.closeQuery();
    this.#query = null;
    this.#reader = null;
  }

  #stopped = false;
  #status: JobStatus = 'running';

  get stopped(): boolean {
    return this.#stopped;
  }

  markStopped(): void {
    this.#stopped = true;
    this.#backgroundWaiters.releaseAll();
  }

  get status(): JobStatus {
    return this.#status;
  }

  setStatus(status: JobStatus): void {
    this.#status = status;
  }

  #transcriptPath: string | undefined;

  get transcriptPath(): string | undefined {
    return this.#transcriptPath;
  }

  setTranscriptPath(path: string): void {
    this.#transcriptPath = path;
  }

  /**
   * REPLACE 意味論: 届いた `tasks` で丸ごと入れ替える。差分計算しない
   * （取りこぼした終了通知で古い「実行中」表示が居座らないため）。
   */
  #liveBackgroundTasks: readonly { id: string; taskType: string }[] = [];

  get liveBackgroundTasks(): readonly { id: string; taskType: string }[] {
    return this.#liveBackgroundTasks;
  }

  resetLiveBackgroundTasks(): void {
    this.#liveBackgroundTasks = [];
  }

  replaceLiveBackgroundTasks(tasks: readonly { id: string; taskType: string }[]): void {
    this.#liveBackgroundTasks = tasks;
    this.#backgroundWaiters.recheck();
  }

  /**
   * セッションの寿命に結ぶ: `markStopped` / `teardownForRecreate` で待っている者を全員解く
   * （解かれた側は起こし直さずに返す）。
   */
  readonly #backgroundWaiters = new RunnerBackgroundWaiters();

  get backgroundWaiters(): RunnerBackgroundWaiters {
    return this.#backgroundWaiters;
  }

  /** 計器であって何も分岐させない。`dropped-record.ts` が生の Map を直接読み書きする。 */
  readonly #unclassifiedFailures = new Map<string, number>();

  get unclassifiedFailures(): Map<string, number> {
    return this.#unclassifiedFailures;
  }

  #leaseTtlMs: number | undefined;

  get leaseTtlMs(): number | undefined {
    return this.#leaseTtlMs;
  }

  /** 世代（fence）は比べない: 比べるのは Host の1か所だけ（#5514）。ここは自己失効が読む ttl を受け取るだけ。 */
  acceptLease(lease: RunnerLease | undefined): void {
    if (lease === undefined) return;
    this.#leaseTtlMs = lease.ttlMs;
  }

  /**
   * 印だけを持ち、立てた時点ではセッションに触らない: 触ると走っていたターンを
   * 殺すか失敗として報告することになる。境界条件が真になるまで下ろさない。
   */
  #recycleForToken = false;

  /**
   * `#recycleForToken`（畳みたい意図）とは別物。`#read` は `for await` の正常終了が
   * 「自分から閉じた」のか「SDK が自分の理由で閉じた」のかを、この印だけで判定する
   * （観測上は同じ形で、開き直してよいのは前者だけ）。
   */
  #endedInputForTokenRotation = false;

  /**
   * `#recycleForToken` のうち、Claude の鍵（プールが持つ資格）の指紋が変わった回だけに立つ印（#5021）。
   * `#recycleForToken` だけで「回転前の鍵で走っている」と言わない: `GH_TOKEN` の差し替えや peer の開閉でも立ち、そのときは鍵は同じため。
   */
  #onPreRotationClaudeKey = false;

  requestTokenRecycle(claudeKeyChanged = false): void {
    this.#recycleForToken = true;
    if (claudeKeyChanged) this.#onPreRotationClaudeKey = true;
  }

  get wantsTokenRecycle(): boolean {
    return this.#recycleForToken;
  }

  get onPreRotationClaudeKey(): boolean {
    return this.#onPreRotationClaudeKey;
  }

  /** 新しい CLI プロセスを起こす時点で下ろす: 起こすのはもう新しい env のもとのため（境界での開き直し以外の経路でも下ろす）。 */
  clearPreRotationClaudeKey(): void {
    this.#onPreRotationClaudeKey = false;
  }

  consumeTokenRecycleAtBoundary(): void {
    this.#recycleForToken = false;
    this.#endedInputForTokenRotation = true;
  }

  takeEndedForTokenRotation(): boolean {
    const ended = this.#endedInputForTokenRotation;
    this.#endedInputForTokenRotation = false;
    return ended;
  }

  readonly #input: AgentUserInput[] = [];
  readonly #inputWaiters = new Set<() => void>();

  enqueueInput(message: AgentUserInput): void {
    this.#input.push(message);
  }

  dequeueInput(): AgentUserInput | undefined {
    return this.#input.shift();
  }

  drainInput(): AgentUserInput[] {
    return this.#input.splice(0);
  }

  waitForInput(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.#inputWaiters.add(resolve);
    });
  }

  wakeInput(): void {
    const waiters = [...this.#inputWaiters];
    this.#inputWaiters.clear();
    for (const waiter of waiters) waiter();
  }

  /**
   * `stop()` と `#finish()` のどちらの畳みでも、`stop()` が戻ったら畳み終わっている
   * 約束を保つために、走っている畳みの Promise を控える。
   */
  #closing: Promise<void> | null = null;

  get closing(): Promise<void> | null {
    return this.#closing;
  }

  async trackClosing(run: () => Promise<void>): Promise<void> {
    const promise = run();
    this.#closing = promise;
    try {
      await promise;
    } finally {
      // 自分が控えた Promise のときだけ消す: 後から始まった畳みの `#closing` を消さないため。
      if (this.#closing === promise) this.#closing = null;
    }
  }
}
