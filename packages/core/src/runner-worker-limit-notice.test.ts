import type {
  HookJSONOutput,
  Options,
  Query,
  SDKMessage,
  query as sdkQuery,
} from '@anthropic-ai/claude-agent-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createRunnerHost, type RunnerHost } from './runner.js';
import type { RunnerEvent } from './runner-protocol.js';
import {
  WORKER_LIMIT_DEDUPE_MS,
  WORKER_LIMIT_NOTICE_INTERVAL_MS,
  WORKER_LIMIT_RAW_MAX_CHARS,
  WorkerLimitNotices,
  describeWorkerLimit,
} from './runner-worker-limit-notice.js';

// 2026-10-15〜16、作業者（Sonnet）だけが週の利用上限に当たり、担当（Opus）は動けたまま。担当のターンが成功すると、その事実が捨てられていた（#4903）。

const LIMIT_TEXT = "You've hit your weekly limit · resets Oct 20, 3am (UTC)";

describe('describeWorkerLimit', () => {
  it('作業者の名前・原文・「止める指示ではない」を添える', () => {
    const text = describeWorkerLimit([{ label: 'task t-1', raw: LIMIT_TEXT }]);
    expect(text).toContain('⚠ alteroid からの知らせ: 作業者（task t-1）が利用上限で落ちた');
    expect(text).toContain(`原文: ${LIMIT_TEXT}`);
    expect(text).toContain('止める指示ではない');
  });

  it('原文は 300 字までに抜粋する', () => {
    const text = describeWorkerLimit([{ label: 'a', raw: 'x'.repeat(1000) }]);
    expect(text).toContain('x'.repeat(WORKER_LIMIT_RAW_MAX_CHARS) + '…');
    expect(text).not.toContain('x'.repeat(WORKER_LIMIT_RAW_MAX_CHARS + 1));
  });
});

describe('WorkerLimitNotices', () => {
  it('同じ相手へは間隔を置く。相手が違えば別に数える。担当本人に配ったものは消える', () => {
    const notices = new WorkerLimitNotices();
    expect(notices.record('a', 'a', LIMIT_TEXT, 0)).toBe(true);
    expect(notices.record('a', 'a', LIMIT_TEXT, 1)).toBe(false);
    expect(notices.next('agent-1', false, 10)).not.toBeNull();
    expect(notices.next('manager', true, 20)).not.toBeNull();
    // 配ったものは消えている
    expect(notices.next('manager', true, WORKER_LIMIT_NOTICE_INTERVAL_MS + 100)).toBeNull();
  });

  it('間隔内に新しい落ちが来ても、間隔が明けるまで添えない', () => {
    const notices = new WorkerLimitNotices();
    notices.record('a', 'a', LIMIT_TEXT, 0);
    expect(notices.next('manager', true, 0)).not.toBeNull();
    notices.record('b', 'b', LIMIT_TEXT, 1);
    expect(notices.next('manager', true, WORKER_LIMIT_NOTICE_INTERVAL_MS - 1)).toBeNull();
    expect(notices.next('manager', true, WORKER_LIMIT_NOTICE_INTERVAL_MS)).not.toBeNull();
  });

  it('同じ身元は、名札と原文が違っても期間内は新しい記録にしない。違う身元・期間を過ぎたあとは記録する（#4996）', () => {
    const notices = new WorkerLimitNotices();
    expect(notices.record('tool_use:X', 'tool_use X', LIMIT_TEXT, 0)).toBe(true);
    expect(notices.record('tool_use:X', 'tool_use X ・task T', '別の原文', 1)).toBe(false);
    expect(notices.record('tool_use:Y', 'tool_use Y', LIMIT_TEXT, 2)).toBe(true);
    expect(notices.record('tool_use:X', 'tool_use X', LIMIT_TEXT, WORKER_LIMIT_DEDUPE_MS)).toBe(
      true,
    );
  });
});

// --- runner を通す ---

