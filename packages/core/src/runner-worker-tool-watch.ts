import type { RunnerEvent } from './runner-protocol.js';

/**
 * 地図の作業者の窓 `WORKER_RUNNING_WINDOW_MS`（30秒。`packages/logic`）より短くする:
 * 30秒以上にすると、窓が閉じてから `tool_running` が届き、一瞬「待機」に落ちる。
 */
export const WORKER_TOOL_RUNNING_AFTER_MS = 20_000;

export interface WorkerToolWatchClock {
  now: () => number;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
}

const realClock: WorkerToolWatchClock = {
  now: () => Date.now(),
  setTimer: (fn, ms) => {
    const handle = setTimeout(fn, ms);
    // 見張りでプロセスの終了を引き延ばさない。
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
  sent: boolean;
}

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

  settle(toolUseId: string): void {
    const watched = this.#byToolUseId.get(toolUseId);
    if (watched === undefined) return;
    this.#byToolUseId.delete(toolUseId);
    if (watched.timer !== undefined) this.#clock.clearTimer(watched.timer);
    if (watched.sent) {
      this.#emit({ type: 'tool_end', managerId: this.#managerId, toolUseId });
    }
  }

  settleAgent(agentId: string): void {
    for (const [toolUseId, watched] of [...this.#byToolUseId]) {
      if (watched.agentId === agentId) this.settle(toolUseId);
    }
  }

  settleAll(): void {
    for (const toolUseId of [...this.#byToolUseId.keys()]) this.settle(toolUseId);
  }
}
