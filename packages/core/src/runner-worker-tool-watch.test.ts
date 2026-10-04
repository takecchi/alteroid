import type {
  HookJSONOutput,
  Options,
  Query,
  SDKMessage,
  query as sdkQuery,
} from '@anthropic-ai/claude-agent-sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { makeTempDirSync } from '../../../vitest.tmpdir.js';

import { createRunnerHost, type RunnerHost } from './runner.js';
import { runnerEventSchema, type RunnerEvent } from './runner-protocol.js';
import { WORKER_TOOL_RUNNING_AFTER_MS, type WorkerToolWatchClock } from './runner-worker-tool-watch.js';

/**
 * 作業者の長い道具の実行中の観測（Issue #2725）を確かめる。
 *
 * 道具の開始（`PreToolUse`）にタイマーを置き、20秒を超えて未決のときだけ
 * `tool_running`、決着で `tool_end` を送る。時刻・タイマーは `workerToolWatchClock`
 * から差し替える（実時間は待たない）。足場は `runner-pre-tool-use.test.ts` と同じ。
 */

interface Started {
  options: Options;
  finish: () => void;
  push: (message: SDKMessage) => void;
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
    }) as unknown as Query;
  }) as unknown as typeof sdkQuery;
  return { fn, started };
}

async function fire(
  options: Options,
  name: 'PreToolUse' | 'PostToolUse' | 'PostToolUseFailure' | 'SubagentStop',
  input: Record<string, unknown>,
): Promise<HookJSONOutput> {
  const hook = options.hooks?.[name]?.[0]?.hooks?.[0];
  if (hook === undefined) throw new Error(`${name} フックが登録されていない`);
  return hook(input as never, undefined, { signal: new AbortController().signal });
}

/** 手で進める時計。`advance` で期限の来たタイマーを発火する。 */
function fakeClock(startMs: number): WorkerToolWatchClock & {
  advance: (ms: number) => void;
  pending: () => number;
} {
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
    pending: () => timers.size,
  };
}

const WORKER = { agent_id: 'agent-1', agent_type: 'worker' };
const T0 = Date.parse('2026-10-04T00:00:00.000Z');

type WatchEvent = Extract<RunnerEvent, { type: 'tool_running' | 'tool_end' }>;
const watchEvents = (events: readonly RunnerEvent[]): WatchEvent[] =>
  events.filter((e): e is WatchEvent => e.type === 'tool_running' || e.type === 'tool_end');

let dir: string;
let host: RunnerHost | undefined;

beforeEach(() => {
  dir = makeTempDirSync('alteroid-runner-worker-tool-watch-');
});

afterEach(async () => {
  await host?.shutdown().catch(() => undefined);
});

async function startSession() {
  const events: RunnerEvent[] = [];
  const clock = fakeClock(T0);
  const { fn, started } = fakeRunnerSdk();
  host = createRunnerHost({
    runnerId: 'runner-test',
    workspacePath: dir,
    emit: (event) => events.push(event),
    queryFn: fn,
    env: {},
    workerToolWatchClock: clock,
  });
  await host.start({ managerId: 'mgr-1', request: '走る', cwd: dir });
  const session = started[0];
  if (session === undefined) throw new Error('セッションが開いていない');
  return { session, events, clock, host };
}

const pre = (id: string, extra: Record<string, unknown> = WORKER) => ({
  hook_event_name: 'PreToolUse',
  tool_name: 'Bash',
  tool_input: { command: 'sleep 1' },
  tool_use_id: id,
  ...extra,
});
const post = (id: string, extra: Record<string, unknown> = WORKER) => ({
  hook_event_name: 'PostToolUse',
  tool_name: 'Bash',
  tool_input: { command: 'sleep 1' },
  tool_response: {},
  tool_use_id: id,
  ...extra,
});

