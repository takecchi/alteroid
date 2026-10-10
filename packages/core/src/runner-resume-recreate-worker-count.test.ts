import type { Query, SDKMessage, query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { RunnerEvent } from './runner-protocol.js';
import { createRunnerHost, type RunnerHost } from './runner.js';

// `grep -Fn -- 'このターンで開いた作業者の数も、同じ理由で持ち越さない' packages/core/src/runner.ts`
// `createManagerPool` を経由しない: resume は `host.resume()` を直接呼ぶのが素直で、経由すると `#restoreJobs()` の組み立てが要る。

interface FakeSession {
  finish(text: string, options?: { isError?: boolean }): Promise<void>;
  taskStarted(taskId: string): Promise<void>;
  taskNotification(taskId: string, options?: { status?: string; summary?: string }): Promise<void>;
  endStream(): void;
}

function fakeSdk(): { fn: typeof sdkQuery; sessions: FakeSession[] } {
  const sessions: FakeSession[] = [];

  const fn = ((params: { prompt: unknown }) => {
    let emit: ((message: SDKMessage | null) => void) | null = null;
    const buffered: SDKMessage[] = [];
    let finishes = 0;
    const push = (message: SDKMessage) => {
      if (emit) emit(message);
      else buffered.push(message);
    };

    const session: FakeSession = {
      async finish(text, options = {}) {
        push({
          type: 'result',
          subtype: 'success',
          result: text,
          session_id: 'sess-mgr',
          uuid: `uuid-result-${(finishes += 1)}`,
          ...(options.isError === undefined ? {} : { is_error: options.isError }),
        } as unknown as SDKMessage);
        await new Promise((resolve) => setTimeout(resolve, 0));
      },
      async taskStarted(taskId) {
        push({
          type: 'system',
          subtype: 'task_started',
          task_id: taskId,
          description: '作業者への委譲',
          uuid: `uuid-task-started-${taskId}-${String(Math.random())}`,
          session_id: 'sess-mgr',
        } as unknown as SDKMessage);
        await new Promise((resolve) => setTimeout(resolve, 0));
      },
      async taskNotification(taskId, options = {}) {
        push({
          type: 'system',
          subtype: 'task_notification',
          task_id: taskId,
          status: options.status ?? 'completed',
          summary: options.summary ?? '',
          output_file: '/tmp/fake-output',
          uuid: `uuid-task-notification-${taskId}-${String(Math.random())}`,
          session_id: 'sess-mgr',
        } as unknown as SDKMessage);
        await new Promise((resolve) => setTimeout(resolve, 0));
      },
      endStream() {
        if (emit) emit(null);
      },
    };
    sessions.push(session);

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

async function nthSession(sessions: readonly FakeSession[], index: number): Promise<FakeSession> {
  return vi.waitFor(() => {
    const found = sessions[index];
    if (!found) throw new Error(`${String(index)} 本目のセッションがまだ開いていない`);
    return found;
  });
}

type ReportEvent = Extract<RunnerEvent, { type: 'report' }>;

async function nthReport(events: readonly RunnerEvent[], index: number): Promise<ReportEvent> {
  return vi.waitFor(() => {
    const found = events.filter((event): event is ReportEvent => event.type === 'report');
    const report = found[index];
    if (!report) throw new Error(`${String(index)} 本目の報告がまだ届いていない`);
    return report;
  });
}

const BASELINE_FAILURE_TEXT =
  '（このターンは応答を返さずに終わった: success / result_is_error）\n（報告なし）';

describe('#1373: resume に失敗して作り直す経路でも、そのターンで開いた作業者の数を持ち越さない', () => {
  it('前のセッションで開いた作業者は、作り直した後の最初の失敗の本文には出ない', async () => {
    const { host, events, sessions } = setup();

    await host.resume({
      managerId: 'mgr-1',
      sessionId: 'sess-dead',
      cwd: '/work/project',
      request: '最初の依頼',
      // `renderSessionLog` は空配列/undefined だけ null を返すので、素材を1件渡す
      entries: [{ type: 'user', message: { role: 'user', content: '前回の続き' } }],
    });

    const first = await nthSession(sessions, 0);
    await first.taskStarted('task-1');
    await first.taskStarted('task-2');
    first.endStream();

    const second = await nthSession(sessions, 1);
    await second.finish('', { isError: true });

    const report = await nthReport(events, 0);
    expect(report.managerId).toBe('mgr-1');
    expect(report.text).not.toContain('体開いていた');
    expect(report.text).toBe(BASELINE_FAILURE_TEXT);
  });

  it('陽性対照: 前のセッションで作業者を開いていなければ、作り直した後の失敗の本文はもとから変わらない', async () => {
    const { host, events, sessions } = setup();

    await host.resume({
      managerId: 'mgr-2',
      sessionId: 'sess-dead-2',
      cwd: '/work/project',
      request: '最初の依頼',
      entries: [{ type: 'user', message: { role: 'user', content: '前回の続き' } }],
    });

    const first = await nthSession(sessions, 0);
    first.endStream();

    const second = await nthSession(sessions, 1);
    await second.finish('', { isError: true });

    const report = await nthReport(events, 0);
    expect(report.text).toBe(BASELINE_FAILURE_TEXT);
  });

  it('過剰な握り潰しの回帰防止: resume で開いたセッションが一度進行した後の、無関係な通常の失敗では数を消さない', async () => {
    const { host, events, sessions } = setup();

    await host.resume({
      managerId: 'mgr-3',
      sessionId: 'sess-dead-3',
      cwd: '/work/project',
      request: '最初の依頼',
      entries: [{ type: 'user', message: { role: 'user', content: '前回の続き' } }],
    });

    const session = await nthSession(sessions, 0);
    await session.finish('続きを再開した');

    await session.taskStarted('task-1');
    await session.taskStarted('task-2');
    await session.finish('', { isError: true });

    const secondReport = await nthReport(events, 1);
    expect(secondReport.text).toContain(
      'このターンでは作業者が 2 体開いていた。どちらが当たったかは SDK からは分からない',
    );
    expect(sessions).toHaveLength(1);
  });

  it('前のセッションで failed の task_notification を受けていても、作り直した後の最初の失敗の本文には出ない（#1373 続き）', async () => {
    const { host, events, sessions } = setup();

    await host.resume({
      managerId: 'mgr-4',
      sessionId: 'sess-dead-4',
      cwd: '/work/project',
      request: '最初の依頼',
      entries: [{ type: 'user', message: { role: 'user', content: '前回の続き' } }],
    });

    const first = await nthSession(sessions, 0);
    await first.taskStarted('task-1');
    await first.taskNotification('task-1', {
      status: 'failed',
      summary: "You've hit your org's monthly spend limit",
    });
    first.endStream();

    const second = await nthSession(sessions, 1);
    await second.finish('', { isError: true });

    const report = await nthReport(events, 0);
    expect(report.managerId).toBe('mgr-4');
    expect(report.text).not.toContain('失敗で終わった');
    expect(report.text).not.toContain('枠(429)');
    expect(report.text).toBe(BASELINE_FAILURE_TEXT);
  });
});

type WorkerWaitEvent = Extract<RunnerEvent, { type: 'worker_wait' }>;

function workerWaitEvents(events: readonly RunnerEvent[]): WorkerWaitEvent[] {
  return events.filter((event): event is WorkerWaitEvent => event.type === 'worker_wait');
}

describe('#1190 案Z: resume に失敗した瞬間の worker_wait は、開いたままの区間を settled: false のまま降ろす', () => {
  it('task_started が2件・task_notification が0件のまま resume に失敗しても、settled: false が上がる', async () => {
    const { host, events, sessions } = setup();

    await host.resume({
      managerId: 'mgr-settled',
      sessionId: 'sess-dead-settled',
      cwd: '/work/project',
      request: '最初の依頼',
      entries: [{ type: 'user', message: { role: 'user', content: '前回の続き' } }],
    });

    const first = await nthSession(sessions, 0);
    await first.taskStarted('task-1');
    await first.taskStarted('task-2');
    first.endStream();

    await nthSession(sessions, 1);

    const [event] = await vi.waitFor(() => {
      const found = workerWaitEvents(events);
      if (found.length === 0) throw new Error('worker_wait がまだ上がっていない');
      return found;
    });
    expect(event).toBeDefined();
    if (event === undefined) return;
    expect(event.tasks).toBe(2);
    expect(event.settled).toBe(false);
  });
});
