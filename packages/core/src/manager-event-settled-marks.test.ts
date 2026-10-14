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

// 2026-10-14 の観測（#4485。別の器 miku）: 「直前の印: runner-event-handled:rescue_ref・窓に印なし」で 1〜2 秒止まった。
// handled は出来事の処理の同期の部分が返った印で、非同期の続き（台帳の読み書き・日誌）は印に挟まれない。続きまで終えた印と、退避 ref の後始末の前後の印を打ち、次の停止がどこの中かを分けられるようにする
describe('出来事の処理の非同期の続きと、退避 ref の後始末の前後に印を打つ（#4485）', () => {
  it('rescue_ref を受けると、続きまで終えたところで runner-event-settled:rescue_ref の印が打たれる', async () => {
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
    const pool = createManagerPool({
      stores,
      post: () => undefined,
      runners: createRunnerRegistry([fake.runner]),
    });
    await pool.restore();

    fake.emit({ type: 'rescue_ref', managerId: 'mgr-a', worktrees: [] });

    await vi.waitFor(() => expect(phases).toContain('runner-event-settled:rescue_ref'), {
      timeout: 5_000,
    });
  });

  it('退避 ref の後始末は、始まりと終わりに印を打つ', async () => {
    const stores = createMemoryStores();
    const fake = fakeRunner();
    const pool = createManagerPool({
      stores,
      post: () => undefined,
      runners: createRunnerRegistry([fake.runner]),
    });
    await pool.restore();

    await pool.sweepRescueRefs?.();

    const ours = phases.filter((label) => label.startsWith('rescue-sweep:'));
    expect(ours[0]).toMatch(/^rescue-sweep:start:\d+$/);
    expect(ours.at(-1)).toBe('rescue-sweep:done');
  });
});
