import type {
  HookJSONOutput,
  Options,
  Query,
  SDKMessage,
  SDKTaskUpdatedMessage,
  query as sdkQuery,
} from '@anthropic-ai/claude-agent-sdk';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { makeTempDirSync } from '../../../vitest.tmpdir.js';

import { createRunnerHost, type RunnerHost, SUBAGENT_BACKGROUND_WAIT_MS } from './runner.js';
import { runnerEventSchema, type RunnerEvent } from './runner-protocol.js';

interface Started {
  options: Options;
  finish: () => void;
  restart: (sessionId: string) => void;
  notify: (taskId: string, extra?: Record<string, unknown>) => void;
  liveTasks: (ids: readonly string[]) => void;
}

function fakeRunnerSdk(): { fn: typeof sdkQuery; started: Started[] } {
  const started: Started[] = [];
  const fn = ((input: { options: Options }) => {
    let emit: ((message: SDKMessage | null) => void) | null = null;
    const record: Started = {
      options: input.options,
      finish: () => emit?.(null),
      restart: (sessionId: string) =>
        emit?.({
          type: 'system',
          subtype: 'init',
          session_id: sessionId,
          uuid: `uuid-restart-${sessionId}`,
        } as unknown as SDKMessage),
      notify: (taskId: string, extra: Record<string, unknown> = {}) =>
        emit?.({
          type: 'system',
          subtype: 'task_notification',
          task_id: taskId,
          status: 'completed',
          output_file: '/tmp/does-not-exist.txt',
          summary: '完了',
          session_id: `sess-${started.length}`,
          uuid: `uuid-task-notification-${taskId}`,
          ...extra,
        } as unknown as SDKMessage),
      liveTasks: (ids: readonly string[]) =>
        emit?.({
          type: 'system',
          subtype: 'background_tasks_changed',
          tasks: ids.map((id) => ({ task_id: id, task_type: 'local_bash', description: '' })),
          session_id: `sess-${started.length}`,
          uuid: `uuid-live-${ids.join('-')}-${String(Math.random())}`,
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
    }) as unknown as Query;
  }) as unknown as typeof sdkQuery;

  return { fn, started };
}

async function fireSubagentStop(
  options: Options,
  input: Record<string, unknown>,
): Promise<HookJSONOutput> {
  const hook = options.hooks?.SubagentStop?.[0]?.hooks?.[0];
  if (hook === undefined) throw new Error('SubagentStop フックが登録されていない');
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

async function fireTaskNotification(
  started: Started,
  taskId: string,
  extra?: Record<string, unknown>,
): Promise<void> {
  started.notify(taskId, extra);
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function stopAfterFinish(
  started: Started,
  input: Record<string, unknown>,
  finishIds: readonly string[],
): Promise<HookJSONOutput> {
  const pending = fireSubagentStop(started.options, input);
  for (const id of finishIds) await fireTaskNotification(started, id);
  return pending;
}

async function stopUntilWaitLimit(
  started: Started,
  input: Record<string, unknown>,
): Promise<HookJSONOutput> {
  vi.useFakeTimers();
  try {
    const pending = fireSubagentStop(started.options, input);
    await vi.advanceTimersByTimeAsync(SUBAGENT_BACKGROUND_WAIT_MS);
    return await pending;
  } finally {
    vi.useRealTimers();
  }
}

async function stopAfterAllFinish(
  started: Started,
  input: Record<string, unknown>,
): Promise<HookJSONOutput> {
  const tasks = (input['background_tasks'] ?? []) as { id?: unknown }[];
  const ids = tasks
    .map((task) => task.id)
    .filter((id): id is string => typeof id === 'string' && id !== input['agent_id']);
  return stopAfterFinish(started, input, ids);
}

async function settledWithin(promise: Promise<unknown>): Promise<boolean> {
  let settled = false;
  void promise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  return settled;
}

async function fireLiveTasks(started: Started, ids: readonly string[]): Promise<void> {
  started.liveTasks(ids);
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function selfEntry(agentId: string) {
  return {
    id: agentId,
    type: 'subagent',
    status: 'running',
    description: '当人',
    agent_type: 'worker',
  };
}

const STOP_BASE = {
  hook_event_name: 'SubagentStop',
  stop_hook_active: false,
  agent_transcript_path: '/tmp/does-not-exist.jsonl',
  agent_type: 'worker',
  session_crons: [],
};

type NoteEvent = Extract<RunnerEvent, { type: 'note' }>;

function noteEvents(events: readonly RunnerEvent[]): NoteEvent[] {
  return events.filter((event): event is NoteEvent => event.type === 'note');
}

let dir: string;
let host: RunnerHost | undefined;

beforeEach(() => {
  dir = makeTempDirSync('alteroid-runner-subagent-stop-');
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
    // 既定の根（os.tmpdir() 配下の共有の名前）に触らない: runner の器では root 所有で作れず、余計な note が出るため（#4199）
    outboxRoot: join(dir, 'outbox'),
    outboxStagedRoot: join(dir, 'outbox-staged'),
  });
  return { host, events, started };
}

describe('SubagentStop の観測（#357 / #570）', () => {
  it('当人だけが載った配列では note を出さない（当人は必ず入るので、それは署名ではない）', async () => {
    const s = setup();
    await s.host.start({ managerId: 'mgr-1', request: '走る', cwd: dir });
    const started = s.started[0];
    if (started === undefined) throw new Error('セッションが開いていない');

    const result = await fireSubagentStop(started.options, {
      ...STOP_BASE,
      agent_id: 'agent-1',
      background_tasks: [selfEntry('agent-1')],
    });

    expect(result).toEqual({ continue: true });
    expect(noteEvents(s.events)).toHaveLength(0);
  });

  it('兄弟の作業者が走っているだけでは note を出さない（誤爆しないこと）', async () => {
    const s = setup();
    await s.host.start({ managerId: 'mgr-1', request: '走る', cwd: dir });
    const started = s.started[0];
    if (started === undefined) throw new Error('セッションが開いていない');

    const result = await fireSubagentStop(started.options, {
      ...STOP_BASE,
      agent_id: 'agent-1',
      background_tasks: [
        selfEntry('agent-1'),
        {
          id: 'agent-2',
          type: 'subagent',
          status: 'running',
          description: '兄弟',
          agent_type: 'worker',
        },
      ],
    });

    expect(result).toEqual({ continue: true });
    expect(noteEvents(s.events)).toHaveLength(0);
  });

  it('当人が自分で起こした背景処理が残っていれば、終わるまでフックは返らず、終わったら1回だけ起こし直す。note にも type と status と command が載る', async () => {
    const s = setup();
    await s.host.start({ managerId: 'mgr-1', request: '走る', cwd: dir });
    const started = s.started[0];
    if (started === undefined) throw new Error('セッションが開いていない');

    await registerBackgroundTask(started.options, 'bg-1', 'agent-1');

    const pending = fireSubagentStop(started.options, {
      ...STOP_BASE,
      agent_id: 'agent-1',
      background_tasks: [
        selfEntry('agent-1'),
        {
          id: 'bg-1',
          type: 'shell',
          status: 'running',
          description: 'pnpm verify を実行中',
          command: 'pnpm verify',
        },
      ],
    });

    expect(await settledWithin(pending)).toBe(false);
    expect(noteEvents(s.events)).toHaveLength(0);

    await fireTaskNotification(started, 'bg-1', { output_file: '/tmp/out-3008.txt' });
    const result = await pending;

    expect(result).toMatchObject({
      continue: true,
      hookSpecificOutput: { hookEventName: 'SubagentStop' },
    });
    const additionalContext = (result as { hookSpecificOutput: { additionalContext: string } })
      .hookSpecificOutput.additionalContext;
    expect(additionalContext).toContain('1件');
    expect(additionalContext).toContain('背景処理は終わった');
    expect(additionalContext).toContain('結果（出力）を読んでから畳むこと');
    expect(additionalContext).toContain('id=bg-1 command=pnpm verify');
    expect(additionalContext).toContain('出力: /tmp/out-3008.txt');
    expect(additionalContext).toContain('これはこの作業者の通算 1回目の起こし直し');
    expect(additionalContext).not.toContain('通し上限');
    expect(additionalContext).not.toContain('1本あたりの上限');
    expect(additionalContext).not.toContain('文字で切った');

    const notes = noteEvents(s.events);
    expect(notes).toHaveLength(1);
    const text = notes[0]?.text ?? '';
    expect(text).toContain('id=bg-1');
    expect(text).toContain('type=shell');
    expect(text).toContain('status=running');
    expect(text).toContain('command=pnpm verify');
    expect(text).toContain('1件 残ったまま畳もうとした');
    expect(text).toContain('在庫=2件');
    expect(text).toContain('完了を待ってから起こし直した');
    expect(text).toContain('この作業者の通算 1回目');
    expect(text).toContain('空転が無かった');
    expect(notes[0]?.escalate).toBeUndefined();
    expect(text).not.toContain('文字で切った');

    expect(notes[0]?.stall).toEqual({
      agentId: 'agent-1',
      agentType: 'worker',
      ownedTaskCount: 1,
      sessionTaskCount: 2,
      wakeupCount: 1,
      outcome: 'woken',
    });
  });

  it('別の作業者が起こした背景処理では note を出さない（所有者が違う）', async () => {
    const s = setup();
    await s.host.start({ managerId: 'mgr-1', request: '走る', cwd: dir });
    const started = s.started[0];
    if (started === undefined) throw new Error('セッションが開いていない');

    await registerBackgroundTask(started.options, 'bg-1', 'agent-2');

    const result = await fireSubagentStop(started.options, {
      ...STOP_BASE,
      agent_id: 'agent-1',
      background_tasks: [selfEntry('agent-1'), { id: 'bg-1', type: 'shell', status: 'running' }],
    });

    expect(result).toEqual({ continue: true });
    expect(noteEvents(s.events)).toHaveLength(0);
  });

  it('マネージャー自身が起こした背景処理では note を出さない（agent_id が付かない実行）', async () => {
    const s = setup();
    await s.host.start({ managerId: 'mgr-1', request: '走る', cwd: dir });
    const started = s.started[0];
    if (started === undefined) throw new Error('セッションが開いていない');

    await registerBackgroundTask(started.options, 'bg-1');

    const result = await fireSubagentStop(started.options, {
      ...STOP_BASE,
      agent_id: 'agent-1',
      background_tasks: [selfEntry('agent-1'), { id: 'bg-1', type: 'shell', status: 'running' }],
    });

    expect(result).toEqual({ continue: true });
    expect(noteEvents(s.events)).toHaveLength(0);
  });

  it('所有者を引けない背景処理が在ると診断が出る。ただしセッションに1回だけ', async () => {
    const s = setup();
    await s.host.start({ managerId: 'mgr-1', request: '走る', cwd: dir });
    const started = s.started[0];
    if (started === undefined) throw new Error('セッションが開いていない');

    const input = {
      ...STOP_BASE,
      agent_id: 'agent-1',
      background_tasks: [
        selfEntry('agent-1'),
        { id: 'bg-unknown', type: 'shell', status: 'running' },
      ],
    };

    const first = await fireSubagentStop(started.options, input);
    expect(first).toEqual({ continue: true });
    const notes = noteEvents(s.events);
    expect(notes).toHaveLength(1);
    const text = notes[0]?.text ?? '';
    expect(text).toContain('所有者を引けなかった');
    expect(text).toContain('bg-unknown');
    expect(text).toContain('#570');

    const second = await fireSubagentStop(started.options, input);
    expect(second).toEqual({ continue: true });
    expect(noteEvents(s.events)).toHaveLength(1);
  });

  // 1種類だけにしない: 実例を測る条件が通ってしまう。
  it.each(['monitor', 'workflow', 'local_workflow', 'remote_agent'])(
    'type=%s が表に無くても診断は出さない（控えられないのが正常）',
    async (type) => {
      const s = setup();
      await s.host.start({ managerId: 'mgr-1', request: '走る', cwd: dir });
      const started = s.started[0];
      if (started === undefined) throw new Error('セッションが開いていない');

      const result = await fireSubagentStop(started.options, {
        ...STOP_BASE,
        agent_id: 'agent-1',
        background_tasks: [selfEntry('agent-1'), { id: `bg-${type}`, type, status: 'running' }],
      });

      expect(result).toEqual({ continue: true });
      expect(noteEvents(s.events)).toHaveLength(0);
    },
  );

  it('（対照）同じ形でも type=shell なら診断が出る', async () => {
    const s = setup();
    await s.host.start({ managerId: 'mgr-1', request: '走る', cwd: dir });
    const started = s.started[0];
    if (started === undefined) throw new Error('セッションが開いていない');

    const result = await fireSubagentStop(started.options, {
      ...STOP_BASE,
      agent_id: 'agent-1',
      background_tasks: [
        selfEntry('agent-1'),
        { id: 'bg-shell', type: 'shell', status: 'running' },
      ],
    });

    expect(result).toEqual({ continue: true });
    const notes = noteEvents(s.events);
    expect(notes).toHaveLength(1);
    expect(notes[0]?.text).toContain('所有者を引けなかった');
    expect(notes[0]?.text).toContain('bg-shell');
  });

  it('当人・兄弟しか無いときは、診断も出さない（引けないのではなく、引く対象が無い）', async () => {
    const s = setup();
    await s.host.start({ managerId: 'mgr-1', request: '走る', cwd: dir });
    const started = s.started[0];
    if (started === undefined) throw new Error('セッションが開いていない');

    await fireSubagentStop(started.options, {
      ...STOP_BASE,
      agent_id: 'agent-1',
      background_tasks: [
        selfEntry('agent-1'),
        { id: 'agent-2', type: 'subagent', status: 'running', description: '兄弟' },
      ],
    });

    expect(noteEvents(s.events)).toHaveLength(0);
  });

  it('text が長すぎる入力では note も additionalContext も上限で切られ、切ったことが末尾に書かれる', async () => {
    const s = setup();
    await s.host.start({ managerId: 'mgr-1', request: '走る', cwd: dir });
    const started = s.started[0];
    if (started === undefined) throw new Error('セッションが開いていない');

    await registerBackgroundTask(started.options, 'bg-1', 'agent-1');

    const longDescription = 'あ'.repeat(5_000);
    const result = await stopAfterFinish(
      started,
      {
        ...STOP_BASE,
        agent_id: 'agent-1',
        background_tasks: [
          selfEntry('agent-1'),
          {
            id: 'bg-1',
            type: 'shell',
            status: 'running',
            description: longDescription,
            command: longDescription,
          },
        ],
      },
      ['bg-1'],
    );

    expect(result).toMatchObject({
      continue: true,
      hookSpecificOutput: { hookEventName: 'SubagentStop' },
    });
    const additionalContext = (result as { hookSpecificOutput: { additionalContext: string } })
      .hookSpecificOutput.additionalContext;
    expect(additionalContext.length).toBeLessThan(longDescription.length);
    expect(additionalContext).toContain('文字で切った');

    const notes = noteEvents(s.events);
    expect(notes).toHaveLength(1);
    const text = notes[0]?.text ?? '';
    expect(text.length).toBeLessThan(longDescription.length);
    expect(text).toContain('文字で切った');
  });

  it('待ちの上限に達した note が長すぎて切られても、id / command は生き残り、切られるのは末尾の案内文である', async () => {
    const s = setup();
    await s.host.start({ managerId: 'mgr-1', request: '走る', cwd: dir });
    const started = s.started[0];
    if (started === undefined) throw new Error('セッションが開いていない');

    await registerBackgroundTask(started.options, 'bg-1', 'agent-1');

    const longDescription = 'あ'.repeat(5_000);
    const overLimitResult = await stopUntilWaitLimit(started, {
      ...STOP_BASE,
      agent_id: 'agent-1',
      background_tasks: [
        selfEntry('agent-1'),
        {
          id: 'bg-1',
          type: 'monitor',
          status: 'running',
          command: 'pnpm test',
          description: longDescription,
        },
      ],
    });
    expect(overLimitResult).toEqual({ continue: true });

    const escalated = noteEvents(s.events).at(-1);
    expect(escalated?.text).toContain('文字で切った');
    expect(escalated?.text).toContain('id=bg-1');
    expect(escalated?.text).toContain('command=pnpm test');
    expect(escalated?.text).not.toContain('出力の置き場所は');
    expect(escalated?.text).not.toContain('SendMessage');
  });

  it('旧い上限（8）を超える回数でも、背景処理が毎回終わっていれば毎回起こし直す（打ち切りは起きない）', async () => {
    const s = setup();
    await s.host.start({ managerId: 'mgr-1', request: '走る', cwd: dir });
    const started = s.started[0];
    if (started === undefined) throw new Error('セッションが開いていない');

    const attempts = Array.from({ length: 12 }, (_unused, i) => i + 1);
    for (const n of attempts) {
      await registerBackgroundTask(started.options, `bg-${n}`, 'agent-1');
      const result = await stopAfterFinish(
        started,
        {
          ...STOP_BASE,
          agent_id: 'agent-1',
          background_tasks: [
            selfEntry('agent-1'),
            { id: `bg-${n}`, type: 'monitor', status: 'running', description: `CI の見張り ${n}` },
          ],
        },
        [`bg-${n}`],
      );
      expect(result).toMatchObject({
        continue: true,
        hookSpecificOutput: { hookEventName: 'SubagentStop' },
      });
      const additionalContext = (result as { hookSpecificOutput: { additionalContext: string } })
        .hookSpecificOutput.additionalContext;
      expect(additionalContext).toContain(`これはこの作業者の通算 ${String(n)}回目の起こし直し`);
    }

    const notes = noteEvents(s.events);
    expect(notes).toHaveLength(attempts.length);
    expect(notes[0]?.text).toContain('type=monitor');
    expect(notes.at(-1)?.text).toContain(`CI の見張り ${String(attempts.length)}`);
    for (const note of notes) {
      expect(note.stall?.outcome).toBe('woken');
      expect(note.escalate).toBeUndefined();
    }
    expect(notes.at(-1)?.stall?.wakeupCount).toBe(attempts.length);
  });

  it('別の作業者の背景処理は待ちの条件に入らない（当人の分が終われば、兄弟の分が走っていても起こし直す）', async () => {
    const s = setup();
    await s.host.start({ managerId: 'mgr-1', request: '走る', cwd: dir });
    const started = s.started[0];
    if (started === undefined) throw new Error('セッションが開いていない');

    await registerBackgroundTask(started.options, 'bg-mine', 'agent-1');
    await registerBackgroundTask(started.options, 'bg-sibling', 'agent-2');

    const result = await stopAfterFinish(
      started,
      {
        ...STOP_BASE,
        agent_id: 'agent-1',
        background_tasks: [
          selfEntry('agent-1'),
          { id: 'bg-mine', type: 'shell', status: 'running', command: 'pnpm test' },
          { id: 'bg-sibling', type: 'shell', status: 'running', command: 'pnpm lint' },
        ],
      },
      ['bg-mine'],
    );

    expect(result).toHaveProperty('hookSpecificOutput');
    const context = (result as { hookSpecificOutput: { additionalContext: string } })
      .hookSpecificOutput.additionalContext;
    expect(context).toContain('id=bg-mine');
    expect(context).not.toContain('bg-sibling');
  });

  it('1回に複数の背景処理が残っていたら、全部が終わるまで返らず、全部終わったら1回だけ起こし直す', async () => {
    const s = setup();
    await s.host.start({ managerId: 'mgr-1', request: '走る', cwd: dir });
    const started = s.started[0];
    if (started === undefined) throw new Error('セッションが開いていない');

    await registerBackgroundTask(started.options, 'bg-x', 'agent-1');
    await registerBackgroundTask(started.options, 'bg-y', 'agent-1');

    const pending = fireSubagentStop(started.options, {
      ...STOP_BASE,
      agent_id: 'agent-1',
      background_tasks: [
        selfEntry('agent-1'),
        { id: 'bg-x', type: 'monitor', status: 'running' },
        { id: 'bg-y', type: 'monitor', status: 'running' },
      ],
    });

    await fireTaskNotification(started, 'bg-x', { output_file: '/tmp/x.txt' });
    expect(await settledWithin(pending)).toBe(false);

    await fireTaskNotification(started, 'bg-y', { output_file: '/tmp/y.txt' });
    const second = await pending;
    const context = (second as { hookSpecificOutput: { additionalContext: string } })
      .hookSpecificOutput.additionalContext;
    expect(context).toContain('2件');
    expect(context).toContain('id=bg-x');
    expect(context).toContain('/tmp/x.txt');
    expect(context).toContain('id=bg-y');
    expect(context).toContain('/tmp/y.txt');
    expect(noteEvents(s.events)).toHaveLength(1);
  });

  it('background_tasks_changed で載っていた背景処理が載らなくなったら、完了通知が無くても起こし直す', async () => {
    const s = setup();
    await s.host.start({ managerId: 'mgr-1', request: '走る', cwd: dir });
    const started = s.started[0];
    if (started === undefined) throw new Error('セッションが開いていない');

    await registerBackgroundTask(started.options, 'bg-1', 'agent-1');
    await fireLiveTasks(started, ['bg-1']);

    const pending = fireSubagentStop(started.options, {
      ...STOP_BASE,
      agent_id: 'agent-1',
      background_tasks: [selfEntry('agent-1'), { id: 'bg-1', type: 'shell', status: 'running' }],
    });
    expect(await settledWithin(pending)).toBe(false);
    await fireLiveTasks(started, ['bg-1']);
    expect(await settledWithin(pending)).toBe(false);

    await fireLiveTasks(started, []);
    expect(await pending).toHaveProperty('hookSpecificOutput');
  });

  // 「載っていない＝終わった」にしない: 載っていたことを見ていない id は id 空間が違う場合と区別が付かず、待たずに毎回起こし直して空転が無限になる。
  it('liveBackgroundTasks に載っていたことが無い背景処理は、載っていないだけでは終わったとしない', async () => {
    const s = setup();
    await s.host.start({ managerId: 'mgr-1', request: '走る', cwd: dir });
    const started = s.started[0];
    if (started === undefined) throw new Error('セッションが開いていない');

    await registerBackgroundTask(started.options, 'bg-1', 'agent-1');
    await fireLiveTasks(started, ['something-else']);

    const pending = fireSubagentStop(started.options, {
      ...STOP_BASE,
      agent_id: 'agent-1',
      background_tasks: [selfEntry('agent-1'), { id: 'bg-1', type: 'shell', status: 'running' }],
    });
    await fireLiveTasks(started, []);
    expect(await settledWithin(pending)).toBe(false);

    await fireTaskNotification(started, 'bg-1');
    expect(await pending).toHaveProperty('hookSpecificOutput');
  });

  it('フックの発火より前に完了通知が届いていた背景処理は、待たずに起こし直す', async () => {
    const s = setup();
    await s.host.start({ managerId: 'mgr-1', request: '走る', cwd: dir });
    const started = s.started[0];
    if (started === undefined) throw new Error('セッションが開いていない');

    await registerBackgroundTask(started.options, 'bg-1', 'agent-1');
    await fireTaskNotification(started, 'bg-1', { output_file: '/tmp/early.txt' });

    const result = await fireSubagentStop(started.options, {
      ...STOP_BASE,
      agent_id: 'agent-1',
      background_tasks: [selfEntry('agent-1'), { id: 'bg-1', type: 'shell', status: 'running' }],
    });
    const context = (result as { hookSpecificOutput: { additionalContext: string } })
      .hookSpecificOutput.additionalContext;
    expect(context).toContain('/tmp/early.txt');
  });

  describe('待ちの上限（30分）に達したら', () => {
    it('起こし直さず、escalate な limit_reached の note が出る。文言は「待ちの上限」である', async () => {
      const s = setup();
      await s.host.start({ managerId: 'mgr-1', request: '走る', cwd: dir });
      const started = s.started[0];
      if (started === undefined) throw new Error('セッションが開いていない');

      await registerBackgroundTask(started.options, 'bg-1', 'agent-1');
      const result = await stopUntilWaitLimit(started, {
        ...STOP_BASE,
        agent_id: 'agent-1',
        background_tasks: [
          selfEntry('agent-1'),
          { id: 'bg-1', type: 'monitor', status: 'running', command: 'pnpm test' },
        ],
      });

      expect(result).toEqual({ continue: true });

      const notes = noteEvents(s.events);
      expect(notes).toHaveLength(1);
      const escalated = notes[0];
      expect(escalated?.escalate).toBe(true);
      expect(escalated?.text).toContain('起こし直さずに打ち切った');
      expect(escalated?.text).toContain('30 分（待ちの上限）');
      expect(escalated?.text).not.toContain('通し上限');
      expect(escalated?.text).not.toContain('1本あたりの上限');
      expect(escalated?.text).toContain('id=bg-1');
      expect(escalated?.text).toContain('command=pnpm test');
      expect(escalated?.text).toContain('出力の置き場所は、処理が終わったら知らせる（#1554）');
      expect(escalated?.text).toContain('ToolSearch');
      expect(escalated?.text).toContain('select:SendMessage');
      expect(escalated?.text).toContain('agentId=agent-1');
      expect(escalated?.text).toContain('即時ではない');
      expect(escalated?.stall).toEqual({
        agentId: 'agent-1',
        agentType: 'worker',
        ownedTaskCount: 1,
        sessionTaskCount: 2,
        wakeupCount: 0,
        outcome: 'limit_reached',
      });
    });

    it('待ちの上限ちょうどの1ミリ秒前までは返らない（上限は SUBAGENT_BACKGROUND_WAIT_MS）', async () => {
      const s = setup();
      await s.host.start({ managerId: 'mgr-1', request: '走る', cwd: dir });
      const started = s.started[0];
      if (started === undefined) throw new Error('セッションが開いていない');

      await registerBackgroundTask(started.options, 'bg-1', 'agent-1');
      vi.useFakeTimers();
      try {
        const pending = fireSubagentStop(started.options, {
          ...STOP_BASE,
          agent_id: 'agent-1',
          background_tasks: [
            selfEntry('agent-1'),
            { id: 'bg-1', type: 'monitor', status: 'running' },
          ],
        });
        let returned = false;
        void pending.then(() => {
          returned = true;
        });
        await vi.advanceTimersByTimeAsync(SUBAGENT_BACKGROUND_WAIT_MS - 1);
        expect(returned).toBe(false);
        expect(noteEvents(s.events)).toHaveLength(0);
        await vi.advanceTimersByTimeAsync(1);
        await pending;
        expect(returned).toBe(true);
        expect(noteEvents(s.events).at(-1)?.stall?.outcome).toBe('limit_reached');
      } finally {
        vi.useRealTimers();
      }
    });

    it('agent_id が違えば独立している（一方が打ち切られても、他方は完了を待って起こし直される）', async () => {
      const s = setup();
      await s.host.start({ managerId: 'mgr-1', request: '走る', cwd: dir });
      const started = s.started[0];
      if (started === undefined) throw new Error('セッションが開いていない');

      await registerBackgroundTask(started.options, 'a1-bg-1', 'agent-1');
      await stopUntilWaitLimit(started, {
        ...STOP_BASE,
        agent_id: 'agent-1',
        background_tasks: [
          selfEntry('agent-1'),
          { id: 'a1-bg-1', type: 'monitor', status: 'running' },
        ],
      });

      await registerBackgroundTask(started.options, 'a2-bg-1', 'agent-2');
      const agent2 = await stopAfterFinish(
        started,
        {
          ...STOP_BASE,
          agent_id: 'agent-2',
          background_tasks: [
            selfEntry('agent-2'),
            { id: 'a2-bg-1', type: 'monitor', status: 'running' },
          ],
        },
        ['a2-bg-1'],
      );
      expect(agent2).toHaveProperty('hookSpecificOutput');
      const last = noteEvents(s.events).at(-1);
      expect(last?.stall?.agentId).toBe('agent-2');
      expect(last?.stall?.outcome).toBe('woken');
      expect(last?.escalate).toBeUndefined();
    });

    it('打ち切った後でも、同じ作業者が背景処理を残して畳もうとすれば、また完了を待って起こし直す', async () => {
      const s = setup();
      await s.host.start({ managerId: 'mgr-1', request: '走る', cwd: dir });
      const started = s.started[0];
      if (started === undefined) throw new Error('セッションが開いていない');

      await registerBackgroundTask(started.options, 'bg-1', 'agent-1');
      await stopUntilWaitLimit(started, {
        ...STOP_BASE,
        agent_id: 'agent-1',
        background_tasks: [
          selfEntry('agent-1'),
          { id: 'bg-1', type: 'monitor', status: 'running' },
        ],
      });
      await registerBackgroundTask(started.options, 'bg-2', 'agent-1');
      const result = await stopAfterFinish(
        started,
        {
          ...STOP_BASE,
          agent_id: 'agent-1',
          background_tasks: [
            selfEntry('agent-1'),
            { id: 'bg-2', type: 'monitor', status: 'running' },
          ],
        },
        ['bg-2'],
      );
      expect(result).toHaveProperty('hookSpecificOutput');
    });
  });

  it('待っている途中で stop されたら、フックは起こし直さずに返る（打ち切りの注記も出さない）', async () => {
    const s = setup();
    await s.host.start({ managerId: 'mgr-1', request: '走る', cwd: dir });
    const started = s.started[0];
    if (started === undefined) throw new Error('セッションが開いていない');

    await registerBackgroundTask(started.options, 'bg-1', 'agent-1');
    const pending = fireSubagentStop(started.options, {
      ...STOP_BASE,
      agent_id: 'agent-1',
      background_tasks: [selfEntry('agent-1'), { id: 'bg-1', type: 'shell', status: 'running' }],
    });
    expect(await settledWithin(pending)).toBe(false);

    await s.host.shutdown();

    expect(await pending).toEqual({ continue: true });
    const notes = noteEvents(s.events);
    expect(notes).toHaveLength(1);
    expect(notes[0]?.text).toContain('セッションが畳まれた');
    expect(notes[0]?.text).toContain('起こし直さずに返した');
    expect(notes[0]?.stall).toBeUndefined();
    expect(notes[0]?.escalate).toBeUndefined();
  });

  it('既に stop 済みのセッションで発火したフックは、待たずに返る', async () => {
    const s = setup();
    await s.host.start({ managerId: 'mgr-1', request: '走る', cwd: dir });
    const started = s.started[0];
    if (started === undefined) throw new Error('セッションが開いていない');

    await registerBackgroundTask(started.options, 'bg-1', 'agent-1');
    await s.host.shutdown();

    const result = await fireSubagentStop(started.options, {
      ...STOP_BASE,
      agent_id: 'agent-1',
      background_tasks: [selfEntry('agent-1'), { id: 'bg-1', type: 'shell', status: 'running' }],
    });
    expect(result).toEqual({ continue: true });
  });

  // 上限値を直書きする: `BACKGROUND_TASK_OWNER_LIMIT` は `export` されていない。ずれたらこの歯が壊れる。
  it('#backgroundTaskOwners は上限（500件）を超えたら、いちばん古い所有者から捨てる（引けなくなる）', async () => {
    const s = setup();
    await s.host.start({ managerId: 'mgr-1', request: '走る', cwd: dir });
    const started = s.started[0];
    if (started === undefined) throw new Error('セッションが開いていない');

    const ownerLimit = 500;

    for (let n = 1; n <= ownerLimit + 1; n += 1) {
      await registerBackgroundTask(started.options, `bg-owner-${n}`, `agent-owner-${n}`);
    }

    const result = await fireSubagentStop(started.options, {
      ...STOP_BASE,
      agent_id: 'agent-owner-1',
      background_tasks: [
        selfEntry('agent-owner-1'),
        { id: 'bg-owner-1', type: 'shell', status: 'running' },
      ],
    });

    expect(result).toEqual({ continue: true });
    const notes = noteEvents(s.events);
    expect(notes).toHaveLength(1);
    expect(notes[0]?.text).toContain('所有者を引けなかった');
    expect(notes[0]?.text).toContain('bg-owner-1');
  });

  // 対照が無いと、直上の歯は LRU の `while` ループを丸ごと壊す変異にしか効かない。
  it('（対照）501件積まなければ、同じ所有者は引けて起こし直し側へ落ちる', async () => {
    const s = setup();
    await s.host.start({ managerId: 'mgr-1', request: '走る', cwd: dir });
    const started = s.started[0];
    if (started === undefined) throw new Error('セッションが開いていない');

    await registerBackgroundTask(started.options, 'bg-owner-1', 'agent-owner-1');

    const result = await stopAfterAllFinish(started, {
      ...STOP_BASE,
      agent_id: 'agent-owner-1',
      background_tasks: [
        selfEntry('agent-owner-1'),
        { id: 'bg-owner-1', type: 'shell', status: 'running' },
      ],
    });

    expect(result).toMatchObject({
      continue: true,
      hookSpecificOutput: { hookEventName: 'SubagentStop' },
    });
    const notes = noteEvents(s.events);
    expect(notes).toHaveLength(1);
    expect(notes[0]?.text).not.toContain('所有者を引けなかった');
  });

  it('stop_hook_active が取れないときは note にその行を作らない（既定値を作らない）', async () => {
    const s = setup();
    await s.host.start({ managerId: 'mgr-1', request: '走る', cwd: dir });
    const started = s.started[0];
    if (started === undefined) throw new Error('セッションが開いていない');

    await registerBackgroundTask(started.options, 'bg-1', 'agent-1');

    const withoutStopHookActive: Record<string, unknown> = { ...STOP_BASE };
    delete withoutStopHookActive.stop_hook_active;
    const result = await stopAfterAllFinish(started, {
      ...withoutStopHookActive,
      agent_id: 'agent-1',
      background_tasks: [selfEntry('agent-1'), { id: 'bg-1', type: 'shell', status: 'running' }],
    });

    expect(result).toHaveProperty('hookSpecificOutput');
    const notes = noteEvents(s.events);
    expect(notes).toHaveLength(1);
    expect(notes[0]?.text).not.toContain('stop_hook_active');
  });

  it('stop_hook_active が取れているときは note にその値を載せる', async () => {
    const s = setup();
    await s.host.start({ managerId: 'mgr-1', request: '走る', cwd: dir });
    const started = s.started[0];
    if (started === undefined) throw new Error('セッションが開いていない');

    await registerBackgroundTask(started.options, 'bg-1', 'agent-1');

    const result = await stopAfterAllFinish(started, {
      ...STOP_BASE,
      stop_hook_active: true,
      agent_id: 'agent-1',
      background_tasks: [selfEntry('agent-1'), { id: 'bg-1', type: 'shell', status: 'running' }],
    });

    expect(result).toHaveProperty('hookSpecificOutput');
    const notes = noteEvents(s.events);
    expect(notes).toHaveLength(1);
    expect(notes[0]?.text).toContain('stop_hook_active=true');
  });

  it('入力の読み取りで例外が出ても、起こし直さず { continue: true } へ倒れ、失敗が note に残る', async () => {
    const s = setup();
    await s.host.start({ managerId: 'mgr-1', request: '走る', cwd: dir });
    const started = s.started[0];
    if (started === undefined) throw new Error('セッションが開いていない');

    const throwing: Record<string, unknown> = { ...STOP_BASE, agent_id: 'agent-1' };
    Object.defineProperty(throwing, 'background_tasks', {
      enumerable: true,
      get(): never {
        throw new Error('boom-test-570');
      },
    });

    const result = await fireSubagentStop(started.options, throwing);

    expect(result).toEqual({ continue: true });
    const notes = noteEvents(s.events);
    expect(notes).toHaveLength(1);
    expect(notes[0]?.text).toContain('SubagentStop の観測に失敗した');
    expect(notes[0]?.text).toContain('boom-test-570');
    expect(notes[0]?.escalate).toBeUndefined();
    expect(notes[0]?.stall).toBeUndefined();
  });
});

// `JSON.parse(JSON.stringify(...))` を通す: 同一プロセスのテストは、境界で `undefined` の欄がキーごと落ちる壊れ方を再現しない。
describe('note.stall のスキーマ（境界を越える形。Issue #357）', () => {
  it('stall 無しの note は今までどおり境界を通る（後方互換）', () => {
    const parsed = runnerEventSchema.safeParse(
      JSON.parse(
        JSON.stringify({
          type: 'note',
          managerId: 'mgr-1',
          text: '旧 runner からの note',
        }),
      ),
    );
    expect(parsed.success).toBe(true);
  });

  it('stall 付きの note（agentType 有り）が境界を通り、値がそのまま保たれる', () => {
    const parsed = runnerEventSchema.safeParse(
      JSON.parse(
        JSON.stringify({
          type: 'note',
          managerId: 'mgr-1',
          text: '起こし直した（1回目 / 上限 2）。',
          stall: {
            agentId: 'agent-1',
            agentType: 'worker',
            ownedTaskCount: 1,
            sessionTaskCount: 2,
            wakeupCount: 1,
            outcome: 'woken',
          },
        }),
      ),
    );
    expect(parsed.success).toBe(true);
    if (parsed.success && parsed.data.type === 'note') {
      expect(parsed.data.stall).toEqual({
        agentId: 'agent-1',
        agentType: 'worker',
        ownedTaskCount: 1,
        sessionTaskCount: 2,
        wakeupCount: 1,
        outcome: 'woken',
      });
    }
  });

  it('stall.agentType が無くても境界を通る（取れなかった回の実機の形）', () => {
    const parsed = runnerEventSchema.safeParse(
      JSON.parse(
        JSON.stringify({
          type: 'note',
          managerId: 'mgr-1',
          text: '起こし直さなかった。',
          stall: {
            agentId: 'agent-1',
            ownedTaskCount: 1,
            sessionTaskCount: 1,
            wakeupCount: 2,
            outcome: 'limit_reached',
          },
        }),
      ),
    );
    expect(parsed.success).toBe(true);
    if (parsed.success && parsed.data.type === 'note') {
      expect(parsed.data.stall).not.toHaveProperty('agentType');
    }
  });

  it('stall の必須欄（ownedTaskCount）が欠けると境界のスキーマで落ちる', () => {
    const parsed = runnerEventSchema.safeParse(
      JSON.parse(
        JSON.stringify({
          type: 'note',
          managerId: 'mgr-1',
          text: '不完全な stall。',
          stall: {
            agentId: 'agent-1',
            sessionTaskCount: 1,
            wakeupCount: 1,
            outcome: 'woken',
          },
        }),
      ),
    );
    expect(parsed.success).toBe(false);
  });

  it('stall.outcome が未知の値だと境界のスキーマで落ちる', () => {
    const parsed = runnerEventSchema.safeParse(
      JSON.parse(
        JSON.stringify({
          type: 'note',
          managerId: 'mgr-1',
          text: 'おかしな outcome。',
          stall: {
            agentId: 'agent-1',
            ownedTaskCount: 1,
            sessionTaskCount: 1,
            wakeupCount: 1,
            outcome: 'unknown_outcome',
          },
        }),
      ),
    );
    expect(parsed.success).toBe(false);
  });
});

describe('status で「走っている／終わった／分からない」を分ける（#570 の追跡）', () => {
  it('status が終わった側の1件だけなら additionalContext を返さない', async () => {
    const s = setup();
    await s.host.start({ managerId: 'mgr-1', request: '走る', cwd: dir });
    const started = s.started[0];
    if (started === undefined) throw new Error('セッションが開いていない');
    await registerBackgroundTask(started.options, 'bg-1', 'agent-1');

    const result = await fireSubagentStop(started.options, {
      ...STOP_BASE,
      agent_id: 'agent-1',
      background_tasks: [
        selfEntry('agent-1'),
        {
          id: 'bg-1',
          type: 'shell',
          status: 'completed',
          description: '門',
          command: 'pnpm verify',
        },
      ],
    });

    expect(result).toEqual({ continue: true });
  });

  it('起こし直さない代わりに診断を出す（黙って「きれいに畳んだ」に化けない）', async () => {
    const s = setup();
    await s.host.start({ managerId: 'mgr-1', request: '走る', cwd: dir });
    const started = s.started[0];
    if (started === undefined) throw new Error('セッションが開いていない');
    await registerBackgroundTask(started.options, 'bg-1', 'agent-1');

    await fireSubagentStop(started.options, {
      ...STOP_BASE,
      agent_id: 'agent-1',
      background_tasks: [
        selfEntry('agent-1'),
        { id: 'bg-1', type: 'shell', status: 'completed', description: '門' },
      ],
    });

    const notes = noteEvents(s.events);
    expect(notes).toHaveLength(1);
    expect(notes[0]?.text).toContain('status は全部「終わった」側だった');
    expect(notes[0]?.text).toContain('status=completed');
    expect(notes[0]?.stall).toBeUndefined();
  });

  it('診断は1セッションに1回だけ出る', async () => {
    const s = setup();
    await s.host.start({ managerId: 'mgr-1', request: '走る', cwd: dir });
    const started = s.started[0];
    if (started === undefined) throw new Error('セッションが開いていない');
    await registerBackgroundTask(started.options, 'bg-1', 'agent-1');
    await registerBackgroundTask(started.options, 'bg-2', 'agent-2');

    for (const [agentId, taskId] of [
      ['agent-1', 'bg-1'],
      ['agent-2', 'bg-2'],
    ] as const) {
      await fireSubagentStop(started.options, {
        ...STOP_BASE,
        agent_id: agentId,
        background_tasks: [
          selfEntry(agentId),
          { id: taskId, type: 'shell', status: 'killed', description: '門' },
        ],
      });
    }

    expect(noteEvents(s.events)).toHaveLength(1);
  });

  it('走っているものと終わったものが混ざったら、終わった分を数に入れず、そう書く', async () => {
    const s = setup();
    await s.host.start({ managerId: 'mgr-1', request: '走る', cwd: dir });
    const started = s.started[0];
    if (started === undefined) throw new Error('セッションが開いていない');
    await registerBackgroundTask(started.options, 'bg-live', 'agent-1');
    await registerBackgroundTask(started.options, 'bg-done', 'agent-1');

    const result = await stopAfterAllFinish(started, {
      ...STOP_BASE,
      agent_id: 'agent-1',
      background_tasks: [
        selfEntry('agent-1'),
        {
          id: 'bg-live',
          type: 'shell',
          status: 'running',
          description: '走っている門',
          command: 'live-cmd',
        },
        {
          id: 'bg-done',
          type: 'shell',
          status: 'completed',
          description: '終わった門',
          command: 'done-cmd',
        },
      ],
    });

    expect(result).toMatchObject({
      continue: true,
      hookSpecificOutput: { hookEventName: 'SubagentStop' },
    });
    const additionalContext = (result as { hookSpecificOutput: { additionalContext: string } })
      .hookSpecificOutput.additionalContext;
    expect(additionalContext).toContain('背景処理が 1件');
    expect(additionalContext).toContain('1件 は status が「終わった」側だった');
    expect(additionalContext).toContain('id=bg-live command=live-cmd');
    expect(additionalContext).not.toContain('bg-done');
    expect(additionalContext).not.toContain('done-cmd');

    const notes = noteEvents(s.events);
    expect(notes[0]?.text).toContain('背景処理が 1件 残ったまま');
    expect(notes[0]?.stall?.ownedTaskCount).toBe(1);
  });

  it('未知の status は「走っている」へ倒して起こし直し、分からなかったことを書く', async () => {
    const s = setup();
    await s.host.start({ managerId: 'mgr-1', request: '走る', cwd: dir });
    const started = s.started[0];
    if (started === undefined) throw new Error('セッションが開いていない');
    await registerBackgroundTask(started.options, 'bg-1', 'agent-1');

    const result = await stopAfterAllFinish(started, {
      ...STOP_BASE,
      agent_id: 'agent-1',
      background_tasks: [
        selfEntry('agent-1'),
        { id: 'bg-1', type: 'shell', status: 'とつぜんの新語', description: '門' },
      ],
    });

    // キャストの前に欄の存在を断言する: しないと、キャストが嘘をついて赤が `TypeError` で出る。
    expect(result).toMatchObject({
      continue: true,
      hookSpecificOutput: { hookEventName: 'SubagentStop' },
    });
    const additionalContext = (result as { hookSpecificOutput: { additionalContext: string } })
      .hookSpecificOutput.additionalContext;
    expect(additionalContext).toContain('背景処理が 1件');
    expect(additionalContext).toContain('status が既知の語彙のどちらでもない');
    expect(noteEvents(s.events)[0]?.text).toContain('status が既知の語彙のどちらでもない');
  });

  it('status の欄が無ければ「走っている」へ倒す', async () => {
    const s = setup();
    await s.host.start({ managerId: 'mgr-1', request: '走る', cwd: dir });
    const started = s.started[0];
    if (started === undefined) throw new Error('セッションが開いていない');
    await registerBackgroundTask(started.options, 'bg-1', 'agent-1');

    const result = await stopAfterAllFinish(started, {
      ...STOP_BASE,
      agent_id: 'agent-1',
      background_tasks: [selfEntry('agent-1'), { id: 'bg-1', type: 'shell', description: '門' }],
    });

    expect(result).toMatchObject({
      continue: true,
      hookSpecificOutput: { hookEventName: 'SubagentStop' },
    });
  });
});

describe('上限に達した後の note を間引く（#1385）', () => {
  it('待ちの上限に達した同じ agentId で SubagentStop を10回鳴らすと、note は10件出て escalate は1・3・9回目だけ', async () => {
    const s = setup();
    await s.host.start({ managerId: 'mgr-1', request: '走る', cwd: dir });
    const started = s.started[0];
    if (started === undefined) throw new Error('セッションが開いていない');

    await registerBackgroundTask(started.options, 'bg-over', 'agent-1');
    const before = noteEvents(s.events).length;
    for (let n = 1; n <= 10; n += 1) {
      const result = await stopUntilWaitLimit(started, {
        ...STOP_BASE,
        agent_id: 'agent-1',
        background_tasks: [
          selfEntry('agent-1'),
          { id: 'bg-over', type: 'monitor', status: 'running' },
        ],
      });
      expect(result).toEqual({ continue: true });
    }

    const notes = noteEvents(s.events).slice(before);
    expect(notes).toHaveLength(10);
    for (const note of notes) expect(note.stall?.outcome).toBe('limit_reached');

    const escalateFlags = notes.map((note) => note.escalate === true);
    expect(escalateFlags).toEqual([
      true, // 1回目
      false, // 2回目
      true, // 3回目
      false, // 4回目
      false, // 5回目
      false, // 6回目
      false, // 7回目
      false, // 8回目
      true, // 9回目
      false, // 10回目
    ]);

    for (const [index, note] of notes.entries()) {
      const n = index + 1;
      expect(note.text).toContain(
        `打ち切ってから ${String(n)}回目（1・3・9…回目だけクローンへ上げる）`,
      );
    }
  });

  it('別の agentId は独立に数えられる（片方が上限後9回目でも、もう片方の1回目は escalate）', async () => {
    const s = setup();
    await s.host.start({ managerId: 'mgr-1', request: '走る', cwd: dir });
    const started = s.started[0];
    if (started === undefined) throw new Error('セッションが開いていない');

    await registerBackgroundTask(started.options, 'a1-bg-over', 'agent-1');
    for (let n = 1; n <= 9; n += 1) {
      await stopUntilWaitLimit(started, {
        ...STOP_BASE,
        agent_id: 'agent-1',
        background_tasks: [
          selfEntry('agent-1'),
          { id: 'a1-bg-over', type: 'monitor', status: 'running' },
        ],
      });
    }
    const agent1Notes = noteEvents(s.events).filter(
      (note) => note.stall?.agentId === 'agent-1' && note.stall?.outcome === 'limit_reached',
    );
    expect(agent1Notes).toHaveLength(9);
    expect(agent1Notes.at(-1)?.escalate).toBe(true);

    await registerBackgroundTask(started.options, 'a2-bg-over', 'agent-2');
    await stopUntilWaitLimit(started, {
      ...STOP_BASE,
      agent_id: 'agent-2',
      background_tasks: [
        selfEntry('agent-2'),
        { id: 'a2-bg-over', type: 'monitor', status: 'running' },
      ],
    });
    const agent2Notes = noteEvents(s.events).filter(
      (note) => note.stall?.agentId === 'agent-2' && note.stall?.outcome === 'limit_reached',
    );
    expect(agent2Notes).toHaveLength(1);
    expect(agent2Notes[0]?.escalate).toBe(true);
    expect(agent2Notes[0]?.text).toContain(
      '打ち切ってから 1回目（1・3・9…回目だけクローンへ上げる）',
    );
  });
});

// 逐語の印（`check-sdk-quotes`）だけにしない: 語彙が増えても文言の変化として検出できるとは限らないので、型でも当てる。
describe('SDK の status の語彙の前提（腐ったら typecheck が落ちる）', () => {
  type TaskStatus = NonNullable<SDKTaskUpdatedMessage['patch']['status']>;
  type Assumed = 'pending' | 'running' | 'paused' | 'completed' | 'failed' | 'killed';
  type Extra = Exclude<TaskStatus, Assumed>;
  type Missing = Exclude<Assumed, TaskStatus>;

  it('想定した6語で全部である', () => {
    const noExtra: Extra extends never ? true : false = true;
    const noMissing: Missing extends never ? true : false = true;
    expect(noExtra).toBe(true);
    expect(noMissing).toBe(true);
  });
});

async function cutOff(started: Started, agentId: string): Promise<void> {
  await registerBackgroundTask(started.options, `bg-${agentId}`, agentId);
  await stopUntilWaitLimit(started, {
    ...STOP_BASE,
    agent_id: agentId,
    background_tasks: [
      selfEntry(agentId),
      { id: `bg-${agentId}`, type: 'monitor', status: 'running', command: 'sleep 90' },
    ],
  });
}

function taskResult(agentId: string, extra: Record<string, unknown> = {}) {
  return {
    hook_event_name: 'PostToolUse',
    tool_name: 'Agent',
    tool_input: { prompt: '作業' },
    tool_response: { status: 'completed', agentId, content: [], ...extra },
  };
}

describe('打ち切った作業者の Task の結果に注記する（#901）', () => {
  it('待ちの上限で打ち切った作業者の Task の結果には additionalContext が付き、note も残る', async () => {
    const s = setup();
    await s.host.start({ managerId: 'mgr-1', request: '走る', cwd: dir });
    const started = s.started[0];
    if (started === undefined) throw new Error('セッションが開いていない');

    await cutOff(started, 'agent-1');
    const result = await firePostToolUse(started.options, taskResult('agent-1'));

    expect(result).toMatchObject({
      continue: true,
      hookSpecificOutput: { hookEventName: 'PostToolUse' },
    });
    const context = (result as { hookSpecificOutput?: { additionalContext?: string } })
      .hookSpecificOutput?.additionalContext;
    expect(context).toContain('agent_id=agent-1');
    expect(context).toContain('完結していない可能性がある');
    expect(context).toContain('id=bg-agent-1');
    expect(context).toContain('command=sleep 90');
    expect(context).toContain('出力の置き場所は、処理が終わったら知らせる（#1554）');
    expect(context).toContain('ToolSearch');
    expect(context).toContain('select:SendMessage');
    expect(context).toContain('agentId=agent-1');
    expect(noteEvents(s.events).at(-1)?.text).toContain('Task の結果に注記した（#901）');
  });

  it('注記は1回だけ（同じ agentId の2回目の結果には付かない）', async () => {
    const s = setup();
    await s.host.start({ managerId: 'mgr-1', request: '走る', cwd: dir });
    const started = s.started[0];
    if (started === undefined) throw new Error('セッションが開いていない');

    await cutOff(started, 'agent-1');
    await firePostToolUse(started.options, taskResult('agent-1'));
    expect(await firePostToolUse(started.options, taskResult('agent-1'))).toEqual({
      continue: true,
    });
  });

  it('打ち切っていない作業者の結果には付かない（完了を待って起こし直しただけの作業者も含む）', async () => {
    const s = setup();
    await s.host.start({ managerId: 'mgr-1', request: '走る', cwd: dir });
    const started = s.started[0];
    if (started === undefined) throw new Error('セッションが開いていない');

    await registerBackgroundTask(started.options, 'bg-2', 'agent-2');
    await stopAfterAllFinish(started, {
      ...STOP_BASE,
      agent_id: 'agent-2',
      background_tasks: [selfEntry('agent-2'), { id: 'bg-2', type: 'monitor', status: 'running' }],
    });
    expect(await firePostToolUse(started.options, taskResult('agent-2'))).toEqual({
      continue: true,
    });
    expect(await firePostToolUse(started.options, taskResult('agent-3'))).toEqual({
      continue: true,
    });
  });

  it('作業者の中で発火した PostToolUse（agent_id 付き）や、completed 以外の結果には付けない', async () => {
    const s = setup();
    await s.host.start({ managerId: 'mgr-1', request: '走る', cwd: dir });
    const started = s.started[0];
    if (started === undefined) throw new Error('セッションが開いていない');

    await cutOff(started, 'agent-1');
    expect(
      await firePostToolUse(started.options, {
        ...taskResult('agent-1'),
        agent_id: 'agent-9',
        agent_type: 'worker',
      }),
    ).toEqual({ continue: true });
    expect(
      await firePostToolUse(started.options, taskResult('agent-1', { status: 'async_launched' })),
    ).toEqual({ continue: true });
    expect(await firePostToolUse(started.options, taskResult('agent-1'))).toHaveProperty(
      'hookSpecificOutput',
    );
  });
});

// `push()` は使わない: 作業者の完了を契機に呼ぶと SDK 側の自己継続と二重にターンが回る。
describe('task_notification 経由で判明した打ち切りにも注記する（#901）', () => {
  function anyManagerTool(extra: Record<string, unknown> = {}) {
    return {
      hook_event_name: 'PostToolUse',
      tool_name: 'Read',
      tool_input: { file_path: '/tmp/x' },
      tool_response: { content: 'ok' },
      ...extra,
    };
  }

  it('次のマネージャー自身の PostToolUse（道具の種類は問わない）に additionalContext が付く', async () => {
    const s = setup();
    await s.host.start({ managerId: 'mgr-1', request: '走る', cwd: dir });
    const started = s.started[0];
    if (started === undefined) throw new Error('セッションが開いていない');

    await cutOff(started, 'agent-1');
    await fireTaskNotification(started, 'agent-1');

    const result = await firePostToolUse(started.options, anyManagerTool());
    expect(result).toMatchObject({
      continue: true,
      hookSpecificOutput: { hookEventName: 'PostToolUse' },
    });
    const context = (result as { hookSpecificOutput?: { additionalContext?: string } })
      .hookSpecificOutput?.additionalContext;
    expect(context).toContain('agent_id=agent-1');
    expect(context).toContain('task-notification');
    expect(context).toContain('完結していない可能性がある');
    expect(context).toContain('id=bg-agent-1');
    expect(context).toContain('command=sleep 90');
    expect(context).toContain('出力の置き場所は、処理が終わったら知らせる（#1554）');
    expect(context).toContain('ToolSearch');
    expect(context).toContain('select:SendMessage');
    expect(context).toContain('agentId=agent-1');
    expect(noteEvents(s.events).at(-1)?.text).toContain(
      'Task の結果に注記した（#901・task_notification 経由）',
    );
  });

  it('1回だけ（配達したら控えは空になる）', async () => {
    const s = setup();
    await s.host.start({ managerId: 'mgr-1', request: '走る', cwd: dir });
    const started = s.started[0];
    if (started === undefined) throw new Error('セッションが開いていない');

    await cutOff(started, 'agent-1');
    await fireTaskNotification(started, 'agent-1');

    await firePostToolUse(started.options, anyManagerTool());
    expect(await firePostToolUse(started.options, anyManagerTool())).toEqual({ continue: true });
  });

  it('打ち切られていない task_notification には何も控えない', async () => {
    const s = setup();
    await s.host.start({ managerId: 'mgr-1', request: '走る', cwd: dir });
    const started = s.started[0];
    if (started === undefined) throw new Error('セッションが開いていない');

    await fireTaskNotification(started, 'agent-2');

    expect(await firePostToolUse(started.options, anyManagerTool())).toEqual({ continue: true });
  });

  it('同期経路（PostToolUse）で先に消費されていれば、後から届く task_notification では二重に控えない', async () => {
    const s = setup();
    await s.host.start({ managerId: 'mgr-1', request: '走る', cwd: dir });
    const started = s.started[0];
    if (started === undefined) throw new Error('セッションが開いていない');

    await cutOff(started, 'agent-1');
    await firePostToolUse(started.options, taskResult('agent-1'));
    await fireTaskNotification(started, 'agent-1');

    expect(await firePostToolUse(started.options, anyManagerTool())).toEqual({ continue: true });
  });

  it('作業者内（agent_id あり）の PostToolUse には配達されない（控えは残ったまま）', async () => {
    const s = setup();
    await s.host.start({ managerId: 'mgr-1', request: '走る', cwd: dir });
    const started = s.started[0];
    if (started === undefined) throw new Error('セッションが開いていない');

    await cutOff(started, 'agent-1');
    await fireTaskNotification(started, 'agent-1');

    expect(
      await firePostToolUse(started.options, {
        ...anyManagerTool(),
        agent_id: 'agent-9',
        agent_type: 'worker',
      }),
    ).toEqual({ continue: true });
    expect(await firePostToolUse(started.options, anyManagerTool())).toHaveProperty(
      'hookSpecificOutput',
    );
  });
});

describe('打ち切った作業者が残した背景処理そのものの完了を配達する（Issue #1554）', () => {
  function anyManagerTool(extra: Record<string, unknown> = {}) {
    return {
      hook_event_name: 'PostToolUse',
      tool_name: 'Read',
      tool_input: { file_path: '/tmp/x' },
      tool_response: { content: 'ok' },
      ...extra,
    };
  }

  async function registerWorkerBash(
    options: Options,
    taskId: string,
    agentId: string,
    command: string,
  ): Promise<void> {
    await firePostToolUse(options, {
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_input: { command, run_in_background: true },
      tool_response: { stdout: '', stderr: '', backgroundTaskId: taskId },
      agent_id: agentId,
      agent_type: 'worker',
    });
  }

  it('打ち切った作業者が起こした背景の Bash が終わると、次のマネージャー自身の道具呼び出しに id・command・出力の在り処と再開の案内が載る', async () => {
    const s = setup();
    await s.host.start({ managerId: 'mgr-1', request: '走る', cwd: dir });
    const started = s.started[0];
    if (started === undefined) throw new Error('セッションが開いていない');

    await cutOff(started, 'agent-1');
    await registerWorkerBash(started.options, 'bg-test-1', 'agent-1', 'pnpm test');

    await fireTaskNotification(started, 'bg-test-1');

    const result = await firePostToolUse(started.options, anyManagerTool());
    expect(result).toMatchObject({
      continue: true,
      hookSpecificOutput: { hookEventName: 'PostToolUse' },
    });
    const context = (result as { hookSpecificOutput?: { additionalContext?: string } })
      .hookSpecificOutput?.additionalContext;
    expect(context).toContain('agent_id=agent-1');
    expect(context).toContain('id=bg-test-1');
    expect(context).toContain('command=pnpm test');
    expect(context).toContain('/tmp/does-not-exist.txt');
    expect(context).toContain('ToolSearch');
    expect(context).toContain('select:SendMessage');
    expect(context).toContain('agentId=agent-1');
    expect(context).toContain('即時ではない');
    expect(noteEvents(s.events).at(-1)?.text).toContain(
      '打ち切った作業者の背景処理が終わった（#1554）',
    );
  });

  it('1回だけ（配達したら控えは空になる）', async () => {
    const s = setup();
    await s.host.start({ managerId: 'mgr-1', request: '走る', cwd: dir });
    const started = s.started[0];
    if (started === undefined) throw new Error('セッションが開いていない');

    await cutOff(started, 'agent-1');
    await registerWorkerBash(started.options, 'bg-test-1', 'agent-1', 'pnpm test');
    await fireTaskNotification(started, 'bg-test-1');

    await firePostToolUse(started.options, anyManagerTool());
    expect(await firePostToolUse(started.options, anyManagerTool())).toEqual({ continue: true });
  });

  it('output_file が読めない task_notification では、パスを作らず「取れなかった」と書く', async () => {
    const s = setup();
    await s.host.start({ managerId: 'mgr-1', request: '走る', cwd: dir });
    const started = s.started[0];
    if (started === undefined) throw new Error('セッションが開いていない');

    await cutOff(started, 'agent-1');
    await registerWorkerBash(started.options, 'bg-test-1', 'agent-1', 'pnpm test');
    await fireTaskNotification(started, 'bg-test-1', { output_file: undefined });

    const result = await firePostToolUse(started.options, anyManagerTool());
    const context = (result as { hookSpecificOutput?: { additionalContext?: string } })
      .hookSpecificOutput?.additionalContext;
    expect(context).toContain('id=bg-test-1');
    expect(context).toContain('取れなかった');
    expect(context).not.toContain('/tmp/does-not-exist.txt');
  });

  it('打ち切られていない作業者の背景処理が終わっても、何も配達されない', async () => {
    const s = setup();
    await s.host.start({ managerId: 'mgr-1', request: '走る', cwd: dir });
    const started = s.started[0];
    if (started === undefined) throw new Error('セッションが開いていない');

    await registerWorkerBash(started.options, 'bg-test-2', 'agent-2', 'pnpm test');
    await fireTaskNotification(started, 'bg-test-2');

    expect(await firePostToolUse(started.options, anyManagerTool())).toEqual({ continue: true });
  });

  it('所有者を控えていない背景処理（id を登録していない）が終わっても、何も配達されない', async () => {
    const s = setup();
    await s.host.start({ managerId: 'mgr-1', request: '走る', cwd: dir });
    const started = s.started[0];
    if (started === undefined) throw new Error('セッションが開いていない');

    await cutOff(started, 'agent-1');
    await fireTaskNotification(started, 'bg-unknown');

    expect(await firePostToolUse(started.options, anyManagerTool())).toEqual({ continue: true });
  });

  it('マネージャー自身が起こした背景処理（所有者が空文字）が終わっても、何も配達されない', async () => {
    const s = setup();
    await s.host.start({ managerId: 'mgr-1', request: '走る', cwd: dir });
    const started = s.started[0];
    if (started === undefined) throw new Error('セッションが開いていない');

    await cutOff(started, 'agent-1');
    await firePostToolUse(started.options, {
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'pnpm test', run_in_background: true },
      tool_response: { stdout: '', stderr: '', backgroundTaskId: 'bg-manager-1' },
    });
    await fireTaskNotification(started, 'bg-manager-1');

    expect(await firePostToolUse(started.options, anyManagerTool())).toEqual({ continue: true });
  });

  it('作業者内（agent_id あり）の PostToolUse には配達されない（控えは残ったまま）', async () => {
    const s = setup();
    await s.host.start({ managerId: 'mgr-1', request: '走る', cwd: dir });
    const started = s.started[0];
    if (started === undefined) throw new Error('セッションが開いていない');

    await cutOff(started, 'agent-1');
    await registerWorkerBash(started.options, 'bg-test-1', 'agent-1', 'pnpm test');
    await fireTaskNotification(started, 'bg-test-1');

    expect(
      await firePostToolUse(started.options, {
        ...anyManagerTool(),
        agent_id: 'agent-9',
        agent_type: 'worker',
      }),
    ).toEqual({ continue: true });
    expect(await firePostToolUse(started.options, anyManagerTool())).toHaveProperty(
      'hookSpecificOutput',
    );
  });

  it('#901（作業者自身の完了）と #1554（背景の Bash の完了）が同じ配達に両方載る', async () => {
    const s = setup();
    await s.host.start({ managerId: 'mgr-1', request: '走る', cwd: dir });
    const started = s.started[0];
    if (started === undefined) throw new Error('セッションが開いていない');

    await cutOff(started, 'agent-1');
    await registerWorkerBash(started.options, 'bg-test-1', 'agent-1', 'pnpm test');
    await fireTaskNotification(started, 'bg-test-1');
    await fireTaskNotification(started, 'agent-1');

    const result = await firePostToolUse(started.options, anyManagerTool());
    const context = (result as { hookSpecificOutput?: { additionalContext?: string } })
      .hookSpecificOutput?.additionalContext;
    expect(context).toContain('task-notification');
    expect(context).toContain('が残した背景処理');
    expect(context).toContain('id=bg-test-1');
    expect(
      noteEvents(s.events).some((note) =>
        note.text.includes('打ち切った作業者の背景処理が終わった'),
      ),
    ).toBe(true);
  });
});
