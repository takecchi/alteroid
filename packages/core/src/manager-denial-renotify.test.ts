import { describe, expect, it, vi } from 'vitest';

import { createManagerPool, type ManagerPool } from './manager.js';
import {
  createRunnerRegistry,
  type RunnerAnswerOutcome,
  type RunnerClient,
  type RunnerEvent,
  type RunnerManagerState,
} from './runner-protocol.js';
import type { InboxEvent, Job, JobStatus } from './schema.js';
import { createMemoryStores } from './testing.js';
import type { Stores } from './store.js';

interface ManualRunner {
  runner: RunnerClient;
  alive: RunnerManagerState[];
  report(managerId: string, text: string, status: JobStatus): void;
  ask(managerId: string, requestId: string, summary: string): void;
  answerAsk(requestId: string): void;
  closed(managerId: string, status: 'done' | 'lost' | 'failed', reason: string): void;
  denied(
    managerId: string,
    tool: string,
    fields?: { actor?: string; inputHead?: string; toolUseId?: string },
  ): void;
  toolUse(managerId: string, actor: string, tool: string): void;
}

function manualRunner(runnerId = 'runner-primary'): ManualRunner {
  let emit: ((event: RunnerEvent) => void) | null = null;
  const alive: RunnerManagerState[] = [];

  const runner: RunnerClient = {
    runnerId,
    runnerIdKnown: true,
    workspacePath: '/work/project',
    workspacePathKnown: true,
    async connect(onEvent) {
      emit = onEvent;
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
    async stop(managerId) {
      const at = alive.findIndex((entry) => entry.managerId === managerId);
      if (at !== -1) alive.splice(at, 1);
    },
    async list() {
      return [...alive];
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
      /* この検証では使わない */
    },
  };

  return {
    runner,
    alive,
    report(managerId, text, status) {
      emit?.({ type: 'report', managerId, text, status });
    },
    ask(managerId, requestId, summary) {
      emit?.({
        type: 'ask',
        managerId,
        requestId,
        kind: 'permission',
        summary,
        askedAt: new Date().toISOString(),
      });
    },
    answerAsk() {
      /* このファイルは「未決のまま」だけを見るので、実際に解決させる経路は使わない */
    },
    closed(managerId, status, reason) {
      const at = alive.findIndex((entry) => entry.managerId === managerId);
      if (at !== -1) alive.splice(at, 1);
      emit?.({ type: 'closed', managerId, status, reason });
    },
    denied(managerId, tool, fields = {}) {
      emit?.({
        type: 'permission_denied',
        managerId,
        toolUseId: `${tool}:${String(Math.random())}`,
        tool,
        input: {},
        via: 'live',
        ...fields,
      });
    },
    toolUse(managerId, actor, tool) {
      emit?.({ type: 'tool_use', managerId, actor, tool });
    },
  };
}

interface ManualSetup {
  pool: ManagerPool;
  stores: Stores;
  inbox: InboxEvent[];
  fake: ManualRunner;
  advance: (ms: number) => void;
}

async function runningManualSetup(managerId = 'mgr-denial-renotify'): Promise<ManualSetup> {
  const job: Job = {
    id: managerId,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    status: 'running',
    summary: '調べ物',
    request: '調べて',
    cwd: '/work/project',
    sessionId: `sess-${managerId}`,
    runnerId: 'runner-primary',
  };
  const stores = createMemoryStores();
  await stores.jobs.putJob(job);

  const fake = manualRunner();
  fake.alive.push({
    managerId: job.id,
    status: 'running',
    cwd: '/work/project',
    request: '調べて',
    waiting: [],
    sessionId: job.sessionId,
  });

  const registry = createRunnerRegistry([fake.runner]);
  const inbox: InboxEvent[] = [];
  let clock = Date.parse('2026-09-01T00:00:00.000Z');
  const pool = createManagerPool({
    stores,
    post: (event) => inbox.push(event),
    runners: registry,
    now: () => clock,
  });

  await pool.restore();
  await vi.waitFor(() => {
    if (inbox.length === 0) throw new Error('reattach の知らせがまだ届いていない');
  });

  return { pool, stores, inbox, fake, advance: (ms) => (clock += ms) };
}

async function waitForDenialJournaled(stores: Stores, tool: string): Promise<void> {
  await waitForDenialJournaledCount(stores, tool, 1);
}

// 日誌への書き終わりを待たずに時計を進めない: `fake.denied()` は fire-and-forget で、escalation の受信箱への配達と競走し件数を数え間違える。
async function waitForDenialJournaledCount(
  stores: Stores,
  tool: string,
  count: number,
): Promise<void> {
  await vi.waitFor(async () => {
    const entries = await stores.journal.list({ types: ['exchange'] });
    const matches = entries.filter((entry) =>
      JSON.stringify(entry).includes(`${tool} の実行が確認へ上がらずに止められた`),
    );
    if (matches.length < count) {
      throw new Error(
        `${String(count)} 件目の拒否がまだ日誌に載っていない（いまは ${String(matches.length)} 件）`,
      );
    }
  });
}

const TEN_MINUTES_MS = 10 * 60_000;
const THIRTY_MINUTES_MS = 30 * 60_000;

describe('renotifyStalledDenials（issue #1105 C）', () => {
  it('拒否から10分、動きが無ければ1回目の知らせ直しが届く', async () => {
    const { pool, stores, inbox, fake, advance } = await runningManualSetup();
    fake.denied('mgr-denial-renotify', 'Bash', { actor: 'manager:mgr-denial-renotify' });
    await waitForDenialJournaled(stores, 'Bash');

    const before = inbox.length;

    advance(TEN_MINUTES_MS - 1);
    await pool.renotifyStalledDenials();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(inbox.length).toBe(before);

    advance(1);
    await pool.renotifyStalledDenials();
    const delivered = await vi.waitFor(() => {
      const found = inbox.slice(before).find((event) => event.type === 'manager_message');
      if (!found) throw new Error('まだ届いていない');
      return found as { text: string };
    });
    expect(delivered.text).toContain('Bash');
    expect(delivered.text).toContain('動きが無い');
    expect(delivered.text).toContain('知らせ直し 1/2 回目');
    expect(delivered.text).toContain('issue #1105 C');
    expect(delivered.text).toContain('requestId` が無く');
    expect(delivered.text).toContain('journal_read');

    await pool.stop();
  });

  it('1回目の後さらに30分、まだ動きが無ければ2回目が届く', async () => {
    const { pool, stores, inbox, fake, advance } = await runningManualSetup();
    fake.denied('mgr-denial-renotify', 'Bash');
    await waitForDenialJournaled(stores, 'Bash');

    advance(TEN_MINUTES_MS + 1);
    await pool.renotifyStalledDenials();
    await vi.waitFor(() => {
      if (!inbox.some((event) => event.type === 'manager_message')) throw new Error('1回目がまだ');
    });
    const afterFirst = inbox.length;

    advance(THIRTY_MINUTES_MS - 1 - (TEN_MINUTES_MS + 1));
    await pool.renotifyStalledDenials();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(inbox.length).toBe(afterFirst);

    advance(2);
    await pool.renotifyStalledDenials();
    const second = await vi.waitFor(() => {
      const found = inbox.slice(afterFirst).find((event) => event.type === 'manager_message');
      if (!found) throw new Error('2回目がまだ届いていない');
      return found as { text: string };
    });
    expect(second.text).toContain('知らせ直し 2/2 回目');

    await pool.stop();
  });

  it('2回とも出したら、それ以上は黙る。黙ったことは日誌に1行残る', async () => {
    const { pool, stores, inbox, fake, advance } = await runningManualSetup();
    fake.denied('mgr-denial-renotify', 'Bash');
    await waitForDenialJournaled(stores, 'Bash');

    advance(TEN_MINUTES_MS + 1);
    await pool.renotifyStalledDenials();
    await vi.waitFor(() => {
      if (!inbox.some((event) => event.type === 'manager_message')) throw new Error('1回目がまだ');
    });

    advance(THIRTY_MINUTES_MS - TEN_MINUTES_MS);
    await pool.renotifyStalledDenials();
    await vi.waitFor(async () => {
      const entries = await stores.journal.list({ types: ['exchange'] });
      if (!entries.some((entry) => JSON.stringify(entry).includes('知らせ直しを2回とも出した'))) {
        throw new Error('黙った跡がまだ日誌に無い');
      }
    });

    const before = inbox.length;
    advance(4 * 60 * 60_000);
    await pool.renotifyStalledDenials();
    await pool.renotifyStalledDenials();
    await pool.renotifyStalledDenials();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(inbox.length).toBe(before);

    await pool.stop();
  });

  it('拒否の後に道具が決着した（tool_use）ら、知らせ直さない', async () => {
    const { pool, stores, inbox, fake, advance } = await runningManualSetup();
    fake.denied('mgr-denial-renotify', 'Bash', { actor: 'manager:mgr-denial-renotify' });
    await waitForDenialJournaled(stores, 'Bash');

    advance(5 * 60_000);
    fake.toolUse('mgr-denial-renotify', 'manager:mgr-denial-renotify', 'Read');
    await new Promise((resolve) => setTimeout(resolve, 20));

    const before = inbox.length;
    advance(TEN_MINUTES_MS);
    await pool.renotifyStalledDenials();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(inbox.length).toBe(before);

    await pool.stop();
  });

  it('拒否の後に報告（report）が届いたら、知らせ直さない', async () => {
    const { pool, stores, inbox, fake, advance } = await runningManualSetup();
    fake.denied('mgr-denial-renotify', 'Bash');
    await waitForDenialJournaled(stores, 'Bash');

    advance(5 * 60_000);
    fake.report('mgr-denial-renotify', '別件の報告', 'running');
    await new Promise((resolve) => setTimeout(resolve, 20));

    const before = inbox.length;
    advance(TEN_MINUTES_MS);
    await pool.renotifyStalledDenials();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(inbox.length).toBe(before);

    await pool.stop();
  });

  it('この拒否自身への P1 の確認が未決（waiting_human）のままなら、知らせ直さない（対照。issue #1772）', async () => {
    const { pool, stores, inbox, fake, advance } = await runningManualSetup();
    // `requestId` を拒否の `toolUseId` と同じ値にする: 一致しないと「この拒否自身への確認」にならず、無関係な確認との取り違えを測れない。
    fake.denied('mgr-denial-renotify', 'Bash', { toolUseId: 'req-same-denial' });
    await waitForDenialJournaled(stores, 'Bash');
    fake.ask('mgr-denial-renotify', 'req-same-denial', '1回だけ許可しますか');
    await new Promise((resolve) => setTimeout(resolve, 20));

    const before = inbox.length;
    advance(TEN_MINUTES_MS + 1);
    await pool.renotifyStalledDenials();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(inbox.length).toBe(before);

    await pool.stop();
  });

  it('M が終わった（closed）ら、知らせ直さない（クラッシュもしない）', async () => {
    const { pool, stores, inbox, fake, advance } = await runningManualSetup();
    fake.denied('mgr-denial-renotify', 'Bash');
    await waitForDenialJournaled(stores, 'Bash');

    advance(1000);
    fake.closed('mgr-denial-renotify', 'done', '委譲が終わった');
    await new Promise((resolve) => setTimeout(resolve, 20));

    const before = inbox.length;
    advance(TEN_MINUTES_MS);
    await expect(pool.renotifyStalledDenials()).resolves.toBeUndefined();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(inbox.length).toBe(before);

    await pool.stop();
  });

  it('新しい拒否（同じ道具×層）が来ると、古いエピソードを捨てて1回目から数え直す', async () => {
    const { pool, stores, inbox, fake, advance } = await runningManualSetup();
    fake.denied('mgr-denial-renotify', 'Bash');
    await waitForDenialJournaled(stores, 'Bash');

    advance(TEN_MINUTES_MS + 1);
    await pool.renotifyStalledDenials();
    const afterFirst = await vi.waitFor(() => {
      const found = inbox.find(
        (event) => event.type === 'manager_message' && event.text.includes('知らせ直し 1/2 回目'),
      );
      if (!found) throw new Error('1回目がまだ');
      return inbox.length;
    });

    advance(60_000);
    fake.denied('mgr-denial-renotify', 'Bash');
    await waitForDenialJournaledCount(stores, 'Bash', 2);

    advance(TEN_MINUTES_MS - 1);
    await pool.renotifyStalledDenials();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(inbox.length).toBe(afterFirst);

    advance(2);
    await pool.renotifyStalledDenials();
    const second = await vi.waitFor(() => {
      const found = inbox.slice(afterFirst).find((event) => event.type === 'manager_message');
      if (!found) throw new Error('新しいエピソードの1回目がまだ届いていない');
      return found as { text: string };
    });
    expect(second.text).toContain('知らせ直し 1/2 回目');

    await pool.stop();
  });
});
