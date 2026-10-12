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
  cachedPidsReader,
  PIDS_PRESSURE_NOTICE_INTERVAL_MS,
  PidsPressureNotices,
} from './runner-pids-pressure.js';

// 2026-10-11〜12 に、同じ器に担当2本が作業者・dev サーバー・E2E を重ねて pids の上限に当たり、Claude Code が SIGABRT で落ちた（4件）。
// 置き先の選び方は新しい委譲を飽和した器から外すが、すでに走っている担当には何も届いていなかった。

describe('PidsPressureNotices', () => {
  const pressured = { current: 870, max: 1000, delegations: 2 };

  it('上限の 80% 以上で、器の値と担当の本数と「止める指示ではない」を添える', () => {
    const text = new PidsPressureNotices().next('manager', pressured, 0);
    expect(text).toContain('この器（runner）の pids が 870/1000（87%）で、上限に近い');
    expect(text).toContain('この器で手を動かしている担当 2 本');
    expect(text).toContain('止める指示ではない');
  });

  it('80% 未満・読めないときは添えない', () => {
    const notices = new PidsPressureNotices();
    expect(notices.next('manager', { current: 799, max: 1000, delegations: 1 }, 0)).toBeNull();
    expect(notices.next('manager', undefined, 0)).toBeNull();
  });

  it('同じ相手へは5分に1回まで。相手（担当本人・作業者ごと）が違えば別に数える', () => {
    const notices = new PidsPressureNotices();
    expect(notices.next('manager', pressured, 0)).not.toBeNull();
    expect(notices.next('manager', pressured, PIDS_PRESSURE_NOTICE_INTERVAL_MS - 1)).toBeNull();
    expect(notices.next('agent-1', pressured, 1)).not.toBeNull();
    expect(notices.next('manager', pressured, PIDS_PRESSURE_NOTICE_INTERVAL_MS)).not.toBeNull();
  });

  it('逼迫が解けたら覚えを捨て、次に逼迫したときは間隔を待たずに添える', () => {
    const notices = new PidsPressureNotices();
    expect(notices.next('manager', pressured, 0)).not.toBeNull();
    expect(notices.next('manager', { current: 500, max: 1000, delegations: 2 }, 1_000)).toBeNull();
    expect(notices.next('manager', pressured, 2_000)).not.toBeNull();
  });
});

describe('cachedPidsReader', () => {
  it('短い間は読み直さず、投げたら undefined に倒す', async () => {
    let now = 0;
    let calls = 0;
    const read = cachedPidsReader(
      async () => {
        calls += 1;
        if (calls === 2) throw new Error('読めない');
        return { current: calls, max: 1000 };
      },
      { ttlMs: 5_000, now: () => now },
    );
    expect(await read()).toEqual({ current: 1, max: 1000 });
    now = 4_999;
    expect(await read()).toEqual({ current: 1, max: 1000 });
    now = 5_000;
    expect(await read()).toBeUndefined();
    expect(calls).toBe(2);
  });
});

// --- runner を通す ---

interface FakeSession {
  options: Options;
  /** ターンを成功で終える（担当は done になる）。 */
  finish(): Promise<void>;
}

