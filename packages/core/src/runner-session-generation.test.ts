import type { Query, SDKMessage, query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { RunnerEvent } from './runner-protocol.js';
import { createRunnerHost, type RunnerHost } from './runner.js';

/**
 * セッションの世代（Issue #3170）— runner 側。`Host#create` がセッションを作るたびに新しい値を振り、
 * `start` / `resume` の応答と、そのセッションが出す `closed` / `session` などに載せる。
 * **デーモンが古いセッションの出来事を見分ける材料**（`manager-same-runner-resume-stale-closed.test.ts`）。
 */

/** 閉じられるまで開いたまま、init で `session` を名乗る偽 SDK（`runner-fence.test.ts` の `fakeSdk` と同じ形）。 */
function fakeSdk(): typeof sdkQuery {
  let calls = 0;
  return ((params: { prompt: AsyncIterable<unknown> }) => {
    calls += 1;
    const n = calls;
    let finish: (() => void) | null = null;
    async function* generate(): AsyncGenerator<SDKMessage, void> {
      yield {
        type: 'system',
        subtype: 'init',
        session_id: `sess-${n}`,
        uuid: `uuid-init-${n}`,
      } as unknown as SDKMessage;
      void (async () => {
        for await (const message of params.prompt) void message;
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
}

let hosts: RunnerHost[] = [];

afterEach(async () => {
  await Promise.all(hosts.map((host) => host.shutdown().catch(() => undefined)));
  hosts = [];
});

function setup(options: { enforceLease?: boolean } = {}): {
  host: RunnerHost;
  events: RunnerEvent[];
} {
  const events: RunnerEvent[] = [];
  const host = createRunnerHost({
    runnerId: 'runner-generation',
    workspacePath: '/work/project',
    emit: (event) => events.push(event),
    queryFn: fakeSdk(),
    env: { PATH: '/usr/bin' },
    // 実 I/O をさせない（`runner-fence.test.ts` の同じ差し替えの注記）。
    readCgroupEventCountersFn: async () => ({}),
    finishUnpushedWorkFn: async () => ({ cwd: '/work/project', worktrees: [] }),
    ...options,
  });
  hosts.push(host);
  return { host, events };
}

const generationsOf = (events: readonly RunnerEvent[], type: RunnerEvent['type']): unknown[] =>
  events
    .filter((event) => event.type === type)
    .map((event) => (event as { sessionGeneration?: string }).sessionGeneration);

describe('セッションの世代（runner が発行する）', () => {
  it('closed は、畳まれたセッション自身の世代を名乗る（貸し出し期限の自己失効で畳む回）', async () => {
    vi.useFakeTimers();
    try {
      const { host, events } = setup({ enforceLease: true });
      const started = await host.start({
        managerId: 'mgr-1',
        request: '依頼',
        cwd: '/work/project',
        lease: { fence: 1, ttlMs: 30_000 },
      });
      await vi.advanceTimersByTimeAsync(30_000);
      expect(generationsOf(events, 'closed')).toEqual([started.sessionGeneration]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('start の応答の世代が、そのセッションの session イベントに載る', async () => {
    const { host, events } = setup();
    const started = await host.start({ managerId: 'mgr-1', request: '依頼', cwd: '/work/project' });
    expect(started.sessionGeneration.length).toBeGreaterThan(0);
    await vi.waitFor(() => {
      expect(generationsOf(events, 'session')).toEqual([started.sessionGeneration]);
    });
  });

  it('生きているセッションへ短絡した resume は同じ世代を返し、畳んだ後に作り直した resume は新しい世代を返す', async () => {
    const { host, events } = setup();
    const started = await host.start({ managerId: 'mgr-1', request: '依頼', cwd: '/work/project' });

    const reused = await host.resume({
      managerId: 'mgr-1',
      sessionId: 'sess-1',
      cwd: '/work/project',
      request: '再開',
    });
    expect(reused.reusedLiveSession).toBe(true);
    expect(reused.sessionGeneration).toBe(started.sessionGeneration);

    await host.stop('mgr-1');
    const rebuilt = await host.resume({
      managerId: 'mgr-1',
      sessionId: 'sess-1',
      cwd: '/work/project',
      request: '再開',
    });
    expect(rebuilt.reusedLiveSession).toBe(false);
    expect(rebuilt.sessionGeneration).not.toBe(started.sessionGeneration);

    await vi.waitFor(() => {
      expect(generationsOf(events, 'session')).toEqual([
        started.sessionGeneration,
        rebuilt.sessionGeneration,
      ]);
    });
  });

  it('世代を載せるのは委譲に結びつく5種だけで、ほかの出来事（hello など）は変えない', async () => {
    const { host, events } = setup();
    await host.start({ managerId: 'mgr-1', request: '依頼', cwd: '/work/project' });
    await vi.waitFor(() => expect(events.some((e) => e.type === 'session')).toBe(true));
    const carrying = events
      .filter((event) => 'sessionGeneration' in event)
      .map((event) => event.type);
    expect(carrying.length).toBeGreaterThan(0);
    for (const type of carrying) {
      expect(['closed', 'session', 'report', 'ask', 'settled']).toContain(type);
    }
  });
});
