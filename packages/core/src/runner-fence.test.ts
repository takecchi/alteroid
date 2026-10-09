import type { Query, SDKMessage, query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RunnerFenceError } from './runner-protocol.js';
import type { RunnerEvent } from './runner-protocol.js';
import { createRunnerHost, type RunnerHost, type RunnerHostOptions } from './runner.js';

interface FakeSession {
  inputs: string[];
}

function fakeSdk(): { fn: typeof sdkQuery; sessions: FakeSession[]; callCount: () => number } {
  const sessions: FakeSession[] = [];
  let calls = 0;

  const fn = ((params: { prompt: AsyncIterable<{ message: { content: unknown } }> }) => {
    calls += 1;
    const session: FakeSession = { inputs: [] };
    sessions.push(session);
    let finish: (() => void) | null = null;

    async function* generate(): AsyncGenerator<SDKMessage, void> {
      yield {
        type: 'system',
        subtype: 'init',
        session_id: `sess-${sessions.length}`,
        uuid: `uuid-init-${sessions.length}`,
      } as unknown as SDKMessage;

      void (async () => {
        for await (const message of params.prompt) {
          session.inputs.push(String(message.message.content));
        }
      })();

      await new Promise<void>((resolve) => {
        finish = resolve;
      });
    }

    return Object.assign(generate(), {
      close: () => finish?.(),
      interrupt: async () => undefined,
    }) as unknown as Query;
  }) as unknown as typeof sdkQuery;

  return { fn, sessions, callCount: () => calls };
}

let hosts: RunnerHost[] = [];

afterEach(async () => {
  await Promise.all(hosts.map((host) => host.shutdown().catch(() => undefined)));
  hosts = [];
});

function setup(options: Pick<RunnerHostOptions, 'enforceLease'> = {}): {
  host: RunnerHost;
  events: RunnerEvent[];
  fake: ReturnType<typeof fakeSdk>;
} {
  const events: RunnerEvent[] = [];
  const fake = fakeSdk();
  const host = createRunnerHost({
    runnerId: 'runner-fence',
    workspacePath: '/work/project',
    emit: (event) => events.push(event),
    queryFn: fake.fn,
    env: { PATH: '/usr/bin' },
    // 実 I/O をさせない: fake timer では実 I/O が進まず、`#finish()` が assertion より遅れて解決する
    readCgroupEventCountersFn: async () => ({}),
    finishUnpushedWorkFn: async () => ({ cwd: '/work/project', worktrees: [] }),
    ...options,
  });
  hosts.push(host);
  return { host, events, fake };
}

function closedEvents(events: readonly RunnerEvent[]): Extract<RunnerEvent, { type: 'closed' }>[] {
  return events.filter((event): event is Extract<RunnerEvent, { type: 'closed' }> => {
    return event.type === 'closed';
  });
}

describe('resume の世代（fencing token）', () => {
  it('古い世代の resume は拒まれ、走っているセッションが1文字も影響を受けない', async () => {
    const { host, fake } = setup();
    await host.start({
      managerId: 'mgr-1',
      request: '最初の依頼',
      cwd: '/work/project',
      lease: { fence: 5, ttlMs: 60_000 },
    });
    expect(fake.callCount()).toBe(1);

    const rejection = host.resume({
      managerId: 'mgr-1',
      sessionId: 'sess-old',
      cwd: '/work/project',
      request: '再開の依頼',
      message: '古い世代からの一言',
      lease: { fence: 3, ttlMs: 60_000 },
    });
    await expect(rejection).rejects.toBeInstanceOf(RunnerFenceError);
    await expect(rejection).rejects.toMatchObject({ managerId: 'mgr-1', expected: 5, given: 3 });

    expect(fake.callCount()).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fake.sessions[0]?.inputs).not.toContain('古い世代からの一言');
    expect(host.list()).toHaveLength(1);
    expect(host.list()[0]?.managerId).toBe('mgr-1');
  });

  it('同じ世代の resume は受ける（再送）', async () => {
    const { host, fake } = setup();
    await host.start({
      managerId: 'mgr-1',
      request: '最初の依頼',
      cwd: '/work/project',
      lease: { fence: 5, ttlMs: 60_000 },
    });

    await host.resume({
      managerId: 'mgr-1',
      sessionId: 'sess-x',
      cwd: '/work/project',
      request: '再開の依頼',
      message: '再送の一言',
      lease: { fence: 5, ttlMs: 60_000 },
    });

    expect(fake.callCount()).toBe(1);
    await vi.waitFor(() => {
      expect(fake.sessions[0]?.inputs).toContain('再送の一言');
    });
  });

  it('新しい世代の resume は世代を更新し、走っているセッションを作り直さない', async () => {
    const { host, fake } = setup();
    await host.start({
      managerId: 'mgr-1',
      request: '最初の依頼',
      cwd: '/work/project',
      lease: { fence: 5, ttlMs: 60_000 },
    });

    await host.resume({
      managerId: 'mgr-1',
      sessionId: 'sess-x',
      cwd: '/work/project',
      request: '再開の依頼',
      message: '新しい世代からの一言',
      lease: { fence: 6, ttlMs: 60_000 },
    });

    expect(fake.callCount()).toBe(1);
    await vi.waitFor(() => {
      expect(fake.sessions[0]?.inputs).toContain('新しい世代からの一言');
    });

    await expect(
      host.resume({
        managerId: 'mgr-1',
        sessionId: 'sess-x',
        cwd: '/work/project',
        request: '再開の依頼',
        lease: { fence: 5, ttlMs: 60_000 },
      }),
    ).rejects.toMatchObject({ expected: 6, given: 5 });
    expect(fake.callCount()).toBe(1);
  });

  it('lease を伴わない resume は今までどおり動く（lease を知らない古いデーモンとの互換）', async () => {
    const { host, fake } = setup();
    await host.start({
      managerId: 'mgr-1',
      request: '最初の依頼',
      cwd: '/work/project',
      lease: { fence: 5, ttlMs: 60_000 },
    });

    await host.resume({
      managerId: 'mgr-1',
      sessionId: 'sess-x',
      cwd: '/work/project',
      request: '再開の依頼',
      message: 'lease 無しの一言',
    });

    expect(fake.callCount()).toBe(1);
    await vi.waitFor(() => {
      expect(fake.sessions[0]?.inputs).toContain('lease 無しの一言');
    });
  });

  it('この Host インスタンスにとって初めての resume は、世代を覚えるだけで拒まない（器の入れ替え後）', async () => {
    const { host, fake } = setup();

    await host.resume({
      managerId: 'mgr-2',
      sessionId: 'sess-y',
      cwd: '/work/project',
      request: '引き継ぎの依頼',
      lease: { fence: 9, ttlMs: 60_000 },
    });

    expect(fake.callCount()).toBe(1);
    expect(host.list()).toHaveLength(1);

    await expect(
      host.resume({
        managerId: 'mgr-2',
        sessionId: 'sess-y',
        cwd: '/work/project',
        request: '引き継ぎの依頼',
        lease: { fence: 8, ttlMs: 60_000 },
      }),
    ).rejects.toMatchObject({ expected: 9, given: 8 });
  });
});