function fakeSdk(): { fn: typeof sdkQuery; sessions: FakeSession[] } {
  const sessions: FakeSession[] = [];
  const fn = ((params: { prompt: unknown; options?: Options }) => {
    const queue: (SDKMessage | null)[] = [];
    let wake: (() => void) | null = null;
    const push = (message: SDKMessage | null) => {
      queue.push(message);
      wake?.();
    };
    sessions.push({
      options: params.options ?? {},
      async finish() {
        push({
          type: 'result',
          subtype: 'success',
          result: '済んだ',
          session_id: 'sess-mgr',
          uuid: `uuid-result-${String(sessions.length)}`,
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
        // 入力は読み捨てる
        const iterator = (params.prompt as AsyncIterable<unknown>)[Symbol.asyncIterator]();
        while (!(await iterator.next()).done) {
          // 読み捨てる
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
  await Promise.all(hosts.map((host) => host.shutdown().catch(() => undefined)));
  hosts = [];
});

async function startWith(
  readPidsFn: (() => Promise<{ current: number; max: number } | undefined>) | undefined,
  managerIds: readonly string[] = ['mgr-1'],
): Promise<{ options: Options; events: RunnerEvent[]; host: RunnerHost; sessions: FakeSession[] }> {
  const events: RunnerEvent[] = [];
  const { fn, sessions } = fakeSdk();
  const host = createRunnerHost({
    runnerId: 'runner-test',
    workspacePath: '/work/project',
    emit: (event) => events.push(event),
    queryFn: fn,
    env: { PATH: '/usr/bin' },
    ...(readPidsFn === undefined ? {} : { readPidsFn }),
  });
  hosts.push(host);
  for (const managerId of managerIds) {
    await host.start({ managerId, request: '走る', cwd: '/work/project' });
  }
  await vi.waitFor(() => {
    if (sessions.length < managerIds.length) throw new Error('セッションがまだ開いていない');
  });
  return { options: sessions[0]!.options, events, host, sessions };
}

function postToolUse(options: Options, input: Record<string, unknown>) {
  const hook = options.hooks?.PostToolUse?.[0]?.hooks?.[0];
  if (hook === undefined) throw new Error('PostToolUse フックが登録されていない');
  return hook(input as never, undefined, { signal: new AbortController().signal });
}

const contextOf = (result: HookJSONOutput): string | undefined =>
  (result as { hookSpecificOutput?: { additionalContext?: string } }).hookSpecificOutput
    ?.additionalContext;

const managerBash = {
  hook_event_name: 'PostToolUse',
  tool_name: 'Bash',
  tool_input: { command: 'pnpm dev' },
  tool_response: { stdout: '', stderr: '' },
};

describe('pids が上限に近い器の担当に、道具の結果へ知らせを添える', () => {
  it('担当本人と作業者の両方に添え、担当本人に添えた回だけ日誌へ note を1行出す', async () => {
    const { options, events } = await startWith(async () => ({ current: 950, max: 1000 }));

    const own = contextOf(await postToolUse(options, managerBash));
    expect(own).toContain('この器（runner）の pids が 950/1000（95%）で、上限に近い');
    expect(own).toContain(
      'この器で手を動かしている担当 1 本（ターン中・返事待ち・背景処理が残っているもの）',
    );

    const byWorker = contextOf(
      await postToolUse(options, { ...managerBash, agent_id: 'agent-1', agent_type: 'worker' }),
    );
    expect(byWorker).toContain('pids が 950/1000');

    // 5分以内の2回目は添えない
    expect(contextOf(await postToolUse(options, managerBash))).toBeUndefined();

    const pidsNotes = events.filter(
      (event) => event.type === 'note' && event.text.includes('器の pids が 950/1000'),
    );
    expect(pidsNotes).toHaveLength(1);
  });

  it('担当の本数は、手を動かしている担当だけを数え、手が空いた done の担当は数えない', async () => {
    const { host, sessions } = await startWith(
      async () => ({ current: 950, max: 1000 }),
      ['mgr-1', 'mgr-2', 'mgr-3'],
    );
    // mgr-3 のターンを終えて done にする（背景処理は無い）
    await sessions[2]!.finish();
    await vi.waitFor(async () => {
      const states = await host.list();
      expect(states.find((state) => state.managerId === 'mgr-3')?.status).toBe('done');
    });

    const own = contextOf(await postToolUse(sessions[0]!.options, managerBash));
    expect(own).toContain('この器で手を動かしている担当 2 本');
  });

  it('上限から遠い器・読む口を渡さない構成では何も添えない', async () => {
    const far = await startWith(async () => ({ current: 300, max: 1000 }));
    expect(await postToolUse(far.options, managerBash)).toEqual({ continue: true });

    const none = await startWith(undefined);
    expect(await postToolUse(none.options, managerBash)).toEqual({ continue: true });
  });

  it('読む口が投げても、道具の結果は壊さない', async () => {
    const { options } = await startWith(async () => {
      throw new Error('cgroup が読めない');
    });
    expect(await postToolUse(options, managerBash)).toEqual({ continue: true });
  });
});
