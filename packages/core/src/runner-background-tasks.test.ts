import type { Options, Query, SDKMessage, query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createRunnerHost, type RunnerHost } from './runner.js';
import type { RunnerEvent } from './runner-protocol.js';

interface FakeSession {
  say(text: string, options?: { error?: string }): Promise<void>;
  backgroundTasksChanged(
    tasks: readonly { id: string; taskType: string; ambient?: boolean }[],
  ): Promise<void>;
  finish(text: string, options?: { subtype?: string; isError?: boolean }): Promise<void>;
  /**
   * `sessionId` を明示させる: 同じ値は次のターンの `init`、違う値はセッションの差し替えを表し、
   * `init` の再送という見た目だけでは区別できない。前者は [sdk-verbatim SDKSystemMessage]
   * emits at the start of each turn
   *
   * 後者は [sdk-verbatim SDKBackgroundTasksChangedMessage]
   * (re)starts
   */
  restart(sessionId: string): Promise<void>;
  close(): void;
  ask(toolName: string, input: Record<string, unknown>): void;
}

function fakeSdk(): { fn: typeof sdkQuery; sessions: FakeSession[] } {
  const sessions: FakeSession[] = [];

  const fn = ((params: { prompt: unknown; options?: Options }) => {
    let emit: ((message: SDKMessage | null) => void) | null = null;
    const buffered: SDKMessage[] = [];
    const push = (message: SDKMessage) => {
      if (emit) emit(message);
      else buffered.push(message);
    };

    sessions.push({
      async say(text, sayOptions = {}) {
        push({
          type: 'assistant',
          message: { role: 'assistant', content: [{ type: 'text', text }] },
          parent_tool_use_id: null,
          session_id: 'sess-mgr',
          uuid: `uuid-say-${text.length}-${String(Math.random())}`,
          ...(sayOptions.error === undefined ? {} : { error: sayOptions.error }),
        } as unknown as SDKMessage);
        await new Promise((resolve) => setTimeout(resolve, 0));
      },
      async backgroundTasksChanged(tasks) {
        push({
          type: 'system',
          subtype: 'background_tasks_changed',
          tasks: tasks.map((task) => ({
            task_id: task.id,
            task_type: task.taskType,
            description: '',
            ...(task.ambient === undefined ? {} : { ambient: task.ambient }),
          })),
          session_id: 'sess-mgr',
          uuid: `uuid-bg-${String(Math.random())}`,
        } as unknown as SDKMessage);
        await new Promise((resolve) => setTimeout(resolve, 0));
      },
      async finish(text, finishOptions = {}) {
        push({
          type: 'result',
          subtype: finishOptions.subtype ?? 'success',
          result: text,
          session_id: 'sess-mgr',
          uuid: `uuid-result-${String(Math.random())}`,
          ...(finishOptions.isError === undefined ? {} : { is_error: finishOptions.isError }),
        } as unknown as SDKMessage);
        await new Promise((resolve) => setTimeout(resolve, 0));
      },
      async restart(sessionId) {
        push({
          type: 'system',
          subtype: 'init',
          session_id: sessionId,
          uuid: `uuid-init-${String(Math.random())}`,
        } as unknown as SDKMessage);
        await new Promise((resolve) => setTimeout(resolve, 0));
      },
      close() {
        if (emit) emit(null);
      },
      ask(toolName, input) {
        const canUseTool = (params.options ?? {}).canUseTool;
        if (canUseTool === undefined) throw new Error('canUseTool が配線されていない');
        // await しない: 誰も答えないので、待つと `waiting_human` のまま `finish()` を呼べなくなる。
        void canUseTool(toolName, input, {
          signal: new AbortController().signal,
          toolUseID: `tool-${String(Math.random())}`,
          requestId: `req-${String(Math.random())}`,
        } as never);
      },
    });

    async function* generate(): AsyncGenerator<SDKMessage, void> {
      yield {
        type: 'system',
        subtype: 'init',
        session_id: 'sess-mgr',
        uuid: 'uuid-init',
      } as unknown as SDKMessage;

      void (async () => {
        for await (const message of params.prompt as AsyncIterable<unknown>) void message;
      })();

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

    const generator = generate();
    return Object.assign(generator, {
      close: () => {
        if (emit) emit(null);
      },
      interrupt: async () => undefined,
    }) as unknown as Query;
  }) as unknown as typeof sdkQuery;

  return { fn, sessions };
}

let hosts: RunnerHost[] = [];

afterEach(async () => {
  await Promise.all(hosts.map((host) => host.shutdown().catch(() => undefined)));
  hosts = [];
});

function setup(): { host: RunnerHost; events: RunnerEvent[]; sessions: FakeSession[] } {
  const events: RunnerEvent[] = [];
  const { fn, sessions } = fakeSdk();
  const host = createRunnerHost({
    runnerId: 'runner-test',
    workspacePath: '/work/project',
    emit: (event) => events.push(event),
    queryFn: fn,
    env: { PATH: '/usr/bin' },
  });
  hosts.push(host);
  return { host, events, sessions };
}

async function firstSession(sessions: readonly FakeSession[]): Promise<FakeSession> {
  return vi.waitFor(() => {
    const found = sessions[0];
    if (!found) throw new Error('セッションがまだ開いていない');
    return found;
  });
}

async function secondSession(sessions: readonly FakeSession[]): Promise<FakeSession> {
  return vi.waitFor(() => {
    const found = sessions[1];
    if (!found) throw new Error('作り直し後のセッションがまだ開いていない');
    return found;
  });
}

type ReportEvent = Extract<RunnerEvent, { type: 'report' }>;

async function reportEvents(events: readonly RunnerEvent[], expected: number) {
  return vi.waitFor(() => {
    const found = events.filter((event): event is ReportEvent => event.type === 'report');
    if (found.length < expected) {
      throw new Error(
        `report が ${String(expected)} 本届いていない（いま ${String(found.length)} 本）`,
      );
    }
    return found;
  });
}

describe('report イベントの awaitingBackground（3条件すべてを満たすときだけ載る）', () => {
  it('背景タスクが在り、成功して done で終わった回に載る', async () => {
    const s = setup();
    await s.host.start({ managerId: 'mgr-1', request: '調べて', cwd: '/work/project' });
    const session = await firstSession(s.sessions);

    await session.backgroundTasksChanged([{ id: 'bg-1', taskType: 'shell' }]);
    await session.say('完了を待つ');
    await session.finish('完了を待つ');

    const [report] = await reportEvents(s.events, 1);
    expect(report?.status).toBe('done');
    expect(report?.awaitingBackground).toEqual({ count: 1, breakdown: 'shell×1' });
  });

  it('背景タスクが無ければ載らない', async () => {
    const s = setup();
    await s.host.start({ managerId: 'mgr-1', request: '調べて', cwd: '/work/project' });
    const session = await firstSession(s.sessions);

    await session.say('中身のある報告');
    await session.finish('中身のある報告');

    const [report] = await reportEvents(s.events, 1);
    expect(report?.awaitingBackground).toBeUndefined();
  });

  it('失敗（assistant.error）で終わった回は、背景タスクが在っても載らない（必ず配る）', async () => {
    const s = setup();
    await s.host.start({ managerId: 'mgr-1', request: '調べて', cwd: '/work/project' });
    const session = await firstSession(s.sessions);

    await session.backgroundTasksChanged([{ id: 'bg-1', taskType: 'shell' }]);
    await session.say('', { error: 'billing_error' });
    await session.finish('', { isError: true });

    const [report] = await reportEvents(s.events, 1);
    expect(report?.failure).toBeDefined();
    expect(report?.awaitingBackground).toBeUndefined();
  });

  it('待ちが在って waiting_human になった回は、背景タスクが在っても載らない（必ず配る）', async () => {
    const s = setup();
    await s.host.start({ managerId: 'mgr-1', request: '調べて', cwd: '/work/project' });
    const session = await firstSession(s.sessions);

    await session.backgroundTasksChanged([{ id: 'bg-1', taskType: 'shell' }]);
    session.ask('Bash', { command: 'echo hi' });
    await session.finish('確認をお願いします');

    const [report] = await reportEvents(s.events, 1);
    expect(report?.status).toBe('waiting_human');
    expect(report?.awaitingBackground).toBeUndefined();
  });
});

describe('在り高のリセット — 器（CLI プロセス）が本当に入れ替わったときだけ', () => {
  // `init` は器が入れ替わっていなくてもターンの頭ごとに来る。[sdk-verbatim SDKSystemMessage]
  // 「Session metadata the CLI emits at the start of each turn, normally ahead of every other message of that turn」
  it('同じ session_id のままターン境界の init が来ても在り高を保つ', async () => {
    const s = setup();
    await s.host.start({ managerId: 'mgr-1', request: '調べて', cwd: '/work/project' });
    const session = await firstSession(s.sessions);

    await session.backgroundTasksChanged([
      { id: 'bg-1', taskType: 'local_agent' },
      { id: 'bg-2', taskType: 'local_agent' },
      { id: 'bg-3', taskType: 'local_agent' },
    ]);
    await session.say('1本目、完了を待つ');
    await session.finish('1本目、完了を待つ');

    const [firstReport] = await reportEvents(s.events, 1);
    expect(firstReport?.awaitingBackground).toEqual({ count: 3, breakdown: 'local_agent×3' });

    await session.backgroundTasksChanged([
      { id: 'bg-2', taskType: 'local_agent' },
      { id: 'bg-3', taskType: 'local_agent' },
    ]);
    await session.restart('sess-mgr');
    await session.say('2本目、まだ待つ');
    await session.finish('2本目、まだ待つ');

    const [, secondReport] = await reportEvents(s.events, 2);
    expect(secondReport?.awaitingBackground).toEqual({ count: 2, breakdown: 'local_agent×2' });
  });

  it('event.sessionId が直前と違う init が来たらリセットする（配る側への保険）', async () => {
    const s = setup();
    await s.host.start({ managerId: 'mgr-1', request: '調べて', cwd: '/work/project' });
    const session = await firstSession(s.sessions);

    await session.backgroundTasksChanged([{ id: 'bg-1', taskType: 'shell' }]);
    await session.restart('sess-mgr-2');
    await session.say('完了を待つ');
    await session.finish('完了を待つ');

    const [report] = await reportEvents(s.events, 1);
    expect(report?.awaitingBackground).toBeUndefined();
  });

  it('#open() が同じインスタンスで開き直すと在り高をリセットする（resume 失敗からの回復経路）', async () => {
    const s = setup();
    await s.host.resume({
      managerId: 'mgr-1',
      sessionId: 'sess-mgr',
      cwd: '/work/project',
      request: '調べて',
      // renderSessionLog が null を返すと `unresumable`（作り直さない）へ倒れるので、読める材料を1件渡す。
      entries: [{ type: 'user', message: { role: 'user', content: 'つづき' } }],
    });
    const first = await firstSession(s.sessions);

    await first.backgroundTasksChanged([{ id: 'bg-1', taskType: 'shell' }]);
    first.close();

    const second = await secondSession(s.sessions);
    await second.say('作り直し後の1本目');
    await second.finish('作り直し後の1本目');

    const [report] = await reportEvents(s.events, 1);
    expect(report?.awaitingBackground).toBeUndefined();
  });
});

describe('REPLACE 意味論（差分ではなく、2回目のペイロードが1回目を置き換える）', () => {
  it('2回目のペイロードで件数が変わる', async () => {
    const s = setup();
    await s.host.start({ managerId: 'mgr-1', request: '調べて', cwd: '/work/project' });
    const session = await firstSession(s.sessions);

    await session.backgroundTasksChanged([
      { id: 'bg-1', taskType: 'shell' },
      { id: 'bg-2', taskType: 'shell' },
    ]);
    await session.backgroundTasksChanged([{ id: 'bg-3', taskType: 'shell' }]);
    await session.say('完了を待つ');
    await session.finish('完了を待つ');

    const [report] = await reportEvents(s.events, 1);
    expect(report?.awaitingBackground).toEqual({ count: 1, breakdown: 'shell×1' });
  });

  it('ambient なタスクは在り高に数えない', async () => {
    const s = setup();
    await s.host.start({ managerId: 'mgr-1', request: '調べて', cwd: '/work/project' });
    const session = await firstSession(s.sessions);

    await session.backgroundTasksChanged([
      { id: 'bg-1', taskType: 'skip_transcript', ambient: true },
    ]);
    await session.say('完了を待つ');
    await session.finish('完了を待つ');

    const [report] = await reportEvents(s.events, 1);
    expect(report?.awaitingBackground).toBeUndefined();
  });
});