interface FakeSession {
  options: Options;
  finish(result?: string): Promise<void>;
  say(text: string, options?: { error?: string; parentToolUseId?: string }): Promise<void>;
  notify(
    taskId: string,
    options: { status: string; summary: string; toolUseId?: string },
  ): Promise<void>;
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
    sessions.push({
      options: params.options ?? {},
      async finish(result = '済んだ') {
        push({
          type: 'result',
          subtype: 'success',
          result,
          session_id: 'sess-mgr',
          uuid: `uuid-result-${String((serial += 1))}`,
        } as unknown as SDKMessage);
        await new Promise((resolve) => setTimeout(resolve, 0));
      },
      async say(text, sayOptions = {}) {
        push({
          type: 'assistant',
          message: { role: 'assistant', content: [{ type: 'text', text }] },
          parent_tool_use_id: sayOptions.parentToolUseId ?? null,
          session_id: 'sess-mgr',
          uuid: `uuid-say-${String((serial += 1))}`,
          ...(sayOptions.error === undefined ? {} : { error: sayOptions.error }),
        } as unknown as SDKMessage);
        await new Promise((resolve) => setTimeout(resolve, 0));
      },
      async notify(taskId, notifyOptions) {
        push({
          type: 'system',
          subtype: 'task_notification',
          task_id: taskId,
          status: notifyOptions.status,
          summary: notifyOptions.summary,
          output_file: '/tmp/fake-output',
          ...(notifyOptions.toolUseId === undefined
            ? {}
            : { tool_use_id: notifyOptions.toolUseId }),
          uuid: `uuid-task-notification-${String((serial += 1))}`,
          session_id: 'sess-mgr',
        } as unknown as SDKMessage);
        await new Promise((resolve) => setTimeout(resolve, 0));
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
        await new Promise((resolve) => setTimeout(resolve, 0));
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
        while (!(await iterator.next()).done) {
          // 入力は読み捨てる
        }
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

let hosts: RunnerHost[] = [];

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(hosts.map((host) => host.shutdown().catch(() => undefined)));
  hosts = [];
});

async function start(): Promise<{ session: FakeSession; events: RunnerEvent[] }> {
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
  await host.start({ managerId: 'mgr-1', request: '走る', cwd: '/work/project' });
  await vi.waitFor(() => {
    if (sessions.length < 1) throw new Error('セッションがまだ開いていない');
  });
  return { session: sessions[0]!, events };
}

function postToolUse(options: Options, extra: Record<string, unknown> = {}) {
  const hook = options.hooks?.PostToolUse?.[0]?.hooks?.[0];
  if (hook === undefined) throw new Error('PostToolUse フックが登録されていない');
  return hook(
    {
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
      tool_response: { stdout: '', stderr: '' },
      ...extra,
    } as never,
    undefined,
    { signal: new AbortController().signal },
  );
}

const contextOf = (result: HookJSONOutput): string | undefined =>
  (result as { hookSpecificOutput?: { additionalContext?: string } }).hookSpecificOutput
    ?.additionalContext;

const notesOf = (events: RunnerEvent[], needle: string) =>
  events.filter((event) => event.type === 'note' && event.text.includes(needle));

describe('作業者だけが利用上限で落ちたとき、担当の道具の結果に知らせを添える（#4903）', () => {
  it('failed の通知が上限の文言なら、次の道具の結果に添え、日誌に note を1行。間隔内は二度添えない', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { session, events } = await start();
    await session.notify('t-1', { status: 'failed', summary: LIMIT_TEXT });

    const first = contextOf(await postToolUse(session.options));
    expect(first).toContain('作業者（task t-1）が利用上限で落ちた');
    expect(first).toContain(`原文: ${LIMIT_TEXT}`);
    expect(first).toContain('止める指示ではない');
    expect(notesOf(events, 'この担当の道具の結果に「戻るまで')).toHaveLength(1);

    expect(contextOf(await postToolUse(session.options))).toBeUndefined();
    vi.setSystemTime(Date.now() + WORKER_LIMIT_NOTICE_INTERVAL_MS + 1);
    expect(contextOf(await postToolUse(session.options))).toBeUndefined();
    expect(notesOf(events, 'この担当の道具の結果に「戻るまで')).toHaveLength(1);
  });

  it('作業者の assistant の errorCode（rate_limit）でも立つ。担当のターンが成功しても note がクローンへ運ばれる', async () => {
    const { session, events } = await start();
    await session.say(LIMIT_TEXT, { error: 'rate_limit', parentToolUseId: 'toolu-9' });
    await session.finish();

    const carried = events.filter(
      (event) =>
        event.type === 'note' &&
        event.notifyClone === true &&
        event.text.includes('利用上限で落ちた'),
    );
    expect(carried).toHaveLength(1);
    expect(events.some((event) => event.type === 'usage_notice')).toBe(false);
    expect(contextOf(await postToolUse(session.options))).toContain('作業者（tool_use toolu-9）');
  });

  it('作業者の報告の本文が上限の話を引用しただけ（completed・errorCode なし）では立たない', async () => {
    const { session, events } = await start();
    await session.notify('t-2', { status: 'completed', summary: LIMIT_TEXT });
    await session.say(LIMIT_TEXT, { parentToolUseId: 'toolu-3' });
    await session.finish();

    expect(await postToolUse(session.options)).toEqual({ continue: true });
    expect(notesOf(events, '利用上限で落ちた')).toHaveLength(0);
  });
});

describe('同じ作業者の2つの合図を1つの知らせにそろえる（#4996）', () => {
  const lines = (events: RunnerEvent[]) => notesOf(events, 'だけが利用上限で落ちた');

  it('発言の拒否の印（parentToolUseId=X）と失敗通知（taskId=T・toolUseId=X）が両方来ても note は1つ', async () => {
    const { session, events } = await start();
    await session.say(LIMIT_TEXT, { error: 'rate_limit', parentToolUseId: 'toolu-X' });
    await session.notify('task-T', {
      status: 'failed',
      summary: `作業者が落ちた: ${LIMIT_TEXT}`,
      toolUseId: 'toolu-X',
    });
    expect(lines(events)).toHaveLength(1);
  });

  it('失敗通知に toolUseId が無くても、先の task_started（taskId=T・toolUseId=X）から同じ作業者と分かれば note は1つ', async () => {
    const { session, events } = await start();
    await session.startTask('task-T', 'toolu-X');
    await session.say(LIMIT_TEXT, { error: 'rate_limit', parentToolUseId: 'toolu-X' });
    await session.notify('task-T', {
      status: 'failed',
      summary: `作業者が落ちた: ${LIMIT_TEXT}`,
    });
    expect(lines(events)).toHaveLength(1);
  });

  it('違う作業者なら note は2つ', async () => {
    const { session, events } = await start();
    await session.say(LIMIT_TEXT, { error: 'rate_limit', parentToolUseId: 'toolu-X' });
    await session.notify('task-U', {
      status: 'failed',
      summary: LIMIT_TEXT,
      toolUseId: 'toolu-Y',
    });
    expect(lines(events)).toHaveLength(2);
  });
});

describe('担当の枠の判定に応答の本文を使わない（#4934）', () => {
  // assistant.error だけが失敗の印で、result は成功（本文は作業者の上限の原文の引用）の形
  it('作業者の上限の原文を引用した応答が別の理由で失敗しても、担当の usage_notice は出ない', async () => {
    const { session, events } = await start();
    await session.say('過負荷', { error: 'overloaded' });
    await session.finish(`作業者が落ちた: ${LIMIT_TEXT}`);

    await vi.waitFor(() => {
      if (!events.some((event) => event.type === 'report')) throw new Error('報告がまだ無い');
    });
    expect(events.some((event) => event.type === 'usage_notice')).toBe(false);
  });

  it('SDK の失敗の文言（assistant.error の本文）が上限の形なら、今どおり usage_notice が出る', async () => {
    const { session, events } = await start();
    await session.say(LIMIT_TEXT, { error: 'overloaded' });
    await session.finish('本文');

    await vi.waitFor(() => {
      if (!events.some((event) => event.type === 'usage_notice')) throw new Error('まだ出ていない');
    });
  });
});
