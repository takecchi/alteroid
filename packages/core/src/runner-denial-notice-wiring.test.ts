import type { Options, Query, SDKMessage, query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { makeTempDirSync } from '../../../vitest.tmpdir.js';

import { BASH_GUARD_ENV } from './bash-guard-mode.js';
import { createRunnerHost, type RunnerHost } from './runner.js';
import type { RunnerEvent } from './runner-protocol.js';
import type { WorkerToolWatchClock } from './runner-worker-tool-watch.js';

// `RunnerSession` が `RunnerDenialNotice` へ口を渡す所（コンストラクタの配線）と、呼び元の `#apply`（live）の周回を縛る。
// `runner-denial-pin.test.ts`（切り出し前の作りの出力）が縛っていなかった 2 枝を足す:
//   (1) 呼び元 `#apply` の `permission_denied` の枝が `await` を挟まないこと: 2 件続けて押したとき、2 件目が見える周回数。
//   (2) `settleWorkerTool` の口は `#tryObservation` が握るので、tool_end の emit が投げても `noteDenial` は投げず、
//       後ろの `permission_denied` は降りること（実物の口は投げないので、口を async で包んでも外からは変わらない。
//       口が投げたときの伝わり方は runner-denial-notice.test.ts が偽物の口で縛っている）。
// 期待の値は切り出し後の作りの出力を目で読んで置いた（仕様を先に書いたものではない）。実時間では待たない。
// フェイクの SDK と rig は pin のものと同じ形（pin は変えないので写した）。

const DENY_ENV = { [BASH_GUARD_ENV]: 'deny' };

interface Started {
  options: Options;
  push: (message: SDKMessage) => void;
  finish: () => void;
}

function fakeRunnerSdk(): { fn: typeof sdkQuery; started: Started[] } {
  const started: Started[] = [];
  const fn = ((input: { options: Options }) => {
    let emit: ((message: SDKMessage | null) => void) | null = null;
    const buffered: SDKMessage[] = [];
    const record: Started = {
      options: input.options,
      finish: () => emit?.(null),
      push: (message) => {
        if (emit) {
          const resolve = emit;
          emit = null;
          resolve(message);
        } else {
          buffered.push(message);
        }
      },
    };
    started.push(record);
    async function* generate(): AsyncGenerator<SDKMessage, void> {
      yield {
        type: 'system',
        subtype: 'init',
        session_id: `sess-${started.length}`,
        uuid: `uuid-${started.length}`,
      } as unknown as SDKMessage;
      for (;;) {
        const next = buffered.shift();
        if (next !== undefined) {
          yield next;
          continue;
        }
        const message = await new Promise<SDKMessage | null>((resolve) => {
          emit = resolve;
        });
        emit = null;
        if (message === null) return;
        yield message;
      }
    }
    return Object.assign(generate(), {
      close: () => record.finish(),
      interrupt: async () => undefined,
      applyFlagSettings: async () => undefined,
    }) as unknown as Query;
  }) as unknown as typeof sdkQuery;
  return { fn, started };
}

let dir: string;
let host: RunnerHost | undefined;

beforeEach(() => {
  dir = makeTempDirSync('alteroid-runner-denial-wiring-');
});

afterEach(async () => {
  await host?.shutdown().catch(() => undefined);
  host = undefined;
});

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

interface Rig {
  started: Started;
  events: RunnerEvent[];
  clock: { advance: (ms: number) => void };
}

function fakeClock(startMs: number): WorkerToolWatchClock & { advance: (ms: number) => void } {
  let nowMs = startMs;
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => nowMs,
    setTimer: (fn, ms) => {
      const id = ++seq;
      timers.set(id, { at: nowMs + ms, fn });
      return id;
    },
    clearTimer: (handle) => {
      timers.delete(handle as number);
    },
    advance: (ms) => {
      nowMs += ms;
      for (const [id, timer] of [...timers]) {
        if (timer.at <= nowMs) {
          timers.delete(id);
          timer.fn();
        }
      }
    },
  };
}

async function open(throwOn?: (event: RunnerEvent) => boolean): Promise<Rig> {
  const events: RunnerEvent[] = [];
  const { fn, started } = fakeRunnerSdk();
  const clock = fakeClock(Date.parse('2026-10-04T00:00:00.000Z'));
  let thrown = false;
  host = createRunnerHost({
    runnerId: 'runner-test',
    workspacePath: dir,
    emit: (event) => {
      events.push(event);
      if (!thrown && throwOn?.(event) === true) {
        thrown = true;
        throw new Error('emit が落ちた（テスト用）');
      }
    },
    queryFn: fn,
    env: DENY_ENV,
    workerToolWatchClock: clock,
  });
  await host.start({ managerId: 'mgr-1', request: '走る', cwd: dir });
  const first = started[0];
  if (first === undefined) throw new Error('セッションが開いていない');
  events.length = 0;
  return { started: first, events, clock };
}

function live(rig: Rig, fields: Record<string, unknown>): void {
  rig.started.push({
    type: 'system',
    subtype: 'permission_denied',
    session_id: 'sess-mgr',
    uuid: `uuid-live-${String(fields.tool_use_id ?? 'none')}`,
    ...fields,
  } as unknown as SDKMessage);
}

type Denied = Extract<RunnerEvent, { type: 'permission_denied' }>;
const deniedIds = (events: readonly RunnerEvent[]): string[] =>
  events.filter((e): e is Denied => e.type === 'permission_denied').map((e) => e.toolUseId);

describe('呼び元 #apply の live の枝は await を挟まない', () => {
  it('2 件続けて押したとき、1 件目と 2 件目が見える周回数', async () => {
    const rig = await open();
    live(rig, { tool_name: 'Read', tool_use_id: 'tu-w1' });
    live(rig, { tool_name: 'Read', tool_use_id: 'tu-w2' });
    const seenAt: Record<string, number> = {};
    for (let ticks = 0; ticks < 200 && Object.keys(seenAt).length < 2; ticks += 1) {
      await Promise.resolve();
      for (const id of deniedIds(rig.events)) seenAt[id] ??= ticks;
    }
    expect(seenAt).toMatchInlineSnapshot(`
      {
        "tu-w1": 2,
        "tu-w2": 5,
      }
    `);
  });
});

describe('settleWorkerTool の口は投げない（握る）', () => {
  it('tool_end の emit が投げても、同じ呼び出しの permission_denied は降りる', async () => {
    const rig = await open((event) => event.type === 'tool_end');
    const hook = rig.started.options.hooks?.PreToolUse?.[0]?.hooks?.[0];
    if (hook === undefined) throw new Error('PreToolUse フックが登録されていない');
    await hook(
      {
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'sleep 1' },
        tool_use_id: 'tu-sw',
        agent_id: 'agent-1',
        agent_type: 'worker-x',
      } as never,
      undefined,
      { signal: new AbortController().signal },
    );
    rig.clock.advance(20_000);
    live(rig, { tool_name: 'Bash', tool_use_id: 'tu-sw' });
    await tick();
    expect(
      rig.events
        .filter(
          (e) =>
            e.type === 'tool_running' || e.type === 'tool_end' || e.type === 'permission_denied',
        )
        .map((e) => e.type),
    ).toMatchInlineSnapshot(`
      [
        "tool_running",
        "tool_end",
        "permission_denied",
      ]
    `);
  });
});
