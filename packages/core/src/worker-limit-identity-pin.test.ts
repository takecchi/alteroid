import type { Options, Query, SDKMessage, query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { setup, waitForDone } from './clone-test-harness.js';
import { createRunnerHost, type RunnerHost } from './runner.js';
import { WorkerLimitNotices } from './runner-worker-limit-notice.js';
import { createMemoryStores, humanMessage } from './testing.js';

// 仕様を先に書いたものではなく、今の出力から変えないための歯（期待は `-u` で生成して目で読んだ）。
// 作業者が上限で落ちたときに `WorkerLimitNotices.record` へ渡る「身元」の字を、Clone と Runner の両方で縛る。
// 呼び出し側（clone.ts / runner.ts）の身元の式（`tool_use:` / `background-worker` / `task:` と三項の向き）を動かすと赤くなる。

const LIMIT_TEXT = "You've hit your weekly limit · resets Oct 20, 3am (UTC)";

interface RecordCall {
  identity: string;
  label: string;
  recorded: boolean;
}

/** 本物の `record` を呼び通したまま、渡った身元・名札と戻り値を集める。 */
function spyRecord(): RecordCall[] {
  const calls: RecordCall[] = [];
  const original = WorkerLimitNotices.prototype.record;
  vi.spyOn(WorkerLimitNotices.prototype, 'record').mockImplementation(function (
    this: WorkerLimitNotices,
    identity,
    label,
    raw,
    nowMs,
  ) {
    const recorded = original.call(this, identity, label, raw, nowMs);
    calls.push({ identity, label, recorded });
    return recorded;
  });
  return calls;
}

afterEach(() => {
  vi.restoreAllMocks();
});

// --- Clone を通す ---

function cloneWorkerAssistant(parentToolUseId: string): SDKMessage {
  return {
    type: 'assistant',
    message: { content: [{ type: 'text', text: LIMIT_TEXT }] },
    error: 'rate_limit',
    parent_tool_use_id: parentToolUseId,
    session_id: 'sess-fake',
    uuid: `uuid-worker-assistant-${parentToolUseId}`,
  } as unknown as SDKMessage;
}

function cloneNotification(options: { taskId?: string; toolUseId?: string }): SDKMessage {
  return {
    type: 'system',
    subtype: 'task_notification',
    ...(options.taskId === undefined ? {} : { task_id: options.taskId }),
    ...(options.toolUseId === undefined ? {} : { tool_use_id: options.toolUseId }),
    status: 'failed',
    summary: LIMIT_TEXT,
    output_file: '/tmp/out',
    session_id: 'sess-fake',
    uuid: `uuid-notify-${options.taskId ?? 'none'}-${options.toolUseId ?? 'none'}`,
  } as unknown as SDKMessage;
}

async function cloneRecords(messages: SDKMessage[]): Promise<RecordCall[]> {
  const calls = spyRecord();
  const s = setup(() => 'できたよ', createMemoryStores(), { beforeAssistant: () => messages });
  s.clone.post(humanMessage('やって'));
  await waitForDone(s.events);
  await s.clone.stop();
  return calls;
}

describe('作業者の上限の身元 — Clone（今の出力から変えないための歯）', () => {
  it('発言の拒否（parentToolUseId）の身元は tool_use:<id>', async () => {
    expect(await cloneRecords([cloneWorkerAssistant('toolu-P')])).toMatchSnapshot();
  });

  it('失敗通知: toolUseId があれば taskId があっても tool_use:<id>', async () => {
    expect(
      await cloneRecords([cloneNotification({ taskId: 'task-T', toolUseId: 'toolu-X' })]),
    ).toMatchSnapshot();
  });

  it('失敗通知: toolUseId が無く taskId だけなら task:<id>', async () => {
    expect(await cloneRecords([cloneNotification({ taskId: 'task-T' })])).toMatchSnapshot();
  });

  it('失敗通知: toolUseId も taskId も無ければ background-worker', async () => {
    expect(await cloneRecords([cloneNotification({})])).toMatchSnapshot();
  });

  it('失敗通知: taskId が無く toolUseId だけでも tool_use:<id>', async () => {
    expect(await cloneRecords([cloneNotification({ toolUseId: 'toolu-X' })])).toMatchSnapshot();
  });

  it('同じ作業者が発言の拒否と失敗通知の2通りで届くと、同じ身元で2回目は記録されない（#4996）', async () => {
    expect(
      await cloneRecords([
        cloneWorkerAssistant('toolu-X'),
        cloneNotification({ taskId: 'task-T', toolUseId: 'toolu-X' }),
      ]),
    ).toMatchSnapshot();
  });
});

// --- Runner を通す ---

interface FakeSession {
  options: Options;
  finish(): Promise<void>;
  say(parentToolUseId: string): Promise<void>;
  notify(options: { taskId?: string; toolUseId?: string }): Promise<void>;
  startTask(taskId: string, toolUseId: string): Promise<void>;
}

function fakeSdk(): { fn: typeof sdkQuery; sessions: FakeSession[] } {
  const sessions: FakeSession[] = [];
  let serial = 0;
  const fn = ((params: { prompt: unknown; options?: Options }) => {
    const queue: (SDKMessage | null)[] = [];
    let wake: (() => void) | null = null;
    const push = (message: SDKMessage | null) => {
      queue.push(message);
      wake?.();
    };
    const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
    sessions.push({
      options: params.options ?? {},
      async finish() {
        push({
          type: 'result',
          subtype: 'success',
          result: '済んだ',
          session_id: 'sess-mgr',
          uuid: `uuid-result-${String((serial += 1))}`,
        } as unknown as SDKMessage);
        await tick();
      },
      async say(parentToolUseId) {
        push({
          type: 'assistant',
          message: { role: 'assistant', content: [{ type: 'text', text: LIMIT_TEXT }] },
          parent_tool_use_id: parentToolUseId,
          session_id: 'sess-mgr',
          uuid: `uuid-say-${String((serial += 1))}`,
          error: 'rate_limit',
        } as unknown as SDKMessage);
        await tick();
      },
      async notify(notifyOptions) {
        push({
          type: 'system',
          subtype: 'task_notification',
          ...(notifyOptions.taskId === undefined ? {} : { task_id: notifyOptions.taskId }),
          status: 'failed',
          summary: LIMIT_TEXT,
          output_file: '/tmp/fake-output',
          ...(notifyOptions.toolUseId === undefined
            ? {}
            : { tool_use_id: notifyOptions.toolUseId }),
          uuid: `uuid-task-notification-${String((serial += 1))}`,
          session_id: 'sess-mgr',
        } as unknown as SDKMessage);
        await tick();
      },
      async startTask(taskId, toolUseId) {
        push({
          type: 'system',
          subtype: 'task_started',
          task_id: taskId,
          tool_use_id: toolUseId,
          task_type: 'local_agent',
          uuid: `uuid-task-started-${String((serial += 1))}`,
          session_id: 'sess-mgr',
        } as unknown as SDKMessage);
        await tick();
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
        const iterator = (params.prompt as AsyncIterable<unknown>)[Symbol.asyncIterator]();
        for (;;) {
          const next = await iterator.next();
          if (next.done === true) break;
        }
        push(null);
      })();
      for (;;) {
        const next = queue.shift();
        if (next === null) return;
        if (next !== undefined) {
          yield next;
          continue;
        }
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
        wake = null;
      }
    }
    return Object.assign(generate(), {
      close: () => push(null),
      interrupt: async () => undefined,
    }) as unknown as Query;
  }) as unknown as typeof sdkQuery;
  return { fn, sessions };
}

const hosts: RunnerHost[] = [];

afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.shutdown().catch(() => undefined)));
});

