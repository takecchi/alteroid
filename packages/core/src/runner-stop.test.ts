import type {
  BackgroundTaskSummary,
  HookJSONOutput,
  Options,
  Query,
  SDKMessage,
  StopHookInput,
  SubagentStopHookInput,
  query as sdkQuery,
} from '@anthropic-ai/claude-agent-sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { makeTempDirSync } from '../../../vitest.tmpdir.js';

import { createRunnerHost, type RunnerHost } from './runner.js';
import { runnerEventSchema, type RunnerEvent } from './runner-protocol.js';

interface Started {
  options: Options;
  finish: () => void;
}

function fakeRunnerSdk(): { fn: typeof sdkQuery; started: Started[] } {
  const started: Started[] = [];
  const fn = ((input: { options: Options }) => {
    let emit: ((message: SDKMessage | null) => void) | null = null;
    const record: Started = {
      options: input.options,
      finish: () => emit?.(null),
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
    }) as unknown as Query;
  }) as unknown as typeof sdkQuery;

  return { fn, started };
}

async function fireStop(options: Options, input: Record<string, unknown>): Promise<HookJSONOutput> {
  const hook = options.hooks?.Stop?.[0]?.hooks?.[0];
  if (hook === undefined) throw new Error('Stop フックが登録されていない');
  return hook(input as never, undefined, { signal: new AbortController().signal });
}

async function firePostToolUse(
  options: Options,
  input: Record<string, unknown>,
): Promise<HookJSONOutput> {
  const hook = options.hooks?.PostToolUse?.[0]?.hooks?.[0];
  if (hook === undefined) throw new Error('PostToolUse フックが登録されていない');
  return hook(input as never, undefined, { signal: new AbortController().signal });
}

async function registerBackgroundTask(
  options: Options,
  taskId: string,
  agentId?: string,
): Promise<void> {
  await firePostToolUse(options, {
    hook_event_name: 'PostToolUse',
    tool_name: 'Bash',
    tool_input: { command: 'sleep 90', run_in_background: true },
    tool_response: { stdout: '', stderr: '', backgroundTaskId: taskId },
    ...(agentId === undefined ? {} : { agent_id: agentId, agent_type: 'worker' }),
  });
}

const STOP_BASE = {
  hook_event_name: 'Stop',
  stop_hook_active: false,
  session_crons: [],
};

function shellTask(id: string, status = 'running') {
  return { id, type: 'shell', status, description: '背景のシェル', command: 'sleep 90' };
}

type NoteEvent = Extract<RunnerEvent, { type: 'note' }>;

function noteEvents(events: readonly RunnerEvent[]): NoteEvent[] {
  return events.filter((event): event is NoteEvent => event.type === 'note');
}

function stopNotes(events: readonly RunnerEvent[]): NoteEvent[] {
  return noteEvents(events).filter((note) => note.text.startsWith('Stop'));
}

let dir: string;
let host: RunnerHost | undefined;

beforeEach(() => {
  dir = makeTempDirSync('alteroid-runner-stop-');
});

afterEach(async () => {
  await host?.shutdown().catch(() => undefined);
});

function setup(): { host: RunnerHost; events: RunnerEvent[]; started: Started[] } {
  const events: RunnerEvent[] = [];
  const { fn, started } = fakeRunnerSdk();
  host = createRunnerHost({
    runnerId: 'runner-test',
    workspacePath: dir,
    emit: (event) => events.push(event),
    queryFn: fn,
    env: {},
  });
  return { host, events, started };
}

async function startSession(): Promise<{ started: Started; events: RunnerEvent[] }> {
  const s = setup();
  await s.host.start({ managerId: 'mgr-1', request: '走る', cwd: dir });
  const started = s.started[0];
  if (started === undefined) throw new Error('セッションが開いていない');
  return { started, events: s.events };
}

describe('Stop の配線（#861）', () => {
  it('マネージャーの Options に Stop フックが1本だけ載っている', async () => {
    const { started } = await startSession();
    expect(started.options.hooks?.Stop?.length).toBe(1);
    expect(started.options.hooks?.Stop?.[0]?.hooks?.length).toBe(1);
  });

  it('既存の4本（PostToolUse / PreCompact / UserPromptSubmit / SubagentStop）はそのまま載っている', async () => {
    const { started } = await startSession();
    const hooks = started.options.hooks;
    expect(hooks?.PostToolUse?.length).toBe(1);
    expect(hooks?.PreCompact?.length).toBe(1);
    expect(hooks?.UserPromptSubmit?.length).toBe(1);
    expect(hooks?.SubagentStop?.length).toBe(1);
  });
});

