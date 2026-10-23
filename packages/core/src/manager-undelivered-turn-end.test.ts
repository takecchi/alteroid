import { describe, expect, it, vi } from 'vitest';

import { createManagerPool } from './manager.js';
import {
  createRunnerRegistry,
  RUNNER_CAPABILITY_TRANSCRIPT_TAIL,
  type RunnerAnswerOutcome,
  type RunnerClient,
  type RunnerEvent,
  type RunnerManagerState,
} from './runner-protocol.js';
import type { InboxEvent, Job } from './schema.js';
import { createMemoryStores } from './testing.js';

// end_turn で終わったターンの報告が届かないまま台帳が running に残ると、担当は報告したつもりで待ち、クローンは知らないまま止まる。
// 再起動をまたがない回でも、ターンの終わりから10分たって届いていなければ、生ログの末尾から拾ってクローンへ1通配る（#5195）。

const RESTORED_AT = Date.parse('2026-10-23T13:40:00.000Z');
const MINUTE = 60_000;

function turnEndLine(text: string, timestamp: string, stopReason = 'end_turn'): string {
  return JSON.stringify({
    type: 'assistant',
    isSidechain: false,
    timestamp,
    message: { role: 'assistant', content: [{ type: 'text', text }], stop_reason: stopReason },
  });
}

class LivingRunner implements RunnerClient {
  readonly runnerId = 'runner-5';
  readonly runnerIdKnown = true;
  readonly workspacePathKnown = true;
  readonly workspacePath = '/work/project';
  alive: RunnerManagerState[] = [];
  liveTranscript: string | null = null;

  async identity(): Promise<{ runnerId?: string; instanceId?: string } | undefined> {
    return { runnerId: this.runnerId, instanceId: 'boot-1' };
  }
  async connect(onEvent: (event: RunnerEvent) => unknown): Promise<void> {
    // 見回りは末尾の口を名乗る runner からだけ読む（#5160）
    await onEvent({
      type: 'hello',
      runnerId: this.runnerId,
      capabilities: [RUNNER_CAPABILITY_TRANSCRIPT_TAIL],
    });
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
  async transcriptTail(): Promise<string | null> {
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

// 13:33Z の失敗の報告が最後に届いた報告のまま、という Issue の形に合わせる
const JOB: Job = {
  id: 'mgr-landrule',
  createdAt: '2026-10-23T12:00:00.000Z',
  updatedAt: '2026-10-23T13:33:00.000Z',
  status: 'running',
  summary: '取り込みと片付け',
  request: '取り込んで',
  cwd: '/work/project',
  runnerId: 'runner-5',
  sessionId: 'sess-landrule',
  lastReportAt: '2026-10-23T13:33:00.000Z',
};

async function harness() {
  const stores = createMemoryStores();
  await stores.jobs.putJob(JOB);
  const runner = new LivingRunner();
  runner.alive = [
    {
      managerId: JOB.id,
      status: 'running',
      cwd: '/work/project',
      request: '取り込んで',
      waiting: [],
      sessionId: 'sess-landrule',
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
  // 再起動の引き取りの後の1回目の見回りを済ませる（ここではまだターンは終わっていない）。以後は再起動をまたがない回になる
  clock += 11 * MINUTE;
  await pool.probeTurnEnds();
  return {
    pool,
    runner,
    decisions: async () => stores.journal.list({ types: ['decision'] }),
    recovered: () =>
      posted.flatMap((event) =>
        event.type === 'manager_message' && event.text.includes('生ログの末尾から拾って配る')
          ? [event]
          : [],
      ),
    restoreNotices: () =>
      posted.filter(
        (event) => event.type === 'manager_message' && event.text.includes('生ログから拾い直した'),
      ),
    setClock: (iso: string) => {
      clock = Date.parse(iso);
    },
    close: async () => {
      await pool.stop();
      await registry.stop();
    },
  };
}

describe('届かなかった end_turn の報告を、見回りが生ログから拾ってクローンへ配る（#5195）', () => {
  it('⭐ ターンの終わりから10分たっても報告が届かず running のままなら、末尾を1通だけ配り、日誌に世代と runner を残す', async () => {
    const h = await harness();
    h.runner.liveTranscript = turnEndLine(
      '取り込みと作業ツリーの片付けを終えた。',
      '2026-10-23T14:02:59.000Z',
    );

    h.setClock('2026-10-23T14:13:30.000Z');
    await h.pool.probeTurnEnds();

    await vi.waitFor(() => expect(h.recovered()).toHaveLength(1));
    const [notice] = h.recovered();
    expect(notice?.managerId).toBe(JOB.id);
    expect(notice?.kind).toBe('report');
    expect(notice?.text).toContain('2026-10-23T14:02:59.000Z に end_turn で終わったが');
    expect(notice?.text).toContain('最後に届いた報告: 2026-10-23T13:33:00.000Z');
    expect(notice?.text).toContain('取り込みと作業ツリーの片付けを終えた。');
    // 再起動の拾い直しとは名乗らない（再起動をまたいでいない）
    expect(h.restoreNotices()).toEqual([]);
    const decision = JSON.stringify(await h.decisions());
    expect(decision).toContain('分届かないので、生ログの末尾から拾ってクローンへ配る（#5195）');
    expect(decision).toContain('runnerId=runner-5');

    // 同じターンの終わりは、次の見回りでは配らない
    h.setClock('2026-10-23T14:30:00.000Z');
    await h.pool.probeTurnEnds();
    expect(h.recovered()).toHaveLength(1);

    // 次のターンの終わりも届かなければ、それはまた1通配る（同じ日に2回あった形）
    h.runner.liveTranscript = turnEndLine('2回目の報告。', '2026-10-23T15:19:38.000Z');
    h.setClock('2026-10-23T15:31:00.000Z');
    await h.pool.probeTurnEnds();
    await vi.waitFor(() => expect(h.recovered()).toHaveLength(2));
    expect(h.recovered()[1]?.text).toContain('2回目の報告。');

    await h.close();
  });

  it('ターンの終わりから10分たっていなければ配らない（届く途中の報告と二重にしない）', async () => {
    const h = await harness();
    h.runner.liveTranscript = turnEndLine('これから届く報告', '2026-10-23T14:02:59.000Z');

    h.setClock('2026-10-23T14:10:00.000Z');
    await h.pool.probeTurnEnds();

    expect(h.recovered()).toEqual([]);
    await h.close();
  });

  it('最後に届いた報告がターンの終わりより新しければ配らない', async () => {
    const h = await harness();
    h.runner.liveTranscript = turnEndLine('届いた報告', '2026-10-23T13:20:00.000Z');

    h.setClock('2026-10-23T14:13:30.000Z');
    await h.pool.probeTurnEnds();

    expect(h.recovered()).toEqual([]);
    await h.close();
  });

  it('stop_sequence（枠の壁）で終わったターンは拾わない（失敗の報告として別に届く）', async () => {
    const h = await harness();
    h.runner.liveTranscript = turnEndLine('', '2026-10-23T14:02:59.000Z', 'stop_sequence');

    h.setClock('2026-10-23T14:13:30.000Z');
    await h.pool.probeTurnEnds();

    expect(h.recovered()).toEqual([]);
    await h.close();
  });
});
