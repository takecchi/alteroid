import type {
  HookJSONOutput,
  Options,
  Query,
  SDKMessage,
  query as sdkQuery,
} from '@anthropic-ai/claude-agent-sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { makeTempDirSync } from '../../../vitest.tmpdir.js';

import { createRunnerHost, type RunnerHost, SUBAGENT_BACKGROUND_WAIT_MS } from './runner.js';
import type { RunnerEvent } from './runner-protocol.js';

// `RunnerSession` が `RunnerSubagentStopObserver` へ口を渡す所（コンストラクタの配線）と、呼び元
// （`onSubagentStop: (record) => this.#subagentStopObserver.observe(record)`）の周回を縛る。
// `runner-subagent-stop-pin.test.ts`（切り出し前の作りの出力）と同じ周回の数を、配線の側から確かめ直す:
//   (1) 呼び元で `await` を足す・口を `async` で包むと、フックの戻りまでの周回が増える（この試験が赤くなる）。
//   (2) `stopState`／`cutOffWorkers`／`sdkSession`／`workerTools` は `RunnerSession` が持つ器そのもの
//       （PostToolUse が表へ入れた所有者を引く・打ち切りの控えが Task の結果の注記に出る・畳みで待ちが解ける・作業者の見張りが片付く）。
//   (3) note／emit は `RunnerSession` の経路を通って出る（managerId が載る）。再開の案内は `RunnerSession#resumeGuidance` の文面。
// 期待の値は切り出し後の作りの出力を目で読んで置いた（仕様を先に書いたものではない）。実時間では待たない。
// フェイクの SDK は pin のものと同じ形（pin は変えないので写した）。

interface Started {
  options: Options;
  finish: () => void;
  notify: (taskId: string) => void;
}