describe('Stop の観測 —— 在り高が 0 の回（#861）', () => {
  it('1回目は「0件で閉じた」note を出し、戻り値は { continue: true } ちょうど', async () => {
    const { started, events } = await startSession();

    const result = await fireStop(started.options, { ...STOP_BASE, background_tasks: [] });

    expect(result).toEqual({ continue: true });
    const notes = stopNotes(events);
    expect(notes.length).toBe(1);
    expect(notes[0]?.text).toContain('背景処理も session_crons も 0件 だった');
    expect(notes[0]?.text).toContain('通算 1回目');
    expect(notes[0]?.escalate).toBeUndefined();
    expect(notes[0]?.stall).toBeUndefined();
  });

  it('2回目以降は出さない（1セッションに1回だけの診断）', async () => {
    const { started, events } = await startSession();

    await fireStop(started.options, { ...STOP_BASE, background_tasks: [] });
    await fireStop(started.options, { ...STOP_BASE, background_tasks: [] });
    await fireStop(started.options, { ...STOP_BASE, background_tasks: [] });

    expect(stopNotes(events).length).toBe(1);
  });

  it('間引かれた回も通算に入っている（次に在り高が出た回の note が続きの番号を名乗る）', async () => {
    const { started, events } = await startSession();

    await fireStop(started.options, { ...STOP_BASE, background_tasks: [] });
    await fireStop(started.options, { ...STOP_BASE, background_tasks: [] });
    await registerBackgroundTask(started.options, 'bg-1');
    await fireStop(started.options, { ...STOP_BASE, background_tasks: [shellTask('bg-1')] });

    const notes = stopNotes(events);
    expect(notes.length).toBe(2);
    expect(notes[1]?.text).toContain('通算 3回目');
  });

  it('background_tasks が空でも session_crons が在れば在り高として出す', async () => {
    const { started, events } = await startSession();

    await fireStop(started.options, {
      ...STOP_BASE,
      background_tasks: [],
      session_crons: [{ id: 'cron-1', schedule: '* * * * *', recurring: false, prompt: '起きろ' }],
    });

    const notes = stopNotes(events);
    expect(notes.length).toBe(1);
    expect(notes[0]?.text).toContain('背景処理 0件 / session_crons 1件');
    expect(notes[0]?.text).not.toContain('0件 だった');
  });
});

