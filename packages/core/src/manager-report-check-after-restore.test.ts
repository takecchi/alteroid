import { describe, expect, it, vi } from 'vitest';

import { createManagerPool } from './manager.js';
import {
  createRunnerRegistry,
  type RunnerAnswerOutcome,
  type RunnerClient,
  type RunnerEvent,
  type RunnerManagerState,
} from './runner-protocol.js';
import type { InboxEvent, Job } from './schema.js';
import { createMemoryStores } from './testing.js';

// 前のデーモンが `report` を受け取ったまま処理し終えずに落ちると、作り直したデーモンには二度と届かない。
// 引き取りの後の1回目の見回りで、ターンの終わりが最後の報告より新しければ、生ログの末尾から拾い直してクローンへ知らせる（#4644）。

const RESTORED_AT = Date.parse('2026-10-14T00:00:00.000Z');
const PAST_QUIET_GATE_MS = 11 * 60_000;

function endTurnLine(text: string, timestamp: string): string {
  return JSON.stringify({
    type: 'assistant',
    isSidechain: false,
    timestamp,
    message: { role: 'assistant', content: [{ type: 'text', text }], stop_reason: 'end_turn' },
  });
}

class LivingRunner implements RunnerClient {
  readonly runnerId = 'runner-primary';
  readonly runnerIdKnown = true;
  readonly workspacePathKnown = true;
  readonly workspacePath = '/work/project';
  alive: RunnerManagerState[] = [];
  liveTranscript: string | null = null;
  #emit: ((event: RunnerEvent) => unknown) | null = null;

  async emit(event: RunnerEvent): Promise<void> {
    await this.#emit?.(event);
  }

  async identity(): Promise<{ runnerId?: string; instanceId?: string } | undefined> {
    return { runnerId: this.runnerId, instanceId: 'boot-1' };
  }
  async connect(onEvent: (event: RunnerEvent) => unknown): Promise<void> {
    this.#emit = onEvent;
  }
  async start(): Promise<{ cwd?: string }> {
    return {};
  }
  async resume(): Promise<{ cwd?: string }> {
    return {};
  }
  async send(): Promise<boolean> {
    return true;
  }
  async answer(): Promise<RunnerAnswerOutcome> {
    return { delivered: false };
  }
  async stop(): Promise<void> {}
  async list(): Promise<RunnerManagerState[]> {
    return this.alive;
  }
  async transcript(): Promise<string | null> {
    return this.liveTranscript;
  }
  async credentials() {
    return [];
  }
  async setCredentials() {
    return [];
  }
  async profile() {
    return undefined;
  }
  async setProfile() {
    return { ok: true as const };
  }
  async close(): Promise<void> {}
}

const JOB: Job = {
  id: 'mgr-restored',
  createdAt: '2026-10-13T23:00:00.000Z',
  updatedAt: '2026-10-13T23:50:00.000Z',
  status: 'running',
  summary: '引き取られる委譲',
  request: '調べて',
  cwd: '/work/project',
  runnerId: 'runner-primary',
  sessionId: 'sess-restored',
  lastReportAt: '2026-10-13T23:50:00.000Z',
};

async function restoredHarness(job: Job = JOB) {
  const stores = createMemoryStores();
  await stores.jobs.putJob(job);
  const runner = new LivingRunner();
  runner.alive = [
    {
      managerId: job.id,
      status: 'running',
      cwd: '/work/project',
      request: '調べて',
      waiting: [],
      sessionId: 'sess-restored',
    },
  ];
  const registry = createRunnerRegistry();
  await registry.register({ label: 'http://runner:4518', open: async () => runner });
  const posted: InboxEvent[] = [];
  let clock = RESTORED_AT;
  const pool = createManagerPool({
    stores,
    post: (event) => posted.push(event),
    runners: registry,
    now: () => clock,
  });
  await pool.restore();
  return {
    pool,
    runner,
    recovered: () =>
      posted.flatMap((event) =>
        event.type === 'manager_message' && event.text.includes('生ログから拾い直した報告')
          ? [event]
          : [],
      ),
    advance: (ms: number) => {
      clock += ms;
    },
    close: async () => {
      await pool.stop();
      await registry.stop();
    },
  };
}

describe('再起動の引き取りの後、配られていない報告を生ログから拾い直す（#4644）', () => {
  it('ターンの終わりが最後の報告より新しければ、落ちたあとに拾い直したと断って末尾を1通だけ配る', async () => {
    const h = await restoredHarness();
    h.runner.liveTranscript = endTurnLine('調べ終えた。結論は X。', '2026-10-13T23:55:00.000Z');

    h.advance(PAST_QUIET_GATE_MS);
    await h.pool.probeTurnEnds();

    await vi.waitFor(() => expect(h.recovered()).toHaveLength(1));
    const [notice] = h.recovered();
    expect(notice?.managerId).toBe(JOB.id);
    expect(notice?.kind).toBe('report');
    expect(notice?.text).toContain('デーモンが落ちたあと');
    expect(notice?.text).toContain('添付があっても結ばれていない');
    expect(notice?.text).toContain('調べ終えた。結論は X。');

    // 1回確かめたら下ろす: 次の見回りでは配らない
    h.advance(PAST_QUIET_GATE_MS);
    await h.pool.probeTurnEnds();
    expect(h.recovered()).toHaveLength(1);

    await h.close();
  });

  it('最後の報告がターンの終わりより新しければ（届いていれば）配らない', async () => {
    const h = await restoredHarness();
    h.runner.liveTranscript = endTurnLine('届いた報告', '2026-10-13T23:45:00.000Z');

    h.advance(PAST_QUIET_GATE_MS);
    await h.pool.probeTurnEnds();

    expect(h.recovered()).toEqual([]);
    await h.close();
  });

  it('再起動をまたいでいない委譲は、ターンの終わりが新しくても拾い直しとして配らない', async () => {
    const h = await restoredHarness();
    h.runner.liveTranscript = endTurnLine('届いた報告', '2026-10-13T23:45:00.000Z');
    h.advance(PAST_QUIET_GATE_MS);
    // 1回目の見回りで印を下ろす（ここでは報告は届いている）
    await h.pool.probeTurnEnds();
    // その後の普通のターンの終わりは、報告が届く前でも拾い直しの対象にしない
    h.runner.liveTranscript = endTurnLine('これから届く報告', '2026-10-14T00:20:00.000Z');
    h.advance(PAST_QUIET_GATE_MS);
    await h.pool.probeTurnEnds();

    expect(h.recovered()).toEqual([]);
    await h.close();
  });
});
