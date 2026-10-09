import type { SdkFailure } from './sdk-failure.js';

/**
 * 畳む場所が3つあり、それぞれ畳む範囲が違う（`takeAtResult` は全12フィールド、`takeSaid` は `said` と `uuid` だけ、
 * `discardOpenedWorkersAndRejections` は作業者の3本を読まずに捨てる）。1本へ統合しない: 統合すると、
 * 畳まなくていいフィールドまで畳まれるか、畳みたいフィールドが畳まれない呼び出し元が出るから。
 */
export class RunnerTurnTally {
  /**
   * 報告を `result` 1本から作らない: `result` はターンの最後の一片で、道具を挟むたびに本文は切れる。
   * 渡すと末尾だけが届き、欠けていることが誰にも見えない（north_star 禁止1）。
   */
  #said: string[] = [];

  /**
   * `result` が来ないまま畳む回には `reportId` に使う SDK の id が無い。`randomUUID()` を振らず、
   * 同じ本文を運んだ assistant メッセージの id を使う（再送しても同じ値になる）。`#said` と同じ区切りで畳む。
   */
  #saidUuid: string | undefined;

  /**
   * `takeSaid` では読まない: `result` が来ていない経路では「失敗として終わった」と名乗れないため。
   */
  #rejected: SdkFailure | null = null;

  #inputsSinceResult = 0;

  #notificationsSinceResult = 0;

  /**
   * 作業者の道具は数えない: 混ぜると「マネージャーは何もしていないターン」の再現条件が消える。
   */
  #toolsSinceResult = 0;

  #submitsSinceResult = 0;

  /**
   * `task_type` を名乗らない provider の `task_started` は区別が付かず作業者として数える
   * （取りこぼすより多く数える向き）。「N 体開いていた」は状況証拠であって確定の人数ではない。
   */
  #openedWorkersThisTurn = new Set<string>();

  /**
   * ターンの失敗にはしない: 本体の `#rejected` へ入れない。作業者が1体枠に当たっても本体は立て直して進めることがある。
   * 「本体は当たっていない」とも言えない。構造化した `failure` 欄にも足さない（台帳と公開 API の形が変わる）。
   */
  #workerRejectionsThisTurn: string[] = [];

  /**
   * `#workerRejectionsThisTurn` とは経路が別: 枠で打ち切られた作業者のエラーメッセージは親へ返す履歴から除かれうる。
   * 枠(429)の判定は `classifyUsageNotice` を使い、自前の正規表現は書かない（腐ると「検知しなくなる」ため）。
   */
  #failedWorkerNotificationsThisTurn = new Map<string, boolean>();

  /** `taskId` が無い通知は重複を除けないので、1件ずつ別の鍵で数える。 */
  #failedWorkerNotificationsWithoutTaskId = 0;

  /** 取れない回に `'unknown': 1` のような行を作らない（AGENTS.md 地雷「取れない軸に0の行を作る」）。 */
  #submitSources = new Map<string, number>();

  get hasSaid(): boolean {
    return this.#said.length > 0;
  }

  recordSaid(text: string, uuid: string | undefined): void {
    this.#said.push(text);
    this.#saidUuid = uuid;
  }

  setRejected(rejected: SdkFailure): void {
    this.#rejected = rejected;
  }

  incrementInputsSinceResult(): void {
    this.#inputsSinceResult += 1;
  }

  incrementNotificationsSinceResult(): void {
    this.#notificationsSinceResult += 1;
  }

  incrementToolsSinceResult(): void {
    this.#toolsSinceResult += 1;
  }

  incrementSubmitsSinceResult(): void {
    this.#submitsSinceResult += 1;
  }

  recordSubmitSource(source: string): void {
    this.#submitSources.set(source, (this.#submitSources.get(source) ?? 0) + 1);
  }

  addOpenedWorker(taskId: string): void {
    this.#openedWorkersThisTurn.add(taskId);
  }

  pushWorkerRejection(code: string): void {
    this.#workerRejectionsThisTurn.push(code);
  }

  recordFailedWorkerNotification(taskId: string | undefined, limitNamed: boolean): void {
    const key =
      taskId ?? `\u0000no-task-id-${String((this.#failedWorkerNotificationsWithoutTaskId += 1))}`;
    this.#failedWorkerNotificationsThisTurn.set(
      key,
      (this.#failedWorkerNotificationsThisTurn.get(key) ?? false) || limitNamed,
    );
  }

  /**
   * 呼び出し元はこの中で `await` を挟まない: 読み出しと初期化の間に他のイベントが割り込む余地を作らないため。
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
    const failedWorkerNotificationsThisTurn = this.#failedWorkerNotificationsThisTurn.size;
    const failedWorkerNotificationsNamingLimitThisTurn = [
      ...this.#failedWorkerNotificationsThisTurn.values(),
    ].filter(Boolean).length;

    this.#inputsSinceResult = 0;
    this.#notificationsSinceResult = 0;
    this.#toolsSinceResult = 0;
    this.#submitsSinceResult = 0;
    this.#submitSources = new Map();
    this.#openedWorkersThisTurn = new Set();
    this.#workerRejectionsThisTurn = [];
    this.#failedWorkerNotificationsThisTurn = new Map();
    this.#failedWorkerNotificationsWithoutTaskId = 0;

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

  /** `rejected` には触れない: `result` が来ていない経路では「失敗として終わった」の根拠にできない。 */
  takeSaid(): { said: string[]; reportId: string | undefined } {
    const said = this.#said;
    this.#said = [];
    const reportId = this.#saidUuid;
    this.#saidUuid = undefined;
    return { said, reportId };
  }

  /**
   * 読まずに捨てる: 前のセッションの委譲は次のセッションに引き継がれず、持ち越すと
   * 前の委譲が原因の失敗が、作り直した後の無関係な失敗の本文に紛れ込む。
   */
  discardOpenedWorkersAndRejections(): void {
    this.#openedWorkersThisTurn = new Set();
    this.#workerRejectionsThisTurn = [];
    this.#failedWorkerNotificationsThisTurn = new Map();
    this.#failedWorkerNotificationsWithoutTaskId = 0;
  }
}