describe('Stop の観測 —— 在り高が残っている回（#861）', () => {
  it('マネージャー自身が起こした分を owner=manager として出す', async () => {
    const { started, events } = await startSession();

    await registerBackgroundTask(started.options, 'bg-1');
    const result = await fireStop(started.options, {
      ...STOP_BASE,
      background_tasks: [shellTask('bg-1')],
    });

    expect(result).toEqual({ continue: true });
    const notes = stopNotes(events);
    expect(notes.length).toBe(1);
    expect(notes[0]?.text).toContain('マネージャー自身 1件');
    expect(notes[0]?.text).toContain('owner=manager');
    expect(notes[0]?.text).toContain('command=sleep 90');
  });

  it('作業者が起こした分を owner=worker:<agent_id> として出す', async () => {
    const { started, events } = await startSession();

    await registerBackgroundTask(started.options, 'bg-2', 'agent-xyz');
    await fireStop(started.options, { ...STOP_BASE, background_tasks: [shellTask('bg-2')] });

    const text = stopNotes(events)[0]?.text ?? '';
    expect(text).toContain('作業者 1件');
    expect(text).toContain('owner=worker:agent-xyz');
  });

  it('type=subagent は owner=delegation として数え、「引けなかった」に混ぜない', async () => {
    const { started, events } = await startSession();

    await fireStop(started.options, {
      ...STOP_BASE,
      background_tasks: [
        { id: 'agent-1', type: 'subagent', status: 'running', description: '委譲' },
      ],
    });

    const text = stopNotes(events)[0]?.text ?? '';
    expect(text).toContain('委譲そのもの 1件');
    expect(text).toContain('控えられない種類 0件');
    expect(text).toContain('引けなかった 0件');
    expect(text).toContain('owner=delegation');
    expect(text).not.toContain('所有者を引けなかった**');
  });

  it('表に無く、所有者を控えられる種類（shell）の分は owner=unresolved として、計器を疑う行を足す', async () => {
    const { started, events } = await startSession();

    await fireStop(started.options, { ...STOP_BASE, background_tasks: [shellTask('bg-orphan')] });

    const text = stopNotes(events)[0]?.text ?? '';
    expect(text).toContain('控えられない種類 0件');
    expect(text).toContain('引けなかった 1件');
    expect(text).toContain('owner=unresolved');
    expect(text).toContain('計器のほうを疑う');
  });

  // 種類は1つでは足りない: 1つだけだと「その綴りだけを除外する」実装も通ってしまう。
  const NOT_RECORDABLE_TYPES = ['monitor', 'workflow', 'local_workflow', 'remote_agent'];

  it.each(NOT_RECORDABLE_TYPES)(
    'type=%s は表に無くても owner=unrecordable として数え、「引けなかった」に混ぜない',
    async (type) => {
      const { started, events } = await startSession();

      await fireStop(started.options, {
        ...STOP_BASE,
        background_tasks: [{ id: `bg-${type}`, type, status: 'running', description: '背景' }],
      });

      const text = stopNotes(events)[0]?.text ?? '';
      expect(text).toContain('控えられない種類 1件');
      expect(text).toContain('引けなかった 0件');
      expect(text).toContain('owner=unrecordable');
      expect(text).not.toContain('所有者を引けなかった**');
    },
  );

  it('（対照）控えられない種類と shell が混ざったら、別々に数えて診断は shell の分だけで出る', async () => {
    const { started, events } = await startSession();

    await fireStop(started.options, {
      ...STOP_BASE,
      background_tasks: [
        shellTask('bg-orphan'),
        { id: 'bg-monitor', type: 'monitor', status: 'running', description: '監視' },
      ],
    });

    const text = stopNotes(events)[0]?.text ?? '';
    expect(text).toContain('控えられない種類 1件');
    expect(text).toContain('引けなかった 1件');
    expect(text).toContain('owner=unrecordable');
    expect(text).toContain('owner=unresolved');
    expect(text).toContain('所有者を引けなかった**');
    expect(text).toContain('計器のほうを疑う');
  });

  it('status を「走っている／終わった／分からない」の3つに言い分ける', async () => {
    const { started, events } = await startSession();

    await registerBackgroundTask(started.options, 'bg-live');
    await registerBackgroundTask(started.options, 'bg-done');
    await registerBackgroundTask(started.options, 'bg-huh');
    await fireStop(started.options, {
      ...STOP_BASE,
      background_tasks: [
        shellTask('bg-live', 'running'),
        shellTask('bg-done', 'completed'),
        shellTask('bg-huh', 'ぬるぬる'),
      ],
    });

    const text = stopNotes(events)[0]?.text ?? '';
    expect(text).toContain('走っている 1件 / 終わった 1件 / 分からない 1件');
    expect(text).toContain('status が既知の語彙のどちらでもない');
  });

  // 内容が同じでも畳まない: 畳むと「同じ背景処理を残したまま5回閉じた」が日誌で1回に見える。
  it('同じ在り高で2回閉じたら note も2本出す（内容が同じでも畳まない）', async () => {
    const { started, events } = await startSession();

    await registerBackgroundTask(started.options, 'bg-1');
    await fireStop(started.options, { ...STOP_BASE, background_tasks: [shellTask('bg-1')] });
    await fireStop(started.options, { ...STOP_BASE, background_tasks: [shellTask('bg-1')] });

    const notes = stopNotes(events);
    expect(notes.length).toBe(2);
    expect(notes[0]?.text).toContain('通算 1回目');
    expect(notes[1]?.text).toContain('通算 2回目');
  });

  it('note には「観測だけである」断りと、覆えない範囲の断りが両方入る', async () => {
    const { started, events } = await startSession();

    await registerBackgroundTask(started.options, 'bg-1');
    await fireStop(started.options, { ...STOP_BASE, background_tasks: [shellTask('bg-1')] });

    const text = stopNotes(events)[0]?.text ?? '';
    expect(text).toContain('これは観測だけである');
    expect(text).toContain('マネージャーが起きているときにしか来ない');
  });

  it('出した note は runnerEventSchema を通る', async () => {
    const { started, events } = await startSession();

    await registerBackgroundTask(started.options, 'bg-1');
    await fireStop(started.options, { ...STOP_BASE, background_tasks: [shellTask('bg-1')] });

    for (const note of stopNotes(events)) {
      expect(() => runnerEventSchema.parse(note)).not.toThrow();
    }
  });
});