describe('作業者の道具の実行中の観測（#2725）', () => {
  it('20秒未満で決着した道具は何も送らない', async () => {
    const { session, events, clock } = await startSession();
    await fire(session.options, 'PreToolUse', pre('tu-1'));
    clock.advance(WORKER_TOOL_RUNNING_AFTER_MS - 1);
    await fire(session.options, 'PostToolUse', post('tu-1'));
    clock.advance(WORKER_TOOL_RUNNING_AFTER_MS * 2);
    expect(watchEvents(events)).toEqual([]);
    expect(clock.pending()).toBe(0);
  });

  it('20秒を超えたら tool_running を1回だけ送り、決着で tool_end を1回送る', async () => {
    const { session, events, clock } = await startSession();
    await fire(session.options, 'PreToolUse', pre('tu-1'));
    clock.advance(WORKER_TOOL_RUNNING_AFTER_MS);
    clock.advance(60_000);
    expect(watchEvents(events)).toEqual([
      {
        type: 'tool_running',
        managerId: 'mgr-1',
        actor: 'worker:mgr-1:worker',
        tool: 'Bash',
        toolUseId: 'tu-1',
        startedAt: new Date(T0).toISOString(),
      },
    ]);
    await fire(session.options, 'PostToolUse', post('tu-1'));
    await fire(session.options, 'PostToolUse', post('tu-1'));
    expect(watchEvents(events).map((e) => e.type)).toEqual(['tool_running', 'tool_end']);
    expect(watchEvents(events)[1]).toEqual({ type: 'tool_end', managerId: 'mgr-1', toolUseId: 'tu-1' });
  });

  it('失敗で決着しても tool_end を送る', async () => {
    const { session, events, clock } = await startSession();
    await fire(session.options, 'PreToolUse', pre('tu-1'));
    clock.advance(WORKER_TOOL_RUNNING_AFTER_MS);
    await fire(session.options, 'PostToolUseFailure', {
      hook_event_name: 'PostToolUseFailure',
      tool_name: 'Bash',
      tool_input: {},
      tool_use_id: 'tu-1',
      error: 'boom',
      ...WORKER,
    });
    expect(watchEvents(events).map((e) => e.type)).toEqual(['tool_running', 'tool_end']);
  });

  it('拒否（system/permission_denied）で決着しても tool_end を送る', async () => {
    const { session, events, clock } = await startSession();
    await fire(session.options, 'PreToolUse', pre('tu-1'));
    clock.advance(WORKER_TOOL_RUNNING_AFTER_MS);
    session.push({
      type: 'system',
      subtype: 'permission_denied',
      tool_name: 'Bash',
      tool_use_id: 'tu-1',
      session_id: 'sess-1',
      uuid: 'uuid-denied',
    } as unknown as SDKMessage);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(watchEvents(events).map((e) => e.type)).toEqual(['tool_running', 'tool_end']);
  });

  it('SubagentStop で、その作業者の分だけ全部片付く', async () => {
    const { session, events, clock } = await startSession();
    await fire(session.options, 'PreToolUse', pre('tu-1'));
    await fire(session.options, 'PreToolUse', pre('tu-2', { agent_id: 'agent-2', agent_type: 'worker' }));
    clock.advance(WORKER_TOOL_RUNNING_AFTER_MS);
    await fire(session.options, 'SubagentStop', {
      hook_event_name: 'SubagentStop',
      stop_hook_active: false,
      agent_transcript_path: '/tmp/does-not-exist.jsonl',
      session_crons: [],
      ...WORKER,
    });
    const ended = watchEvents(events).filter((e) => e.type === 'tool_end');
    expect(ended).toEqual([{ type: 'tool_end', managerId: 'mgr-1', toolUseId: 'tu-1' }]);
  });

  it('セッションの終了で、未決のタイマーを残さず tool_end を送る', async () => {
    const { session, events, clock, host } = await startSession();
    await fire(session.options, 'PreToolUse', pre('tu-1'));
    await fire(session.options, 'PreToolUse', pre('tu-2'));
    clock.advance(WORKER_TOOL_RUNNING_AFTER_MS);
    await fire(session.options, 'PreToolUse', pre('tu-3'));
    await host.stop('mgr-1', 'テスト');
    expect(clock.pending()).toBe(0);
    expect(watchEvents(events).filter((e) => e.type === 'tool_end').map((e) => e.toolUseId)).toEqual([
      'tu-1',
      'tu-2',
    ]);
  });

  it('マネージャー自身の道具（agent_id 無し）と tool_use_id 無しは何も置かない', async () => {
    const { session, events, clock } = await startSession();
    await fire(session.options, 'PreToolUse', pre('tu-1', {}));
    await fire(session.options, 'PreToolUse', {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'sleep 1' },
      ...WORKER,
    });
    expect(clock.pending()).toBe(0);
    clock.advance(WORKER_TOOL_RUNNING_AFTER_MS * 2);
    expect(watchEvents(events)).toEqual([]);
  });

  it('Pre の判定は止めない（Bash の待ちガードの deny はそのまま返る）', async () => {
    const { session, clock } = await startSession();
    const out = await fire(session.options, 'PreToolUse', {
      ...pre('tu-1'),
      tool_input: {
        command:
          'until grep -q "^run: まとめ$" /tmp/mutation-run-865.log 2>/dev/null; do sleep 5; done',
      },
    });
    const output = (out as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput;
    expect(output?.permissionDecision).toBe('deny');
    // 弾いた呼び出しには Post も拒否の合図も来ないので、タイマーを置かない。
    expect(clock.pending()).toBe(0);
  });
});

describe('プロトコルの境界（#223 の作法）', () => {
  it('tool_running / tool_end は JSON を通して parse できる', () => {
    const running: RunnerEvent = {
      type: 'tool_running',
      managerId: 'mgr-1',
      actor: 'worker:mgr-1:worker',
      tool: 'Bash',
      toolUseId: 'tu-1',
      startedAt: new Date(T0).toISOString(),
    };
    const end: RunnerEvent = { type: 'tool_end', managerId: 'mgr-1', toolUseId: 'tu-1' };
    for (const event of [running, end]) {
      expect(runnerEventSchema.parse(JSON.parse(JSON.stringify(event)))).toEqual(event);
    }
  });
});
