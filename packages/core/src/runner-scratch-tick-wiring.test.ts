import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';

import type { Query, SDKMessage, query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';

import { createRunnerHost, type RunnerHost, type RunnerHostOptions } from './runner.js';
import type { RunnerEvent } from './runner-protocol.js';

// `Host.constructor` が `RunnerScratchTick` をどう組み、タイマーのコールバックがそれをどう呼ぶかを縛る（`runner-host-timers-pin.test.ts` が縛る 1 周期の中身とは別の、配線の側）。
// `RunnerScratchTick` は偽物（口と `tick` の呼びを記録する）。時計は注入（`vi.useFakeTimers`）、実時間では待たない。

const w = vi.hoisted(() => ({
  made: [] as { ports: Record<string, unknown>; ticks: number }[],
  throwOnTick: false,
}));

vi.mock('./runner-scratch-tick.js', () => ({
  RunnerScratchTick: class {
    readonly #record: { ports: Record<string, unknown>; ticks: number };
    constructor(ports: Record<string, unknown>) {
      this.#record = { ports, ticks: 0 };
      w.made.push(this.#record);
    }
    tick(): void {
      this.#record.ticks += 1;
      if (w.throwOnTick) throw new Error('tick が同期で落ちた（テスト用）');
    }
  },
}));

function fakeSdk(): typeof sdkQuery {
  return ((params: { prompt: AsyncIterable<unknown> }) => {
    let finish: (() => void) | null = null;
    async function* generate(): AsyncGenerator<SDKMessage, void> {
      yield {
        type: 'system',
        subtype: 'init',
        session_id: 'sess-wiring',
        uuid: 'uuid-init',
      } as unknown as SDKMessage;
      void (async () => {
        for await (const message of params.prompt) void message;
      })();
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
    }
    return Object.assign(generate(), {
      close: () => finish?.(),
      interrupt: async () => undefined,
    }) as unknown as Query;
  }) as unknown as typeof sdkQuery;
}

const SCRATCH_MS = 5_000;

describe('Host.constructor → RunnerScratchTick の配線', () => {
  let tmp: string;
  let hosts: RunnerHost[] = [];
  let intervals: { fn: () => unknown; ms: number }[] = [];

  beforeEach(async () => {
    tmp = await makeTempDir('runner-scratch-tick-wiring-');
    for (const dir of ['att', 'outbox', 'staged', 'rescue', 'mcp']) {
      await mkdir(path.join(tmp, dir));
    }
    w.made.length = 0;
    w.throwOnTick = false;
    intervals = [];
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    const realSet = globalThis.setInterval;
    globalThis.setInterval = ((fn: () => unknown, ms: number) => {
      intervals.push({ fn, ms });
      return realSet(fn as () => void, ms);
    }) as unknown as typeof setInterval;
  });

  afterEach(async () => {
    await Promise.all(hosts.map((host) => host.shutdown().catch(() => undefined)));
    hosts = [];
    vi.useRealTimers();
    await rm(tmp, { recursive: true, force: true });
  });

  function build(options: Partial<RunnerHostOptions> = {}): {
    host: RunnerHost;
    events: RunnerEvent[];
  } {
    const events: RunnerEvent[] = [];
    const host = createRunnerHost({
      runnerId: 'runner-wiring',
      workspacePath: '/work/project',
      emit: (event) => events.push(event),
      queryFn: fakeSdk(),
      env: { PATH: '/usr/bin' },
      readCgroupEventCountersFn: async () => ({}),
      finishUnpushedWorkFn: async () => ({ cwd: '/work/project', worktrees: [] }),
      cwdExistsFn: () => true,
      attachmentsRoot: path.join(tmp, 'att'),
      outboxRoot: path.join(tmp, 'outbox'),
      outboxStagedRoot: path.join(tmp, 'staged'),
      rescueStagedRoot: path.join(tmp, 'rescue'),
      mcpConfigTmpRoot: path.join(tmp, 'mcp'),
      codexAuthCheckIntervalMs: 1_000_000,
      rescueIntervalMs: 2_000_000,
      scratchSweep: { intervalMs: SCRATCH_MS, tmpRoot: '/scratch-wiring' },
      ...options,
    });
    hosts.push(host);
    return { host, events };
  }

  const scratchInterval = (): { fn: () => unknown; ms: number } => {
    const found = intervals.find((entry) => entry.ms === SCRATCH_MS);
    if (found === undefined) throw new Error('scratch のタイマーが作られていない');
    return found;
  };
  const only = (): (typeof w.made)[number] => {
    expect(w.made).toHaveLength(1);
    const made = w.made[0];
    if (made === undefined) throw new Error('RunnerScratchTick が作られていない');
    return made;
  };

  it('RunnerScratchTick を 1 つだけ作り、作っただけでは tick を呼ばない', () => {
    build();
    expect(only().ticks).toBe(0);
  });

  it('scratchSweep: false なら RunnerScratchTick を作らず、scratch のタイマーも作らない', () => {
    build({ scratchSweep: false });
    expect(w.made).toHaveLength(0);
    expect(intervals.some((entry) => entry.ms === SCRATCH_MS)).toBe(false);
  });

  it('口は 11 本で、関数の口は同期（Promise を返さない）', () => {
    build();
    const { ports } = only();
    expect(Object.keys(ports).sort()).toEqual([
      'attachmentsRoot',
      'emit',
      'kickMcpConfigSweep',
      'outboxRemoval',
      'outboxRoot',
      'outboxStagedRoot',
      'rescueStagedRoot',
      'runnerId',
      'scratchAbort',
      'sessionKeys',
      'sweeper',
    ]);
    for (const name of ['sessionKeys', 'outboxRemoval', 'kickMcpConfigSweep', 'emit']) {
      expect(typeof ports[name]).toBe('function');
    }
    const keys = (ports['sessionKeys'] as () => unknown)();
    expect(Array.isArray(keys)).toBe(true);
    const removal = (ports['outboxRemoval'] as () => unknown)();
    expect(removal).not.toBeInstanceOf(Promise);
    expect(typeof removal).toBe('object');
    expect(
      (ports['kickMcpConfigSweep'] as () => unknown)(),
      'kickMcpConfigSweep は同期で void を返す',
    ).toBeUndefined();
  });

  it('値の口は Host の値のまま（root 4 本・runnerId）。sweeper は sweep を持つ', () => {
    build();
    const { ports } = only();
    expect({
      attachmentsRoot: ports['attachmentsRoot'],
      outboxRoot: ports['outboxRoot'],
      outboxStagedRoot: ports['outboxStagedRoot'],
      rescueStagedRoot: ports['rescueStagedRoot'],
      runnerId: ports['runnerId'],
    }).toEqual({
      attachmentsRoot: path.join(tmp, 'att'),
      outboxRoot: path.join(tmp, 'outbox'),
      outboxStagedRoot: path.join(tmp, 'staged'),
      rescueStagedRoot: path.join(tmp, 'rescue'),
      runnerId: 'runner-wiring',
    });
    expect(typeof (ports['sweeper'] as { sweep: unknown }).sweep).toBe('function');
  });

  it('sessionKeys は呼ぶたびに今の担当を読み直す', async () => {
    const { host } = build();
    const sessionKeys = only().ports['sessionKeys'] as () => string[];
    expect(sessionKeys()).toEqual([]);
    await host.start({ managerId: 'mgr-w', request: '依頼', cwd: '/work/project' });
    expect(sessionKeys()).toEqual(['mgr-w']);
  });

  it('emit の口は Host の emit へ同期で届ける', () => {
    const { events } = build();
    const returned: unknown = (only().ports['emit'] as (event: RunnerEvent) => unknown)({
      type: 'shutting_down',
      runnerId: 'runner-wiring',
    });
    expect(returned, 'emit は同期で void を返す').toBeUndefined();
    expect(events.at(-1)).toEqual({ type: 'shutting_down', runnerId: 'runner-wiring' });
  });

  it('タイマーのコールバックは tick を同期で 1 回呼び、Promise を返さない（async で包まない・await しない）', () => {
    build();
    const callback = scratchInterval().fn;
    const returned = callback();
    expect(only().ticks).toBe(1);
    expect(returned).toBeUndefined();
  });

  it('周期ごとに tick を 1 回ずつ呼ぶ', () => {
    build();
    vi.advanceTimersByTime(SCRATCH_MS * 3);
    expect(only().ticks).toBe(3);
  });

  it('tick が同期で投げたら、コールバックからそのまま伝わる（握らない）', () => {
    build();
    const callback = scratchInterval().fn;
    w.throwOnTick = true;
    expect(() => callback()).toThrow('tick が同期で落ちた');
    expect(only().ticks).toBe(1);
  });

  it('scratchAbort は参照のまま渡す: shutdown の abort がその AbortController に届く', async () => {
    const { host } = build();
    const abort = only().ports['scratchAbort'] as AbortController;
    expect(abort).toBeInstanceOf(AbortController);
    expect(abort.signal.aborted).toBe(false);
    await host.shutdown();
    expect(abort.signal.aborted).toBe(true);
  });
});