function fakeRunnerSdk(): { fn: typeof sdkQuery; started: Started[] } {
  const started: Started[] = [];
  const fn = ((input: { options: Options }) => {
    let emit: ((message: SDKMessage | null) => void) | null = null;
    const record: Started = {
      options: input.options,
      finish: () => emit?.(null),
      notify: (taskId) =>
        emit?.({
          type: 'system',
          subtype: 'task_notification',
          task_id: taskId,
          status: 'completed',
          summary: '完了',
          output_file: '/tmp/out.txt',
          session_id: `sess-${started.length}`,
          uuid: `uuid-task-notification-${taskId}`,
        } as unknown as SDKMessage),
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
  dir = makeTempDirSync('alteroid-runner-subagent-stop-wiring-');
});

afterEach(async () => {
  vi.useRealTimers();
  await host?.shutdown().catch(() => undefined);
  host = undefined;
});

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

interface Rig {
  started: Started;
  events: RunnerEvent[];
}

async function open(): Promise<Rig> {
  const events: RunnerEvent[] = [];
  const { fn, started } = fakeRunnerSdk();
  host = createRunnerHost({
    runnerId: 'runner-test',
    workspacePath: dir,
    emit: (event) => events.push(event),
    queryFn: fn,
    env: {},
  });
  await host.start({ managerId: 'mgr-1', request: '走る', cwd: dir });
  const first = started[0];
  if (first === undefined) throw new Error('セッションが開いていない');
  events.length = 0;
  return { started: first, events };
}

function fire(rig: Rig, name: string, input: Record<string, unknown>): Promise<HookJSONOutput> {
  const hook = rig.started.options.hooks?.[name as 'Stop']?.[0]?.hooks?.[0];
  if (hook === undefined) throw new Error(`${name} フックが登録されていない`);
  return hook(input as never, undefined, { signal: new AbortController().signal });
}

const STOP_BASE = {
  hook_event_name: 'SubagentStop',
  stop_hook_active: false,
  agent_transcript_path: '/tmp/does-not-exist.jsonl',
  agent_type: 'worker',
  session_crons: [],
  agent_id: 'agent-1',
};

async function register(rig: Rig, taskId: string, agentId: string): Promise<void> {
  await fire(rig, 'PostToolUse', {
    hook_event_name: 'PostToolUse',
    tool_name: 'Bash',
    tool_input: { command: 'sleep 90', run_in_background: true },
    tool_response: { stdout: '', stderr: '', backgroundTaskId: taskId },
    agent_id: agentId,
    agent_type: 'worker',
  });
}

const bg = (id: string, status = 'running') => ({
  id,
  type: 'shell',
  status,
  description: 'd',
  command: 'pnpm verify',
});

type NoteEvent = Extract<RunnerEvent, { type: 'note' }>;
const subagentNotes = (events: readonly RunnerEvent[]): NoteEvent[] =>
  events.filter((e): e is NoteEvent => e.type === 'note' && e.text.startsWith('SubagentStop'));

describe('呼び元の周回（await を足さない・口を async で包まない）', () => {
  async function ticksOf(rig: Rig, input: Record<string, unknown>) {
    const before = subagentNotes(rig.events).length;
    const promise = fire(rig, 'SubagentStop', input);
    const noteSync = subagentNotes(rig.events).length - before;
    let ticks = 0;
    let settledAtTick = -1;
    void promise.then(() => {
      settledAtTick = ticks;
    });
    while (settledAtTick < 0 && ticks < 50) {
      await Promise.resolve();
      ticks += 1;
    }
    return { noteSync, settledAtTick };
  }

  it('診断・読み取りの失敗・畳み済みの released・待ちが先に終わっている起こし直しの、戻りまでの周回（pin と同じ数）', async () => {
    const seen: Record<string, unknown> = {};
    {
      const rig = await open();
      seen['orphan'] = await ticksOf(rig, { ...STOP_BASE, background_tasks: [bg('bg-o')] });
      await host?.shutdown();
    }
    {
      const rig = await open();
      const failing: Record<string, unknown> = { ...STOP_BASE };
      Object.defineProperty(failing, 'background_tasks', {
        enumerable: true,
        get(): never {
          throw new Error('boom');
        },
      });
      seen['failed'] = await ticksOf(rig, failing);
      await host?.shutdown();
    }
    {
      const rig = await open();
      await register(rig, 'bg-r', 'agent-1');
      await host?.shutdown();
      seen['releasedBeforeWait'] = await ticksOf(rig, {
        ...STOP_BASE,
        background_tasks: [bg('bg-r')],
      });
    }
    {
      const rig = await open();
      await register(rig, 'bg-w', 'agent-1');
      rig.started.notify('bg-w');
      await tick();
      seen['woken'] = await ticksOf(rig, { ...STOP_BASE, background_tasks: [bg('bg-w')] });
    }
    expect(seen).toMatchInlineSnapshot(`
      {
        "failed": {
          "noteSync": 1,
          "settledAtTick": 1,
        },
        "orphan": {
          "noteSync": 1,
          "settledAtTick": 1,
        },
        "releasedBeforeWait": {
          "noteSync": 0,
          "settledAtTick": 2,
        },
        "woken": {
          "noteSync": 0,
          "settledAtTick": 3,
        },
      }
    `);
  });
});

describe('配線', () => {
  it('SubagentStop フックは 1 本だけ。診断の note は担当の note として出る（managerId が載る）', async () => {
    const rig = await open();
    expect(rig.started.options.hooks?.SubagentStop?.[0]?.hooks).toHaveLength(1);
    await fire(rig, 'SubagentStop', { ...STOP_BASE, background_tasks: [bg('x')] });
    expect(subagentNotes(rig.events).map((e) => e.managerId)).toEqual(['mgr-1']);
  });

  it('emit の口の managerId: 起こし直しの note（stall 付き）にも、口の managerId が載る', async () => {
    const rig = await open();
    await register(rig, 'bg-1', 'agent-1');
    rig.started.notify('bg-1');
    await tick();
    await fire(rig, 'SubagentStop', { ...STOP_BASE, background_tasks: [bg('bg-1')] });
    expect(subagentNotes(rig.events).map((e) => [e.managerId, e.stall?.outcome])).toEqual([
      ['mgr-1', 'woken'],
    ]);
  });

  it('stopState は PostToolUse（所有者の記録）と同じ器: 記録した作業者の分だけが起こし直しの対象になり、診断の旗は 1 つの器で共有される', async () => {
    const rig = await open();
    await register(rig, 'bg-mine', 'agent-1');
    rig.started.notify('bg-mine');
    await tick();
    const mine = await fire(rig, 'SubagentStop', {
      ...STOP_BASE,
      background_tasks: [bg('bg-mine')],
    });
    const other = await fire(rig, 'SubagentStop', {
      ...STOP_BASE,
      agent_id: 'agent-2',
      background_tasks: [bg('bg-mine'), bg('bg-orphan')],
    });
    const again = await fire(rig, 'SubagentStop', {
      ...STOP_BASE,
      agent_id: 'agent-2',
      background_tasks: [bg('bg-orphan')],
    });
    expect({
      mine: (mine as { hookSpecificOutput?: unknown }).hookSpecificOutput === undefined,
      other,
      again,
      notes: subagentNotes(rig.events).map((e) => e.text.slice(0, 60)),
    }).toMatchInlineSnapshot(`
      {
        "again": {
          "continue": true,
        },
        "mine": false,
        "notes": [
          "SubagentStop（作業者: worker / agent_id=agent-1）: **この作業者が自分で起こし",
          "SubagentStop: 背景処理の**所有者を引けなかった**（1件。id=bg-orphan type=shell",
        ],
        "other": {
          "continue": true,
        },
      }
    `);
  });

  it('sdkSession は RunnerSession の器: 待ちの途中で畳むと、待ちが解けて起こし直さずに返る', async () => {
    const rig = await open();
    await register(rig, 'bg-1', 'agent-1');
    const pending = fire(rig, 'SubagentStop', { ...STOP_BASE, background_tasks: [bg('bg-1')] });
    await tick();
    await host?.shutdown();
    const result = await pending;
    expect({ result, notes: subagentNotes(rig.events).map((e) => [e.text.slice(-60), e.stall]) })
      .toMatchInlineSnapshot(`
        {
          "notes": [
            [
              "れた（stop / 畳み直し / 世代交代）ので、起こし直さずに返した。 stop_hook_active=false。",
              undefined,
            ],
          ],
          "result": {
            "continue": true,
          },
        }
      `);
  });

  it('cutOffWorkers は RunnerSession の器: 待ちの上限で打ち切ると、Task の結果の注記に出る。再開の案内は RunnerSession の文面', async () => {
    const rig = await open();
    await register(rig, 'bg-1', 'agent-1');
    vi.useFakeTimers();
    let limited: HookJSONOutput;
    try {
      const pending = fire(rig, 'SubagentStop', { ...STOP_BASE, background_tasks: [bg('bg-1')] });
      await vi.advanceTimersByTimeAsync(SUBAGENT_BACKGROUND_WAIT_MS);
      limited = await pending;
    } finally {
      vi.useRealTimers();
    }
    const annotated = await fire(rig, 'PostToolUse', {
      hook_event_name: 'PostToolUse',
      tool_name: 'Agent',
      tool_input: { prompt: '作業' },
      tool_response: { status: 'completed', agentId: 'agent-1', content: [] },
    });
    expect({
      limited,
      limitNoteTail: subagentNotes(rig.events)[0]?.text.split('\n').at(-1),
      annotated: (
        annotated as { hookSpecificOutput?: { additionalContext?: string } }
      ).hookSpecificOutput?.additionalContext
        ?.split('\n')
        .slice(1),
    }).toMatchInlineSnapshot(`
      {
        "annotated": [
          "- id=bg-1 command=pnpm verify",
          "出力の置き場所は、処理が終わったら知らせる（#1554）。",
          "続きを頼むなら、\`ToolSearch\` を \`select:SendMessage\` で読み込んでから agentId=agent-1 へ送ること——同じ文脈のまま再開できる。届くのはその作業者の次の道具の区切りで、即時ではない（読む前に動くことがある）。",
        ],
        "limitNoteTail": "続きを頼むなら、\`ToolSearch\` を \`select:SendMessage\` で読み込んでから agentId=agent-1 へ送ること——同じ文脈のまま再開できる。届くのはその作業者の次の道具の区切りで、即時ではない（読む前に動くことがある）。",
        "limited": {
          "continue": true,
        },
      }
    `);
  });

  it('workerTools は RunnerSession の器: 作業者の道具の見張りが、SubagentStop の先頭で片付く（待ちの途中でも tool_end が出ている）', async () => {
    const events: RunnerEvent[] = [];
    const { fn, started } = fakeRunnerSdk();
    let nowMs = 0;
    const timers = new Map<number, { at: number; fn: () => void }>();
    let seq = 0;
    host = createRunnerHost({
      runnerId: 'runner-test',
      workspacePath: dir,
      emit: (event) => events.push(event),
      queryFn: fn,
      env: {},
      workerToolWatchClock: {
        now: () => nowMs,
        setTimer: (callback, ms) => {
          seq += 1;
          timers.set(seq, { at: nowMs + ms, fn: callback });
          return seq;
        },
        clearTimer: (handle) => {
          timers.delete(handle as number);
        },
      },
    });
    await host.start({ managerId: 'mgr-1', request: '走る', cwd: dir });
    const first = started[0];
    if (first === undefined) throw new Error('セッションが開いていない');
    const rig: Rig = { started: first, events };
    await register(rig, 'bg-1', 'agent-1');
    await fire(rig, 'PreToolUse', {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'sleep 1' },
      tool_use_id: 'tu-1',
      agent_id: 'agent-1',
      agent_type: 'worker',
    });
    nowMs += 20_000;
    for (const [id, timer] of [...timers]) {
      if (timer.at <= nowMs) {
        timers.delete(id);
        timer.fn();
      }
    }
    const pending = fire(rig, 'SubagentStop', { ...STOP_BASE, background_tasks: [bg('bg-1')] });
    const endedWhileWaiting = events.filter((e) => e.type === 'tool_end').length;
    first.notify('bg-1');
    await pending;
    expect({ endedWhileWaiting }).toMatchInlineSnapshot(`
      {
        "endedWhileWaiting": 1,
      }
    `);
  });
});
