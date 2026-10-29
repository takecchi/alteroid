import { describe, expect, it, vi } from 'vitest';

import { createManagerPool } from './manager.js';
import { RunnerHttpError } from './runner-protocol.js';
import type {
  RunnerAnswerOutcome,
  RunnerClient,
  RunnerCredentialFingerprint,
  RunnerEntry,
  RunnerManagerState,
  RunnerProfileFingerprint,
  RunnerProfileResult,
  RunnerRegistry,
} from './runner-protocol.js';
import type { InboxEvent, Job } from './schema.js';
import { createMemoryStores } from './testing.js';

describe('resume 中に abort で止めた委譲を、resume の失敗が lost で上書きしない', () => {
  function setup(): {
    registry: RunnerRegistry;
    client: RunnerClient;
    gate: { release: () => void; entered: Promise<void> };
  } {
    const sessions = new Map<string, RunnerManagerState>();
    let release!: () => void;
    const g = new Promise<void>((r) => {
      release = r;
    });
    let entered!: () => void;
    const enteredP = new Promise<void>((r) => {
      entered = r;
    });
    const client: RunnerClient = {
      runnerId: 'runner-a',
      runnerIdKnown: true,
      workspacePathKnown: true,
      workspacePath: '/work/project',
      async connect() {},
      async start(): Promise<{ cwd?: string }> {
        return {};
      },
      async resume(): Promise<{ cwd?: string }> {
        entered();
        await g;
        throw new RunnerHttpError('bad session', 400);
      },
      async send() {
        return true;
      },
      async answer(): Promise<RunnerAnswerOutcome> {
        return { delivered: false };
      },
      async stop(managerId) {
        sessions.delete(managerId);
      },
      async list() {
        return [...sessions.values()];
      },
      async transcript() {
        return null;
      },
      async credentials(): Promise<RunnerCredentialFingerprint[]> {
        return [];
      },
      async setCredentials(): Promise<RunnerCredentialFingerprint[]> {
        return [];
      },
      async profile(): Promise<RunnerProfileFingerprint | undefined> {
        return undefined;
      },
      async setProfile(): Promise<RunnerProfileResult> {
        return { ok: true };
      },
      async close() {},
    };
    const entries: RunnerEntry[] = [
      {
        label: 'runner-a',
        state: 'connected',
        runnerId: 'runner-a',
        since: '2026-08-01T00:00:00.000Z',
        revision: { status: 'unheard' },
      },
    ];
    const registry: RunnerRegistry = {
      async list() {
        return [client];
      },
      async get(id) {
        return id === 'runner-a' ? client : null;
      },
      async select() {
        throw new Error('unused');
      },
      async register() {},
      async unregister() {},
      vacate() {},
      entries() {
        return entries.map((e) => ({ ...e }));
      },
      noteManagerFailed() {},
      subscribe() {
        return () => {};
      },
      async stop() {},
    };
    return { registry, client, gate: { release, entered: enteredP } };
  }

  const job: Job = {
    id: 'mgr-1',
    managerId: 'mgr-1',
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T01:00:00.000Z',
    status: 'running',
    summary: 's',
    request: 'r',
    cwd: '/work/project',
    sessionId: 'sess-1',
    runnerId: 'runner-a',
  };

  function unresumableNotices(inbox: readonly InboxEvent[]): InboxEvent[] {
    return inbox.filter((e) => JSON.stringify(e).includes('戻せなかった'));
  }

  it('restore(): resume が 400 で失敗しても、その間に止めた台帳を lost で上書きせず、戻せなかった知らせも出さない', async () => {
    const stores = createMemoryStores();
    await stores.jobs.putJob(job);
    const { registry, gate } = setup();
    const inbox: InboxEvent[] = [];
    const pool = createManagerPool({
      stores,
      post: (e) => inbox.push(e),
      runners: registry,
      synthesizedNoticeWindowMs: 20,
    });
    const restoring = pool.restore();
    await gate.entered;
    const aborted = await pool.abort('mgr-1', '人間が止めた');
    expect(aborted.outcome).toBe('stopped');
    gate.release();
    await restoring;
    // 見送りの枝は `#notifyUnresumable` より前に戻るので、その decision が日誌に在れば、知らせが後から来ることは無い。
    await vi.waitFor(
      async () => {
        const entries = await stores.journal.list({ types: ['decision'] });
        expect(JSON.stringify(entries)).toContain('戻せなかったとして確定するのを見送った');
      },
      { timeout: 5_000 },
    );
    expect((await stores.jobs.getJob('mgr-1'))?.status).toBe('stopped');
    expect(unresumableNotices(inbox)).toEqual([]);
    await pool.stop();
  });

  it('restore(): 対照（止めていない委譲が同じ 400 で戻ったら、今までどおり lost になり知らせが出る）', async () => {
    const stores = createMemoryStores();
    await stores.jobs.putJob(job);
    const { registry, gate } = setup();
    const inbox: InboxEvent[] = [];
    const pool = createManagerPool({
      stores,
      post: (e) => inbox.push(e),
      runners: registry,
      synthesizedNoticeWindowMs: 20,
    });
    const restoring = pool.restore();
    await gate.entered;
    gate.release();
    await restoring;
    expect((await stores.jobs.getJob('mgr-1'))?.status).toBe('lost');
    await vi.waitFor(() => expect(unresumableNotices(inbox)).toHaveLength(1), { timeout: 5_000 });
    await pool.stop();
  });

  it('reattachRunner(): 対照（confirmLost が止めた後は動かさない）', async () => {
    const stores = createMemoryStores();
    await stores.jobs.putJob(job);
    const { registry, gate } = setup();
    const pool = createManagerPool({ stores, post: () => {}, runners: registry });
    const reattach = pool.reattachRunner('runner-a');
    await gate.entered;
    const aborted = await pool.abort('mgr-1', '人間が止めた');
    expect(aborted.outcome).toBe('stopped');
    gate.release();
    await reattach;
    expect((await stores.jobs.getJob('mgr-1'))?.status).toBe('stopped');
  });
});