describe('Stop は何も判断せず、何も抑制しない（#861 の段1。⛔ ここを反転させる PR は #861 を読むこと）', () => {
  const cases: { name: string; input: Record<string, unknown> }[] = [
    { name: '在り高 0', input: { ...STOP_BASE, background_tasks: [] } },
    { name: '背景処理あり', input: { ...STOP_BASE, background_tasks: [shellTask('bg-1')] } },
    {
      name: 'stop_hook_active=true',
      input: { ...STOP_BASE, stop_hook_active: true, background_tasks: [shellTask('bg-1')] },
    },
    { name: 'background_tasks が無い', input: { hook_event_name: 'Stop' } },
    { name: 'background_tasks が配列でない', input: { ...STOP_BASE, background_tasks: 'ごみ' } },
  ];

  for (const c of cases) {
    it(`${c.name}: 戻り値は { continue: true } ちょうど（decision も hookSpecificOutput も無い）`, async () => {
      const { started } = await startSession();
      const result = await fireStop(started.options, c.input);
      expect(result).toEqual({ continue: true });
    });
  }

  it('入力が null でも落ちず、continue: true を返す', async () => {
    const { started } = await startSession();
    const result = await fireStop(started.options, null as unknown as Record<string, unknown>);
    expect(result).toEqual({ continue: true });
  });

  it('入力の読み取りで例外が出ても { continue: true } を返し、失敗が note に残り、通算にも入る', async () => {
    const { started, events } = await startSession();

    const throwing: Record<string, unknown> = { ...STOP_BASE };
    Object.defineProperty(throwing, 'background_tasks', {
      enumerable: true,
      get(): never {
        throw new Error('boom-test-stop-read');
      },
    });

    const result = await fireStop(started.options, throwing);

    expect(result).toEqual({ continue: true });
    const failures = noteEvents(events).filter((note) =>
      note.text.includes('Stop の観測に失敗した'),
    );
    expect(failures).toHaveLength(1);
    expect(failures[0]?.text).toContain('boom-test-stop-read');

    await fireStop(started.options, { ...STOP_BASE, background_tasks: [] });
    const notes = stopNotes(events);
    expect(notes.at(-1)?.text).toContain('通算 2回目');
  });
});

describe('SDK の型の前提（腐ったら typecheck が落ちる）', () => {
  type ReadFields = 'background_tasks' | 'session_crons' | 'stop_hook_active';
  type MissingFields = Exclude<ReadFields, keyof StopHookInput>;

  it('#onStop が読む欄は StopHookInput に在る', () => {
    const noMissing: MissingFields extends never ? true : false = true;
    expect(noMissing).toBe(true);
  });

  type StopTask = NonNullable<StopHookInput['background_tasks']>[number];
  type SubagentStopTask = NonNullable<SubagentStopHookInput['background_tasks']>[number];
  type SameTaskType = [StopTask] extends [SubagentStopTask]
    ? [SubagentStopTask] extends [StopTask]
      ? true
      : false
    : false;

  it('Stop と SubagentStop の background_tasks[] は同じ要素型である', () => {
    const same: SameTaskType = true;
    expect(same).toBe(true);
  });

  it('その要素型は BackgroundTaskSummary である', () => {
    const isSummary: [StopTask] extends [BackgroundTaskSummary] ? true : false = true;
    expect(isSummary).toBe(true);
  });

  type ReadTaskFields = 'id' | 'type' | 'status' | 'description' | 'command';
  type MissingTaskFields = Exclude<ReadTaskFields, keyof BackgroundTaskSummary>;

  it('1行に描く欄は BackgroundTaskSummary に在る', () => {
    const noMissing: MissingTaskFields extends never ? true : false = true;
    expect(noMissing).toBe(true);
  });
});
