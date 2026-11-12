import type {
  HookCallbackMatcher,
  Options,
  Query,
  SDKMessage,
  query as sdkQuery,
} from '@anthropic-ai/claude-agent-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createRunnerHost, type RunnerHost } from './runner.js';
import type { RunnerEvent } from './runner-protocol.js';

interface FakeSession {
  options: Options;
  inputs: string[];
  finish(text: string): Promise<void>;
  usedTool(tool: string, extra?: Record<string, unknown>): Promise<void>;
  taskStarted(taskId: string, extra?: Record<string, unknown>): Promise<void>;
  taskNotification(taskId: string, extra?: Record<string, unknown>): Promise<void>;
  endStream(): void;
}

function fakeSdk(): { fn: typeof sdkQuery; sessions: FakeSession[] } {
  const sessions: FakeSession[] = [];

  const fn = ((params: { prompt: unknown; options?: Options }) => {
    const options = params.options ?? {};
    let emit: ((message: SDKMessage | null) => void) | null = null;
    const buffered: SDKMessage[] = [];
    const inputs: string[] = [];

    const push = (message: SDKMessage) => {
      if (emit) emit(message);
      else buffered.push(message);
    };

    async function fireHook(name: 'PostToolUse', input: Record<string, unknown>): Promise<void> {
      const matchers = options.hooks?.[name] as HookCallbackMatcher[] | undefined;
      if (matchers === undefined) return;
      for (const matcher of matchers) {
        for (const hook of matcher.hooks) {
          await hook(input as never, undefined, { signal: new AbortController().signal });
        }
      }
    }

    const session: FakeSession = {
      options,
      inputs,
      async finish(text) {
        push({
          type: 'result',
          subtype: 'success',
          result: text,
          session_id: 'sess-mgr',
          uuid: `uuid-result-${text}-${String(Math.random())}`,
        } as unknown as SDKMessage);
        await new Promise((resolve) => setTimeout(resolve, 0));
      },
      async usedTool(tool, extra = {}) {
        await fireHook('PostToolUse', {
          hook_event_name: 'PostToolUse',
          tool_name: tool,
          tool_input: { a: 1 },
          transcript_path: '/tmp/does-not-exist.jsonl',
          ...extra,
        });
      },
      async taskStarted(taskId, extra = {}) {
        push({
          type: 'system',
          subtype: 'task_started',
          task_id: taskId,
          description: '作業者への委譲',
          uuid: `uuid-task-started-${taskId}`,
          session_id: 'sess-mgr',
          ...extra,
        } as unknown as SDKMessage);
        await new Promise((resolve) => setTimeout(resolve, 0));
      },
      async taskNotification(taskId, extra = {}) {
        push({
          type: 'system',
          subtype: 'task_notification',
          task_id: taskId,
          status: 'completed',
          output_file: '/tmp/out.txt',
          summary: '完了',
          uuid: `uuid-task-notification-${taskId}`,
          session_id: 'sess-mgr',
          ...extra,
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
        for await (const message of params.prompt as AsyncIterable<{
          message: { content: unknown };
        }>) {
          inputs.push(String(message.message.content));
        }
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

async function startPrimed(host: RunnerHost, sessions: FakeSession[]): Promise<FakeSession> {
  await host.start({ managerId: 'mgr-1', request: '委譲して進めて', cwd: '/work/project' });
  const session = await firstSession(sessions);
  await session.finish('了解した。進める。');
  return session;
}

const workerWaitCount = (events: readonly RunnerEvent[]): number =>
  events.filter((event) => event.type === 'worker_wait').length;

describe('runner は worker_wait を出さない（計測をやめた。旧 runner の出来事は daemon が受けて日誌へ書く）', () => {
  it('委譲して通知を受け、ターンが回って区間が閉じる並びでも worker_wait を1件も上げない', async () => {
    const s = setup();
    const session = await startPrimed(s.host, s.sessions);

    await session.taskStarted('task-1', { task_type: 'local_agent' });
    await session.usedTool('Bash');
    await session.finish('turn1');
    await session.taskNotification('task-1');
    await session.finish('完了通知を契機に回った回');

    expect(s.events.some((event) => event.type === 'report')).toBe(true);
    expect(workerWaitCount(s.events)).toBe(0);
  });

  it('通知を受け切る前にセッションが畳まれても、受け切った直後に畳まれても worker_wait を上げない', async () => {
    const s = setup();
    const session = await startPrimed(s.host, s.sessions);

    await session.taskStarted('task-1', { task_type: 'local_agent' });
    await session.taskStarted('task-2', { task_type: 'local_agent' });
    await session.finish('作業中');
    await session.taskNotification('task-1');

    session.endStream();
    await vi.waitFor(() => {
      if (!s.events.some((event) => event.type === 'closed')) throw new Error('まだ畳まれていない');
    });

    expect(workerWaitCount(s.events)).toBe(0);
  });

  it('task_notification を受けても #input へは1件も積まれない（守られていない前提: 作業者の完了を契機に push を呼ばない）', async () => {
    const s = setup();
    const session = await startPrimed(s.host, s.sessions);
    const inputsBefore = session.inputs.length;

    await session.taskStarted('task-1');
    await session.taskNotification('task-1');
    expect(session.inputs.length).toBe(inputsBefore);

    await session.finish('完了通知を契機に回った回');
    expect(session.inputs.length).toBe(inputsBefore);
  });
});
