import { beforeEach, describe, expect, it, vi } from 'vitest';

// 印そのものだけを差し替える: 見張りの本体は使わない
const phases = vi.hoisted(() => [] as string[]);
vi.mock('./loop-stall.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./loop-stall.js')>()),
  notePhase: (label: string) => {
    phases.push(label);
  },
}));

const { createManagerPool } = await import('./manager.js');
const { createRunnerRegistry } = await import('./runner-protocol.js');
const { createMemoryStores } = await import('./testing.js');
import type { RunnerAnswerOutcome, RunnerClient, RunnerEvent } from './runner-protocol.js';

function fakeRunner() {
  let onEvent: ((event: RunnerEvent) => void) | undefined;
  const runner: RunnerClient = {
    runnerId: 'runner-primary',
    runnerIdKnown: true,
    workspacePath: '/work/project',
    workspacePathKnown: true,
    async connect(listener) {
      onEvent = listener;
    },
    async start(): Promise<{ cwd?: string }> {
      return {};
    },
    async resume(): Promise<{ cwd?: string }> {
      return {};
    },
    async send() {
      return true;
    },
    async answer(): Promise<RunnerAnswerOutcome> {
      return { delivered: false };
    },
    async stop() {
      /* 使わない */
    },
    async list() {
      return [
        {
          managerId: 'mgr-a',
          status: 'running' as const,
          cwd: '/work/mgr-a',
          request: '調べて',
          waiting: [],
          sessionId: 'sess-a',
        },
      ];
    },
    async transcript() {
      return null;
    },
    async credentials() {
      return [];
    },
    async setCredentials() {
      return [];
    },
    async profile() {
      return undefined;
    },
    async setProfile() {
      return { ok: true as const };
    },
    async close() {
      /* 使わない */
    },
  };
  return {
    runner,
    emit: (event: RunnerEvent) => {
      if (onEvent === undefined) throw new Error('connect() がまだ呼ばれていない');
      onEvent(event);
    },
  };
}

beforeEach(() => {
  phases.length = 0;
});

// 2026-10-13T16:52〜16:54Z、利用上限で担当が一斉に落ちた回に、「直前の印: runner-event:rate_limit・窓に印なし」の停止が続いた。
// 回し手（鍵の回転の判断・配布・セッションの作り直し）が止めていたのかを、印で分けられるようにする（#4485）
describe('利用上限の観測を鍵の回し手へ渡す前後に印を打つ（#4485）', () => {
  it('rate_limit（rejected）を受けると、回し手の前後に印が並び、回し手の中の処理はその間に入る', async () => {
    const stores = createMemoryStores();
    await stores.jobs.putJob({
      id: 'mgr-a',
      createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-01T00:00:00.000Z',
      status: 'running',
      summary: '調べ物',
      request: '調べて',
      cwd: '/work/mgr-a',
      sessionId: 'sess-a',
      runnerId: 'runner-primary',
    });
    const fake = fakeRunner();
    const observed: unknown[] = [];
    const pool = createManagerPool({
      stores,
      post: () => undefined,
      runners: createRunnerRegistry([fake.runner]),
      onUsageObservation: async (observation) => {
        phases.push('inside-rotator');
        observed.push(observation);
      },
    });
    await pool.restore();

    fake.emit({
      type: 'rate_limit',
      managerId: 'mgr-a',
      facts: { kind: 'five_hour', status: 'rejected' },
    });

    await vi.waitFor(() => expect(observed).toHaveLength(1), { timeout: 5_000 });
    await vi.waitFor(() => expect(phases).toContain('manager:token-rotation-done:mgr-a'), {
      timeout: 5_000,
    });
    const ours = phases.filter(
      (label) => label.startsWith('manager:token-rotation') || label === 'inside-rotator',
    );
    expect(ours).toEqual([
      'manager:token-rotation:mgr-a',
      'inside-rotator',
      'manager:token-rotation-done:mgr-a',
    ]);
  });
});
