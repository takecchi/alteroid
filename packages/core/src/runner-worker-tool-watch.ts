import type { RunnerEvent } from './runner-protocol.js';

/**
 * 作業者の道具が「長く実行中」と見なすまでの時間（ミリ秒、Issue #2725）。
 *
 * **地図の作業者の窓 `WORKER_RUNNING_WINDOW_MS`（30秒。`packages/logic`）より短くする。**
 * 作業者の札は「直前の道具の完了（日誌の `tool_use`）から30秒」で「実行中」になる。
 * 長い道具を始めてから窓が閉じるまでに `tool_running` が届いていれば、「実行中」が
 * 途切れずに続く（20秒 + 届くまでの遅れが、30秒に収まる）。30秒以上にすると、窓が
 * 閉じてから届くので、一瞬「待機」に落ちる。
 */
export const WORKER_TOOL_RUNNING_AFTER_MS = 20_000;

/** テストから時刻・タイマーを差し替える口（既定は本物）。 */
export interface WorkerToolWatchClock {
  now: () => number;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
}

const realClock: WorkerToolWatchClock = {
  now: () => Date.now(),
  setTimer: (fn, ms) => {
    const handle = setTimeout(fn, ms);
    // 見張りでプロセスの終了を引き延ばさない（既存のタイマーと同じ作法）。
    handle.unref?.();
    return handle;
  },
  clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

interface Watched {
  agentId: string;
  actor: string;
  tool: string;
  startedAt: number;
  timer: unknown;
  /** `tool_running` を送ったか。送った道具にだけ `tool_end` を送る。 */
  sent: boolean;
}

/**
 * 作業者の道具の開始を見張り、`WORKER_TOOL_RUNNING_AFTER_MS` を超えて未決のものだけ
 * `tool_running` / `tool_end` として知らせる（Issue #2725）。**日誌には書かない**
 * イベントである。20秒以内に決着した道具は何も送らない。
 */
export class WorkerToolWatch {
  readonly #managerId: string;
  readonly #emit: (event: RunnerEvent) => void;
  readonly #clock: WorkerToolWatchClock;
  readonly #byToolUseId = new Map<string, Watched>();

  constructor(
    managerId: string,
    emit: (event: RunnerEvent) => void,
    clock: WorkerToolWatchClock = realClock,
  ) {
    this.#managerId = managerId;
    this.#emit = emit;
    this.#clock = clock;
  }

  /** 作業者の道具の `PreToolUse`。 */
  begin(args: { agentId: string; actor: string; tool: string; toolUseId: string }): void {
    this.settle(args.toolUseId);
    const watched: Watched = {
      agentId: args.agentId,
      actor: args.actor,
      tool: args.tool,
      startedAt: this.#clock.now(),
      timer: undefined,
      sent: false,
    };
    watched.timer = this.#clock.setTimer(() => {
      watched.timer = undefined;
      if (this.#byToolUseId.get(args.toolUseId) !== watched) return;
      watched.sent = true;
      this.#emit({
        type: 'tool_running',
        managerId: this.#managerId,
        actor: watched.actor,
        tool: watched.tool,
        toolUseId: args.toolUseId,
        startedAt: new Date(watched.startedAt).toISOString(),
      });
    }, WORKER_TOOL_RUNNING_AFTER_MS);
    this.#byToolUseId.set(args.toolUseId, watched);
  }

  /** 決着（成功・失敗・拒否）。送った道具にだけ `tool_end` を送る。 */
  settle(toolUseId: string): void {
    const watched = this.#byToolUseId.get(toolUseId);
    if (watched === undefined) return;
    this.#byToolUseId.delete(toolUseId);
    if (watched.timer !== undefined) this.#clock.clearTimer(watched.timer);
    if (watched.sent) {
      this.#emit({ type: 'tool_end', managerId: this.#managerId, toolUseId });
    }
  }

  /** 作業者が終わった（`SubagentStop`）。その `agentId` の分を全部決着する。 */
  settleAgent(agentId: string): void {
    for (const [toolUseId, watched] of [...this.#byToolUseId]) {
      if (watched.agentId === agentId) this.settle(toolUseId);
    }
  }

  /** セッションの終わり。全部決着する。 */
  settleAll(): void {
    for (const toolUseId of [...this.#byToolUseId.keys()]) this.settle(toolUseId);
  }
}