async function startRunner(): Promise<FakeSession> {
  const { fn, sessions } = fakeSdk();
  const host = createRunnerHost({
    runnerId: 'runner-test',
    workspacePath: '/work/project',
    emit: () => undefined,
    queryFn: fn,
    env: { PATH: '/usr/bin' },
  });
  hosts.push(host);
  await host.start({ managerId: 'mgr-1', request: '走る', cwd: '/work/project' });
  await vi.waitFor(() => {
    if (sessions.length < 1) throw new Error('セッションがまだ開いていない');
  });
  return sessions[0]!;
}

describe('作業者の上限の身元 — Runner（今の出力から変えないための歯）', () => {
  it('発言の拒否（parentToolUseId）の身元は tool_use:<id>', async () => {
    const calls = spyRecord();
    const session = await startRunner();
    await session.say('toolu-P');
    await session.finish();
    expect(calls).toMatchSnapshot();
  });

  it('失敗通知: toolUseId があれば taskId があっても tool_use:<id>', async () => {
    const calls = spyRecord();
    const session = await startRunner();
    await session.notify({ taskId: 'task-T', toolUseId: 'toolu-X' });
    expect(calls).toMatchSnapshot();
  });

  it('失敗通知: toolUseId が無く taskId だけなら task:<id>', async () => {
    const calls = spyRecord();
    const session = await startRunner();
    await session.notify({ taskId: 'task-T' });
    expect(calls).toMatchSnapshot();
  });

  it('失敗通知: toolUseId も taskId も無ければ background-worker', async () => {
    const calls = spyRecord();
    const session = await startRunner();
    await session.notify({});
    expect(calls).toMatchSnapshot();
  });

  it('失敗通知: taskId が無く toolUseId だけでも tool_use:<id>', async () => {
    const calls = spyRecord();
    const session = await startRunner();
    await session.notify({ toolUseId: 'toolu-X' });
    expect(calls).toMatchSnapshot();
  });

  it('失敗通知に toolUseId が無くても、先の task_started の対応から tool_use:<id> に解決する', async () => {
    const calls = spyRecord();
    const session = await startRunner();
    await session.startTask('task-T', 'toolu-X');
    await session.notify({ taskId: 'task-T' });
    expect(calls).toMatchSnapshot();
  });

  it('同じ作業者が発言の拒否と失敗通知の2通りで届くと、同じ身元で2回目は記録されない（#4996）', async () => {
    const calls = spyRecord();
    const session = await startRunner();
    await session.say('toolu-X');
    await session.notify({ taskId: 'task-T', toolUseId: 'toolu-X' });
    expect(calls).toMatchSnapshot();
  });
});