describe('貸し出し期限の自己失効（enforceLease）', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('期限を過ぎたら畳まれ、closed が上がる', async () => {
    const { host, events } = setup({ enforceLease: true });
    await host.start({
      managerId: 'mgr-1',
      request: '最初の依頼',
      cwd: '/work/project',
      lease: { fence: 1, ttlMs: 30_000 },
    });
    expect(host.list()).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(30_000);

    expect(host.list()).toHaveLength(0);
    const closed = closedEvents(events);
    expect(closed).toHaveLength(1);
    expect(closed[0]?.managerId).toBe('mgr-1');
    expect(closed[0]?.reason).toContain(
      'デーモンと連絡が取れないので貸し出し期限が切れた（自己失効）',
    );
    expect(closed[0]?.selfFenced).toBe(true);
    expect(closed[0]?.status).toBe('lost');
  });

  it('明示停止（`Host#stop`）では `selfFenced` が立たない', async () => {
    const { host, events } = setup({ enforceLease: true });
    await host.start({
      managerId: 'mgr-1',
      request: '最初の依頼',
      cwd: '/work/project',
      lease: { fence: 1, ttlMs: 30_000 },
    });

    await host.stop('mgr-1');

    expect(host.list()).toHaveLength(0);
    expect(closedEvents(events)).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(closedEvents(events)).toHaveLength(0);
  });

  it('器の `shutdown()` では `selfFenced` が立たない', async () => {
    const { host, events } = setup({ enforceLease: true });
    await host.start({
      managerId: 'mgr-1',
      request: '最初の依頼',
      cwd: '/work/project',
      lease: { fence: 1, ttlMs: 30_000 },
    });

    await host.shutdown();

    expect(host.list()).toHaveLength(0);
    expect(closedEvents(events)).toHaveLength(0);
  });

  it('接触があれば時計が戻る（`noteDaemonContact` が期限を延ばす）', async () => {
    const { host, events } = setup({ enforceLease: true });
    await host.start({
      managerId: 'mgr-1',
      request: '最初の依頼',
      cwd: '/work/project',
      lease: { fence: 1, ttlMs: 20_000 },
    });

    await vi.advanceTimersByTimeAsync(10_000);
    expect(host.list()).toHaveLength(1);

    host.noteDaemonContact();

    await vi.advanceTimersByTimeAsync(10_000);
    expect(host.list()).toHaveLength(1);
    expect(closedEvents(events)).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(host.list()).toHaveLength(0);
    expect(closedEvents(events)).toHaveLength(1);
  });

  it('enforceLease が既定（false）なら、期限を過ぎても畳まれない', async () => {
    const { host, events } = setup();
    await host.start({
      managerId: 'mgr-1',
      request: '最初の依頼',
      cwd: '/work/project',
      lease: { fence: 1, ttlMs: 30_000 },
    });

    await vi.advanceTimersByTimeAsync(5 * 60_000);

    expect(host.list()).toHaveLength(1);
    expect(closedEvents(events)).toHaveLength(0);
  });

  it('lease を伴わずに起こされたセッションは、enforceLease が true でも畳まれない', async () => {
    const { host, events } = setup({ enforceLease: true });
    await host.start({
      managerId: 'mgr-1',
      request: '最初の依頼',
      cwd: '/work/project',
    });

    await vi.advanceTimersByTimeAsync(5 * 60_000);

    expect(host.list()).toHaveLength(1);
    expect(closedEvents(events)).toHaveLength(0);
  });
});
