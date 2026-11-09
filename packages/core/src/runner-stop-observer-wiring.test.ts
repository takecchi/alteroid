import type { Options, Query, SDKMessage, query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { makeTempDirSync } from '../../../vitest.tmpdir.js';

import { createRunnerHost, type RunnerHost } from './runner.js';
import type { RunnerEvent } from './runner-protocol.js';

// `RunnerSession` が `RunnerStopObserver` へ口を渡す所（コンストラクタの配線）と、呼び元（`onStop: (record) => this.#stopObserver.observe(record)`）の周回を縛る。
// `runner-stop-pin.test.ts`（切り出し前の作りの出力）と同じ周回の数を、配線の側から確かめ直す:
//   (1) 呼び元で `await` を足す・口を `async` で包むと、フックの戻りまでの周回が増える（この試験が赤くなる）。
//   (2) note は `RunnerSession#note` を通って出る（managerId が載る）。
//   (3) `stopState` は `#onSubagentStop` 側と同じ器: PostToolUse が表へ入れた所有者を、Stop の観測が引く。
// 期待の値は切り出し後の作りの出力を目で読んで置いた（仕様を先に書いたものではない）。実時間では待たない。
// フェイクの SDK は pin のものと同じ形（pin は変えないので写した）。

function fakeRunnerSdk(): { fn: typeof sdkQuery; started: Options[] } {
  const started: Options[] = [];
  const fn = ((input: { options: Options }) => {
    let emit: ((message: SDKMessage | null) => void) | null = null;
    started.push(input.options);
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
      close: () => emit?.(null),
      interrupt: async () => undefined,
      applyFlagSettings: async () => undefined,
    }) as unknown as Query;
  }) as unknown as typeof sdkQuery;
  return { fn, started };
}

let dir: string;
let host: RunnerHost | undefined;

beforeEach(() => {
  dir = makeTempDirSync('alteroid-runner-stop-wiring-');
});

afterEach(async () => {
  await host?.shutdown().catch(() => undefined);
  host = undefined;
});

async function open(): Promise<{ options: Options; events: RunnerEvent[] }> {
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
  const options = started[0];
  if (options === undefined) throw new Error('セッションが開いていない');
  events.length = 0;
  return { options, events };
}

function stopHook(options: Options) {
  const hook = options.hooks?.Stop?.[0]?.hooks?.[0];
  if (hook === undefined) throw new Error('Stop フックが登録されていない');
  return (input: Record<string, unknown>) =>
    hook(input as never, undefined, { signal: new AbortController().signal });
}

type NoteEvent = Extract<RunnerEvent, { type: 'note' }>;
const stopNotes = (events: readonly RunnerEvent[]): NoteEvent[] =>
  events.filter((e): e is NoteEvent => e.type === 'note' && e.text.startsWith('Stop'));

describe('呼び元の周回（await を足さない・口を async で包まない）', () => {
  it('フックを呼んだ直後（await 無し）に note が出ていて、戻りは 2 周回目。0 件・在り高・失敗のどれも同じ', async () => {
    const rig = await open();
    const fire = stopHook(rig.options);
    const failing: Record<string, unknown> = {};
    Object.defineProperty(failing, 'background_tasks', {
      enumerable: true,
      get(): never {
        throw new Error('boom');
      },
    });
    const seen: Record<string, { noteSync: number; settledAtTick: number }> = {};
    for (const [name, input] of Object.entries({
      idle: { background_tasks: [] },
      busy: { background_tasks: [{ id: 'a', type: 'shell', status: 'running' }] },
      failed: failing,
    })) {
      const before = stopNotes(rig.events).length;
      const promise = fire(input);
      const noteSync = stopNotes(rig.events).length - before;
      let ticks = 0;
      let settledAtTick = -1;
      void promise.then(() => {
        settledAtTick = ticks;
      });
      while (settledAtTick < 0 && ticks < 50) {
        await Promise.resolve();
        ticks += 1;
      }
      seen[name] = { noteSync, settledAtTick };
    }
    expect(seen).toMatchInlineSnapshot(`
      {
        "busy": {
          "noteSync": 1,
          "settledAtTick": 2,
        },
        "failed": {
          "noteSync": 1,
          "settledAtTick": 2,
        },
        "idle": {
          "noteSync": 1,
          "settledAtTick": 2,
        },
      }
    `);
  });
});

describe('配線', () => {
  it('Stop フックは 1 本だけ。note は担当の note として出る（managerId が載る）', async () => {
    const rig = await open();
    expect(rig.options.hooks?.Stop?.[0]?.hooks).toHaveLength(1);
    await stopHook(rig.options)({ background_tasks: [] });
    expect(stopNotes(rig.events).map((e) => e.managerId)).toEqual(['mgr-1']);
  });

  it('stopState は PostToolUse（所有者の記録）と同じ器: 記録した作業者の所有が Stop の行に出る', async () => {
    const rig = await open();
    const post = rig.options.hooks?.PostToolUse?.[0]?.hooks?.[0];
    if (post === undefined) throw new Error('PostToolUse フックが登録されていない');
    await post(
      {
        hook_event_name: 'PostToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'sleep 90', run_in_background: true },
        tool_response: { stdout: '', stderr: '', backgroundTaskId: 'bg-w' },
        agent_id: 'agent-w',
        agent_type: 'worker',
      } as never,
      undefined,
      { signal: new AbortController().signal },
    );
    await stopHook(rig.options)({
      background_tasks: [{ id: 'bg-w', type: 'shell', status: 'running', description: 'd' }],
    });
    const line = stopNotes(rig.events)[0]
      ?.text.split('\n')
      .find((l) => l.startsWith('- id='));
    expect(line).toMatchInlineSnapshot(
      `"- id=bg-w owner=worker:agent-w type=shell status=running description=d"`,
    );
  });

  it('通算は Stop の発火ごとに 1 つずつ進む（口の stopState が 1 つの器を共有している）', async () => {
    const rig = await open();
    const fire = stopHook(rig.options);
    await fire({ background_tasks: [] });
    await fire({ background_tasks: [{ id: 'a', type: 'shell', status: 'running' }] });
    await fire({ background_tasks: [{ id: 'a', type: 'shell', status: 'running' }] });
    expect(stopNotes(rig.events).map((e) => /通算 (\d+)回目/u.exec(e.text)?.[1])).toEqual([
      '1',
      '2',
      '3',
    ]);
  });
});
