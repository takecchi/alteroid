import { describe, expect, it } from 'vitest';

import { LEASE_DRAIN_MS, LEASE_MARGIN_MS } from './lease.js';
import { createManagerPool, type ManagerPool } from './manager.js';
import { createProfileService } from './profile-service.js';
import {
  createRunnerRegistry,
  RunnerHttpError,
  type RunnerAnswerOutcome,
  type RunnerClient,
  type RunnerCredentialFingerprint,
  type RunnerEvent,
  type RunnerManagerState,
  type RunnerProfileFingerprint,
  type RunnerProfileResult,
  type RunnerRegistry,
  type RunnerResumeCommand,
} from './runner-protocol.js';
import type { InboxEvent, Job, JobLease, JournalEntry } from './schema.js';
import type { Stores } from './store.js';
import { createMemoryStores } from './testing.js';

// ハートビートを待って `instanceId` を変える形にはしない: 台帳の貸し出しが古いプロセスを指していて、
// いま応えているのが別のプロセスという状態そのものが判定の入力なので、そこを直に作る
// （`identity()` が最初から `boot-2` を名乗り、台帳の貸し出しは `boot-1` を持つ）。
class LeasedRunner implements RunnerClient {
  readonly runnerId: string;
  readonly runnerIdKnown = true;
  readonly workspacePathKnown = true;
  readonly workspacePath = '/work/project';
  readonly sessions = new Map<string, RunnerManagerState>();
  readonly resumes: RunnerResumeCommand[] = [];
  readonly stops: string[] = [];
  instanceId: string | undefined = 'boot-2';
  resumeFailure: unknown;
  sendFailure: unknown;
  setProfileCalled = 0;
  listCalled = 0;
  identityCalled = 0;

  constructor(runnerId = 'runner-primary') {
    this.runnerId = runnerId;
  }

  async identity(): Promise<{ runnerId?: string; instanceId?: string } | undefined> {
    this.identityCalled += 1;
    return {
      runnerId: this.runnerId,
      ...(this.instanceId === undefined ? {} : { instanceId: this.instanceId }),
    };
  }

  hold(managerId: string): void {
    this.sessions.set(managerId, {
      managerId,
      status: 'running',
      cwd: this.workspacePath,
      request: `${managerId} の依頼`,
      waiting: [],
      sessionId: `sess-${managerId}`,
    });
  }

  emit: ((event: RunnerEvent) => void) | undefined;

  async connect(onEvent: (event: RunnerEvent) => void): Promise<void> {
    this.emit = onEvent;
  }
  async start(): Promise<{ cwd?: string }> {
    return {};
  }
  async resume(command: RunnerResumeCommand): Promise<{ cwd?: string }> {
    if (this.resumeFailure !== undefined) throw this.resumeFailure;
    this.resumes.push(command);
    this.hold(command.managerId);
    return {};
  }
  async send(): Promise<boolean> {
    if (this.sendFailure !== undefined) throw this.sendFailure;
    return true;
  }
  async answer(): Promise<RunnerAnswerOutcome> {
    return { delivered: false };
  }
  async stop(managerId: string): Promise<void> {
    this.stops.push(managerId);
    this.sessions.delete(managerId);
  }
  async list(): Promise<RunnerManagerState[]> {
    this.listCalled += 1;
    return [...this.sessions.values()];
  }
  async transcript(): Promise<string | null> {
    return null;
  }
  async credentials(): Promise<RunnerCredentialFingerprint[]> {
    return [];
  }
  async setCredentials(): Promise<RunnerCredentialFingerprint[]> {
    return [];
  }
  async profile(): Promise<RunnerProfileFingerprint | undefined> {
    return undefined;
  }
  async setProfile(): Promise<RunnerProfileResult> {
    this.setProfileCalled += 1;
    return { ok: true };
  }
  async close(): Promise<void> {}
}

interface Harness {
  pool: ManagerPool;
  registry: RunnerRegistry;
  stores: Stores;
  runner: LeasedRunner;
  advance: (ms: number) => void;
  breakWrites: (reason: string) => void;
  breakSessionLog: (reason: string) => void;
  healSessionLog: () => void;
  inbox: InboxEvent[];
  journal: () => Promise<JournalEntry[]>;
  close: () => Promise<void>;
}

async function harnessOf(options: { silent?: boolean } = {}): Promise<Harness> {
  const runner = new LeasedRunner();
  // 名乗らせないなら登録の前に決める: 名簿は開けた瞬間に名乗りを聞くので、後から消しても最後に名乗った値が残る。
  if (options.silent === true) runner.instanceId = undefined;
  const registry = createRunnerRegistry();
  await registry.register({ label: 'http://runner:4518', open: async () => runner });
  const base = createMemoryStores();
  // `failingJobWrite` は最初から壊れていて、委譲を台帳に置いてから壊す形を作れないので使わない。
  let writeFailure: string | undefined;
  let sessionLogFailure: string | undefined;
  const stores: Stores = {
    ...base,
    jobs: {
      ...base.jobs,
      putJob: async (job) => {
        if (writeFailure !== undefined) throw new Error(writeFailure);
        await base.jobs.putJob(job);
      },
    },
    sessionStore: {
      append: async () => undefined,
      load: async () => {
        if (sessionLogFailure !== undefined) throw new Error(sessionLogFailure);
        return null;
      },
    },
  };
  let clock = Date.now();
  const inbox: InboxEvent[] = [];
  const pool = createManagerPool({
    stores,
    post: (event) => inbox.push(event),
    runners: registry,
    profile: createProfileService({ stores, runners: registry }),
    now: () => clock,
  });
  return {
    pool,
    registry,
    stores,
    runner,
    advance: (ms) => {
      clock += ms;
    },
    breakWrites: (reason) => {
      writeFailure = reason;
    },
    breakSessionLog: (reason) => {
      sessionLogFailure = reason;
    },
    healSessionLog: () => {
      sessionLogFailure = undefined;
    },
    inbox,
    journal: async () => base.journal.list({ limit: 100 }),
    close: async () => {
      await pool.stop();
      await registry.stop();
    },
  };
}

function runningJob(lease: JobLease | undefined): Job {
  const at = new Date(Date.now() - 1_000).toISOString();
  return {
    id: 'mgr-1',
    managerId: 'mgr-1',
    createdAt: at,
    updatedAt: at,
    status: 'running',
    summary: '走っていた仕事',
    request: '走っていた仕事の依頼',
    cwd: '/work/project',
    sessionId: 'sess-1',
    runnerId: 'runner-primary',
    ...(lease === undefined ? {} : { lease }),
  };
}

function leaseHeldBy(
  instanceId: string | undefined,
  fence = 4,
  overrides: Partial<JobLease> = {},
): JobLease {
  return {
    runnerId: 'runner-primary',
    ...(instanceId === undefined ? {} : { instanceId }),
    fence,
    grantedAt: new Date(Date.now() - 2_000).toISOString(),
    seenAt: new Date(Date.now() - 1_000).toISOString(),
    ttlMs: 10 * 60_000,
    ...overrides,
  };
}

async function jobOf(stores: Stores): Promise<Job | undefined> {
  return (await stores.jobs.listJobs()).find((job) => job.id === 'mgr-1');
}

describe('引き取りの関門（貸し出し期限）', () => {
  it('入れ替え直後は resume を1本も出さない（猶予の中では奪わない）', async () => {
    const h = await harnessOf();
    await h.stores.jobs.putJob(runningJob(leaseHeldBy('boot-1')));

    const restored = await h.pool.restore();

    expect(h.runner.resumes).toEqual([]);
    expect(restored).toEqual([]);
    expect((await jobOf(h.stores))?.lease).toMatchObject({ instanceId: 'boot-1', fence: 4 });
    const decided = (await h.journal()).filter((entry) => entry.type === 'decision');
    expect(decided.map((entry) => entry.decision).join('\n')).toContain('引き取りを見送った');

    await h.close();
  });

  it('畳む猶予を過ぎたら引き取り、世代を1つ進めて runner へ渡す', async () => {
    const h = await harnessOf();
    await h.stores.jobs.putJob(runningJob(leaseHeldBy('boot-1')));

    h.advance(LEASE_DRAIN_MS + LEASE_MARGIN_MS + 1_000);
    const restored = await h.pool.restore();

    expect(restored.map((manager) => manager.managerId)).toEqual(['mgr-1']);
    expect(h.runner.resumes).toHaveLength(1);
    expect(h.runner.resumes[0]?.lease).toEqual({ fence: 5, ttlMs: 10 * 60_000 });
    expect((await jobOf(h.stores))?.lease).toMatchObject({ instanceId: 'boot-2', fence: 5 });

    await h.close();
  });

  it('持ち主が同じプロセスなら、世代を進めずに戻す', async () => {
    const h = await harnessOf();
    await h.stores.jobs.putJob(runningJob(leaseHeldBy('boot-2', 7)));

    await h.pool.restore();

    expect(h.runner.resumes).toHaveLength(1);
    expect(h.runner.resumes[0]?.lease).toEqual({ fence: 7, ttlMs: 10 * 60_000 });
    expect((await jobOf(h.stores))?.lease).toMatchObject({ instanceId: 'boot-2', fence: 7 });

    await h.close();
  });

  it('貸し出しの記録が無いジョブは、今までどおり引き取る', async () => {
    const h = await harnessOf();
    await h.stores.jobs.putJob(runningJob(undefined));

    await h.pool.restore();

    expect(h.runner.resumes).toHaveLength(1);
    expect((await jobOf(h.stores))?.lease).toMatchObject({ fence: 1, instanceId: 'boot-2' });

    await h.close();
  });

  it('名乗っていなかった貸し出しでも、貸す前から居るプロセスなら繋ぎ直しとして扱う', async () => {
    const h = await harnessOf();
    const grantedAt = new Date(Date.now() + 1_000).toISOString();
    await h.stores.jobs.putJob(
      runningJob(leaseHeldBy(undefined, 2, { grantedAt, seenAt: grantedAt })),
    );

    await h.pool.restore();

    expect(h.runner.resumes).toHaveLength(1);
    expect(h.runner.resumes[0]?.lease).toMatchObject({ fence: 2 });

    await h.close();
  });

  it('名乗っていなかった貸し出しで、貸した後に現れたプロセスなら入れ替えとして猶予を待つ', async () => {
    const h = await harnessOf();
    await h.stores.jobs.putJob(runningJob(leaseHeldBy(undefined, 2)));

    await h.pool.restore();
    expect(h.runner.resumes).toEqual([]);

    h.advance(LEASE_DRAIN_MS + LEASE_MARGIN_MS + 1_000);
    await h.pool.reattachRunner('runner-primary');
    expect(h.runner.resumes).toHaveLength(1);
    expect((await jobOf(h.stores))?.lease).toMatchObject({ fence: 3, instanceId: 'boot-2' });

    await h.close();
  });

  it('いま応えている側が名乗らないときは判定しない（それでも引き取る）', async () => {
    const h = await harnessOf({ silent: true });
    await h.stores.jobs.putJob(runningJob(leaseHeldBy('boot-1', 2)));

    await h.pool.restore();

    expect(h.runner.resumes).toHaveLength(1);
    expect((await jobOf(h.stores))?.lease).toMatchObject({ fence: 3 });

    await h.close();
  });

  // 奪う操作だけは台帳へ書けたことを条件にする: 貸し出しが台帳に載らないまま走らせると、次の引き取りが
  // 「誰も握っていない」と読んで同じ委譲を無条件に奪える。台帳が書けなくても委譲を続ける既存の判断（`#persist`）は、奪う操作には広げない。
  it('貸し出しを台帳へ書けないときは引き取らない', async () => {
    const h = await harnessOf();
    await h.stores.jobs.putJob(runningJob(leaseHeldBy('boot-1')));
    h.advance(LEASE_DRAIN_MS + LEASE_MARGIN_MS + 1_000);
    h.breakWrites('ディスクが埋まっている');

    await h.pool.restore();

    expect(h.runner.resumes).toEqual([]);
    expect((await jobOf(h.stores))?.lease).toMatchObject({ instanceId: 'boot-1', fence: 4 });
    // 台帳（`jobOf`）だけで見ると、putJob が投げる以上いつも前の値で、巻き戻しの実装を削っても緑になる。像は `list()` で見る。
    const summary = (await h.pool.list()).find((manager) => manager.managerId === 'mgr-1');
    expect(summary?.lease).toMatchObject({ instanceId: 'boot-1', fence: 4 });

    await h.close();
  });

  it('貸し出しを書けなかった理由の日誌に、例外の2行目（params）の値は出ない', async () => {
    const h = await harnessOf();
    await h.stores.jobs.putJob(runningJob(leaseHeldBy('boot-1')));
    h.advance(LEASE_DRAIN_MS + LEASE_MARGIN_MS + 1_000);
    h.breakWrites('Failed query: update "jobs" set "lease" = $1\nparams: FAKE_SECRET_VALUE_2483');

    await h.pool.restore();

    const decided = (await h.journal()).filter((entry) => entry.type === 'decision');
    const text = JSON.stringify(decided);
    expect(text).toContain('貸し出しを台帳へ書けなかったので引き取らない');
    expect(text).toContain('Failed query');
    expect(text).not.toContain('FAKE_SECRET_VALUE_2483');

    await h.close();
  });

  it('manager_send は「まだ前の器が握っている」と言い、起こし直すなと明示する', async () => {
    const h = await harnessOf();
    await h.stores.jobs.putJob(runningJob(leaseHeldBy('boot-1')));

    const held = await h.pool.send('mgr-1', '続けて');

    expect(held.outcome).toBe('unknown');
    expect(held.detail).toContain('前の器が握っている');
    expect(held.detail).toContain('新しく起こし直さないこと');
    expect(h.runner.resumes).toEqual([]);

    h.advance(LEASE_DRAIN_MS + LEASE_MARGIN_MS + 1_000);
    const delivered = await h.pool.send('mgr-1', '続けて');
    expect(delivered.outcome).toBe('delivered');
    expect(h.runner.resumes).toHaveLength(1);

    await h.close();
  });

  it('取り直しの経路でも、待っていることを日誌に残す（遷移のときだけ）', async () => {
    const h = await harnessOf();
    await h.stores.jobs.putJob(runningJob(leaseHeldBy('boot-1')));

    // 受け口を確かめずに `emit?.()` を書くと、受け口が無いときにテストが黙って何もせず緑になる。
    await h.pool.list();
    expect(h.runner.emit).toBeTypeOf('function');

    h.runner.emit?.({ type: 'hello', runnerId: 'runner-primary' });
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(h.runner.resumes).toEqual([]);
    const decisions = (await h.journal()).filter((entry) => entry.type === 'decision');
    expect(decisions).toHaveLength(1);
    expect(decisions[0]?.type === 'decision' && decisions[0].decision).toContain(
      '引き取りを見送った',
    );

    h.runner.emit?.({ type: 'hello', runnerId: 'runner-primary' });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect((await h.journal()).filter((entry) => entry.type === 'decision')).toHaveLength(1);

    await h.close();
  });

  it('併存していない通常の取り直しでは、pushProfile と list を今までどおり呼ぶ（対照）', async () => {
    const h = await harnessOf();
    await h.stores.profile.set('default', 'export SOME_TOKEN=abc', 'all');
    await h.stores.jobs.putJob(runningJob(leaseHeldBy('boot-1')));

    await h.pool.list();
    expect(h.runner.emit).toBeTypeOf('function');
    h.runner.setProfileCalled = 0;
    h.runner.listCalled = 0;

    h.runner.emit?.({ type: 'hello', runnerId: 'runner-primary' });
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(h.runner.setProfileCalled).toBeGreaterThan(0);
    expect(h.runner.listCalled).toBeGreaterThan(0);

    await h.close();
  });

  // 世代で拒まれた（409）を「戻せなかった」と同じ扱いにしない: 409 は自分より新しい世代の誰かが握っている（セッションは生きている）ときで、
  // lost にして像から外すと、「戻せなかった」と読んだクローンが起こし直し、fencing の失敗経路から二重実行へ到達する。
  it('世代で拒まれたら、台帳を lost にせず「起こし直すな」と知らせる', async () => {
    const h = await harnessOf();
    await h.stores.jobs.putJob(runningJob(leaseHeldBy('boot-2', 3)));
    h.runner.resumeFailure = new RunnerHttpError('resume が世代で拒まれた', 409);

    await h.pool.reattachRunner('runner-primary');

    const summary = (await h.pool.list()).find((manager) => manager.managerId === 'mgr-1');
    expect(summary?.status).toBe('running');
    expect((await jobOf(h.stores))?.status).toBe('running');
    const told = h.inbox
      .map((event) => (event.type === 'manager_message' ? event.text : ''))
      .join('\n');
    expect(told).toContain('新しく起こし直さないでください');
    expect(told).not.toContain('戻せなかった');
    const decided = (await h.journal()).filter((entry) => entry.type === 'decision');
    expect(
      decided.map((entry) => (entry.type === 'decision' ? entry.decision : '')).join('\n'),
    ).toContain('取り直しを止めた');

    await h.close();
  });

  // 自己失効は「終わった」ではない: `event.status`（`lost`）をそのまま台帳へ書くと `#restoreJobs` も `#reattach` も見送り、
  // 二重実行を止めた代わりに誰も拾わない仕事ができる。
  it('自己失効の closed では状態を動かさず、貸し出しだけ返して引き取り直せる', async () => {
    const h = await harnessOf();
    await h.stores.jobs.putJob(runningJob(leaseHeldBy('boot-2', 3)));
    h.runner.hold('mgr-1');
    await h.pool.restore();
    expect(h.runner.resumes).toEqual([]);

    h.runner.emit?.({
      type: 'closed',
      managerId: 'mgr-1',
      status: 'lost',
      reason: 'デーモンと連絡が取れないので貸し出し期限が切れた（自己失効）。',
      selfFenced: true,
    });
    await new Promise((resolve) => setImmediate(resolve));

    const after = await jobOf(h.stores);
    expect(after?.status).toBe('running');
    // 貸し出しは消さずに印を立てる: 消すと世代（fence）まで消え、返却の知らせが遅れて届いたとき runner が覚えている世代より小さい世代を渡してしまう。
    expect(after?.lease?.releasedAt).toEqual(expect.any(String));
    expect(after?.lease?.fence).toBe(3);
    const told = (await h.journal()).map((entry) =>
      entry.type === 'exchange' ? entry.text : entry.type,
    );
    expect(told.join('\n')).toContain('自己失効');

    // `restore()` は既に像を持っている委譲を見送るので、引き取り直しは取り直し（`hello`）の経路で確かめる。
    h.runner.sessions.delete('mgr-1');
    h.runner.emit?.({ type: 'hello', runnerId: 'runner-primary' });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(h.runner.resumes).toHaveLength(1);

    await h.close();
  });

  it('止まったと確かめた委譲は貸し出しを返す（次の引き取りが猶予を待たない）', async () => {
    const h = await harnessOf();
    await h.stores.jobs.putJob(runningJob(leaseHeldBy('boot-2', 9)));
    h.runner.hold('mgr-1');
    await h.pool.restore();

    const result = await h.pool.abort('mgr-1', '確かめるため', 'clone');
    expect(result.outcome).toBe('stopped');
    const stopped = (await jobOf(h.stores))?.lease;
    expect(stopped?.releasedAt).toEqual(expect.any(String));
    expect(stopped?.fence).toBe(9);

    await h.close();
  });

  describe('併存（同じ runnerId を名乗る器が2台以上。#200）', () => {
    async function withDuplicate(h: Harness): Promise<LeasedRunner> {
      const duplicate = new LeasedRunner('runner-primary');
      await h.registry.register({ label: 'http://runner-dup:4518', open: async () => duplicate });
      return duplicate;
    }

    it('併存では resume を1本も出さない', async () => {
      const h = await harnessOf();
      const duplicate = await withDuplicate(h);
      await h.stores.jobs.putJob(runningJob(leaseHeldBy('boot-1')));

      const restored = await h.pool.restore();

      expect(restored).toEqual([]);
      expect(h.runner.resumes).toEqual([]);
      expect(duplicate.resumes).toEqual([]);
      expect((await jobOf(h.stores))?.lease).toMatchObject({ instanceId: 'boot-1', fence: 4 });

      await h.close();
    });

    it('unheld（貸し出しの記録が無い）は併存でも従来どおり引き取る（残る穴）', async () => {
      const h = await harnessOf();
      await withDuplicate(h);
      await h.stores.jobs.putJob(runningJob(undefined));

      await h.pool.restore();

      expect(h.runner.resumes).toHaveLength(1);

      await h.close();
    });

    it('日誌に残る根拠が「時間では解けない」と分かる形である（held の言い方とは違う）', async () => {
      const h = await harnessOf();
      await withDuplicate(h);
      await h.stores.jobs.putJob(runningJob(leaseHeldBy('boot-1')));

      await h.pool.restore();

      const decided = (await h.journal()).filter((entry) => entry.type === 'decision');
      const text = decided
        .map((entry) => (entry.type === 'decision' ? `${entry.decision}\n${entry.grounds}` : ''))
        .join('\n');
      expect(text).toContain('引き取りを見送った');
      expect(text).toContain('時間では解けない');
      expect(text).toContain('2 台');
      expect(text).not.toContain('期限が切れたら自動で挑み直す');

      await h.close();
    });

    it('manager_send の応答が「起こし直すな」と、何をすれば解けるかを言う', async () => {
      const h = await harnessOf();
      await withDuplicate(h);
      await h.stores.jobs.putJob(runningJob(leaseHeldBy('boot-1')));

      const result = await h.pool.send('mgr-1', '続けて');

      expect(result.outcome).toBe('unknown');
      expect(result.detail).toContain('新しく起こし直さないこと');
      expect(result.detail).toContain('時間では解けない');
      expect(result.detail).not.toContain('期限が切れれば自動で引き取る');
      expect(result.detail).toContain('ALTEROID_RUNNER_ID');

      await h.close();
    });

    it('併存下では #pushProfile も runner.list() も、名寄せで解決したどちらの相手へも走らない', async () => {
      const h = await harnessOf();
      const duplicate = await withDuplicate(h);
      await h.stores.profile.set('default', 'export SOME_TOKEN=abc', 'all');
      await h.stores.jobs.putJob(runningJob(leaseHeldBy('boot-1')));

      await h.pool.list();
      expect(h.runner.emit).toBeTypeOf('function');
      h.runner.setProfileCalled = 0;
      duplicate.setProfileCalled = 0;
      h.runner.listCalled = 0;
      duplicate.listCalled = 0;

      h.runner.emit?.({ type: 'hello', runnerId: 'runner-primary' });
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(h.runner.setProfileCalled).toBe(0);
      expect(duplicate.setProfileCalled).toBe(0);
      expect(h.runner.listCalled).toBe(0);
      expect(duplicate.listCalled).toBe(0);
      expect(h.runner.resumes).toEqual([]);
      expect(duplicate.resumes).toEqual([]);

      await h.close();
    });

    it('併存の合図は2回目の #reattach（hello）でも出る（初回だけで終わらない）', async () => {
      const h = await harnessOf();
      await withDuplicate(h);
      await h.stores.jobs.putJob(runningJob(leaseHeldBy('boot-1')));

      await h.pool.list();
      expect(h.runner.emit).toBeTypeOf('function');

      h.runner.emit?.({ type: 'hello', runnerId: 'runner-primary' });
      await new Promise((resolve) => setTimeout(resolve, 10));
      const first = (await h.journal()).filter((entry) => entry.type === 'decision');
      expect(first).toHaveLength(1);
      const firstText = first
        .map((entry) => (entry.type === 'decision' ? `${entry.decision}\n${entry.grounds}` : ''))
        .join('\n');
      expect(firstText).toContain('時間では解けない');
      expect(firstText).toContain('直し方: 器ごとに違う ALTEROID_RUNNER_ID');

      // 併存の合図は `hello` のたびに繰り返し出す: 初回だけ言う（edge-triggered）にすると、
      // 人間がその1回を見逃した後・デーモンを再起動した後は永久に見えなくなる（併存は時間では解けない）。
      h.runner.emit?.({ type: 'hello', runnerId: 'runner-primary' });
      await new Promise((resolve) => setTimeout(resolve, 10));
      const second = (await h.journal()).filter((entry) => entry.type === 'decision');
      expect(second).toHaveLength(2);

      expect(h.runner.resumes).toEqual([]);

      await h.close();
    });

    it('併存では受信箱へ知らせ、answering 側の runnerId を使う（lease.runnerId ではない）', async () => {
      const h = await harnessOf();
      await withDuplicate(h);
      // 台帳の貸し出しはわざと別の runnerId を指させる（食い違いを作る）: `lease.runnerId` を出すと、重複していない方の名前を報告してしまう。
      await h.stores.jobs.putJob(
        runningJob(leaseHeldBy('boot-1', 4, { runnerId: 'stale-runner-name' })),
      );

      await h.pool.restore();

      const reports = h.inbox.filter(
        (event): event is Extract<InboxEvent, { type: 'manager_message' }> =>
          event.type === 'manager_message',
      );
      expect(reports).toHaveLength(1);
      expect(reports[0]?.managerId).toBe('mgr-1');
      expect(reports[0]?.text).toContain('runnerId=runner-primary');
      expect(reports[0]?.text).not.toContain('stale-runner-name');
      expect(reports[0]?.text).toContain('2 台');
      expect(reports[0]?.text).toContain('新しく起こし直さないこと');
      expect(reports[0]?.text).toContain('ALTEROID_RUNNER_ID');

      await h.close();
    });

    it('held（時間で解ける）では受信箱へ出さない（併存だけの扱いである）', async () => {
      const h = await harnessOf();
      await h.stores.jobs.putJob(runningJob(leaseHeldBy('boot-1')));

      await h.pool.restore();

      expect(h.inbox.filter((event) => event.type === 'manager_message')).toEqual([]);

      await h.close();
    });

    it('併存が解けたら「解けた」を受信箱へ知らせる（入りと出、それぞれ1回ずつ）', async () => {
      const h = await harnessOf();
      await withDuplicate(h);
      await h.stores.jobs.putJob(runningJob(leaseHeldBy('boot-1')));

      await h.pool.list();
      expect(h.runner.emit).toBeTypeOf('function');

      h.runner.emit?.({ type: 'hello', runnerId: 'runner-primary' });
      await new Promise((resolve) => setTimeout(resolve, 10));
      let reports = h.inbox.filter((event) => event.type === 'manager_message');
      expect(reports).toHaveLength(1);

      h.runner.emit?.({ type: 'hello', runnerId: 'runner-primary' });
      await new Promise((resolve) => setTimeout(resolve, 10));
      reports = h.inbox.filter((event) => event.type === 'manager_message');
      expect(reports).toHaveLength(1);

      await h.registry.unregister('http://runner-dup:4518');
      h.runner.emit?.({ type: 'hello', runnerId: 'runner-primary' });
      await new Promise((resolve) => setTimeout(resolve, 10));
      reports = h.inbox.filter(
        (event): event is Extract<InboxEvent, { type: 'manager_message' }> =>
          event.type === 'manager_message',
      );
      expect(reports).toHaveLength(2);
      expect(reports[1]?.text).toContain('解けました');

      h.runner.emit?.({ type: 'hello', runnerId: 'runner-primary' });
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(h.inbox.filter((event) => event.type === 'manager_message')).toHaveLength(2);

      await h.close();
    });

    describe('台帳の書き込みが落ちただけのとき（併存ではない。測った事実3）', () => {
      it('日誌の言い方を併存と混ぜない', async () => {
        const h = await harnessOf();
        await h.stores.jobs.putJob(runningJob(leaseHeldBy('boot-1')));
        h.advance(LEASE_DRAIN_MS + LEASE_MARGIN_MS + 1_000);
        h.breakWrites('ディスクが埋まっている');

        await h.pool.restore();

        const decided = (await h.journal()).filter((entry) => entry.type === 'decision');
        const text = decided
          .map((entry) => (entry.type === 'decision' ? entry.decision : ''))
          .join('\n');
        expect(text).toContain('引き取りを見送った');
        expect(text).toContain('ALTEROID_RUNNER_ID の問題ではない');
        expect(text).not.toContain('人間が ALTEROID_RUNNER_ID 等を直すまで解けない');
        expect(text).not.toContain('時間では解けない（人間が');
        expect(text).toContain('台帳の書き込みが一時的に失敗しただけ');

        expect(h.inbox.filter((event) => event.type === 'manager_message')).toEqual([]);

        await h.close();
      });

      it('manager_send の応答でも ALTEROID_RUNNER_ID を名指ししない', async () => {
        const h = await harnessOf();
        await h.stores.jobs.putJob(runningJob(leaseHeldBy('boot-1')));
        h.advance(LEASE_DRAIN_MS + LEASE_MARGIN_MS + 1_000);
        h.breakWrites('ディスクが埋まっている');

        const result = await h.pool.send('mgr-1', '続けて');

        expect(result.outcome).toBe('unknown');
        expect(result.detail).toContain('新しく起こし直さないこと');
        expect(result.detail).toContain('ALTEROID_RUNNER_ID の問題ではない');
        expect(result.detail).not.toContain('人間が ALTEROID_RUNNER_ID 等を直すまで解けない');
        expect(result.detail).not.toContain('時間では解けない（人間が');
        expect(result.detail).toContain('台帳の書き込みが一時的に失敗しただけ');

        await h.close();
      });
    });
  });
});

function doneJob(lease: JobLease | undefined, overrides: Partial<Job> = {}): Job {
  // `sessionInstanceId` は既定で貸し出しの持ち主と同じ値にする: 実機では `start()` と `#resume()` の成功が、その回に claim した相手を両方の欄へ同じ値で書く。
  // 食い違わせたい試験は `overrides` で明示すること。
  const sessionInstanceId = lease?.instanceId;
  return {
    ...runningJob(lease),
    status: 'done',
    ...(sessionInstanceId === undefined ? {} : { sessionInstanceId }),
    ...overrides,
  };
}

function leaseReleasedBy(instanceId: string | undefined, fence = 4): JobLease {
  return leaseHeldBy(instanceId, fence, {
    releasedAt: new Date(Date.now() - 500).toISOString(),
  });
}

describe('器が入れ替わった後の manager_send（#669）', () => {
  it('done の委譲へ、器が入れ替わった後に送ると、入れ替えを告げる行が人間の言葉の前に付く', async () => {
    const h = await harnessOf();
    await h.stores.jobs.putJob(doneJob(leaseReleasedBy('boot-1')));

    const result = await h.pool.send('mgr-1', '続きをやって');

    expect(result.outcome).toBe('delivered');
    expect(h.runner.resumes).toHaveLength(1);
    const message = h.runner.resumes[0]?.message ?? '';
    expect(message).toContain('[system]');
    expect(message).toContain('手元の状態を確かめよ');
    expect(message).toContain('続きをやって');
    expect(message.indexOf('[system]')).toBeLessThan(message.indexOf('続きをやって'));

    await h.close();
  });

  it('作業ディレクトリの言い方は locator から引く（判定を二重に持たない）', async () => {
    const h = await harnessOf();
    await h.stores.jobs.putJob(
      doneJob(leaseReleasedBy('boot-1'), {
        workspace: { kind: 'git', repository: 'takecchi/alteroid', ref: 'main' },
      }),
    );

    await h.pool.send('mgr-1', '続きをやって');

    const message = h.runner.resumes[0]?.message ?? '';
    expect(message).toContain('takecchi/alteroid の main');
    expect(message).toContain('clone し直してから');
    expect(message).not.toContain('残っているとは限らない');

    await h.close();
  });

  it('器が入れ替わっていなければ、その行は付かない（人間の言葉だけが渡る）', async () => {
    const h = await harnessOf();
    await h.stores.jobs.putJob(doneJob(leaseReleasedBy('boot-2')));

    await h.pool.send('mgr-1', '続きをやって');

    expect(h.runner.resumes).toHaveLength(1);
    expect(h.runner.resumes[0]?.message).toBe('続きをやって');

    await h.close();
  });

  describe('判定できないときは告げない', () => {
    it('セッションが載った器も貸し出しの持ち主も、記録が無いとき', async () => {
      const h = await harnessOf();
      await h.stores.jobs.putJob(doneJob(leaseReleasedBy(undefined)));

      await h.pool.send('mgr-1', '続きをやって');

      expect(h.runner.resumes).toHaveLength(1);
      expect(h.runner.resumes[0]?.message).toBe('続きをやって');

      await h.close();
    });

    it('いま応えている側が名乗らないとき', async () => {
      const h = await harnessOf({ silent: true });
      await h.stores.jobs.putJob(doneJob(leaseReleasedBy('boot-1')));

      await h.pool.send('mgr-1', '続きをやって');

      expect(h.runner.resumes).toHaveLength(1);
      expect(h.runner.resumes[0]?.message).toBe('続きをやって');

      await h.close();
    });

    it('同じ runnerId を名乗る器が2台あるとき', async () => {
      const h = await harnessOf();
      const duplicate = new LeasedRunner('runner-primary');
      await h.registry.register({ label: 'http://runner-dup:4518', open: async () => duplicate });
      await h.stores.jobs.putJob(doneJob(leaseReleasedBy('boot-1')));

      await h.pool.send('mgr-1', '続きをやって');

      const messages = [...h.runner.resumes, ...duplicate.resumes].map(
        (command) => command.message,
      );
      expect(messages).toEqual(['続きをやって']);

      await h.close();
    });
  });

  it('同じ委譲へ2回目を送っても、同じ1行は付かない（貸し直しで持ち主が追いつく）', async () => {
    const h = await harnessOf();
    await h.stores.jobs.putJob(doneJob(leaseReleasedBy('boot-1')));

    await h.pool.send('mgr-1', '続きをやって');
    expect(h.runner.resumes[0]?.message).toContain('[system]');
    expect((await jobOf(h.stores))?.lease).toMatchObject({ instanceId: 'boot-2' });

    // 2回目も resume から入り直させる: resume を通らなかっただけで付かなかった、という形では判定を測れない。
    h.runner.sendFailure = new RunnerHttpError('そのセッションは無い', 404);
    const second = await h.pool.send('mgr-1', 'もう一言');

    expect(second.outcome).toBe('delivered');
    expect(h.runner.resumes).toHaveLength(2);
    expect(h.runner.resumes[1]?.message).toBe('もう一言');

    await h.close();
  });

  it('running は #reattach が既に告げているので、その後の send で二重に告げない', async () => {
    const h = await harnessOf();
    await h.stores.jobs.putJob(runningJob(leaseHeldBy('boot-1')));

    await h.pool.list();
    expect(h.runner.emit).toBeTypeOf('function');
    h.advance(LEASE_DRAIN_MS + LEASE_MARGIN_MS + 1_000);
    h.runner.emit?.({ type: 'hello', runnerId: 'runner-primary' });
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(h.runner.resumes).toHaveLength(1);
    expect(h.runner.resumes[0]?.message).toContain('runner の器が作り直された');

    h.runner.sendFailure = new RunnerHttpError('そのセッションは無い', 404);
    await h.pool.send('mgr-1', '追加の指示');

    expect(h.runner.resumes).toHaveLength(2);
    expect(h.runner.resumes[1]?.message).toBe('追加の指示');

    await h.close();
  });

  describe('関門を通った後に resume が失敗しても、告げる機会を失わない', () => {
    it('生ログが読めなかった回（unreadable）', async () => {
      const h = await harnessOf();
      await h.stores.jobs.putJob(doneJob(leaseReleasedBy('boot-1'), { projectKey: 'proj-key' }));
      h.breakSessionLog('台帳の生ログが一時的に読めない');

      const failed = await h.pool.send('mgr-1', '続きをやって');

      expect(failed.outcome).toBe('unknown');
      expect(h.runner.resumes).toEqual([]);
      expect((await jobOf(h.stores))?.lease).toMatchObject({ instanceId: 'boot-2' });
      expect((await jobOf(h.stores))?.sessionInstanceId).toBe('boot-1');

      h.healSessionLog();
      await h.pool.send('mgr-1', '続きをやって');

      expect(h.runner.resumes).toHaveLength(1);
      expect(h.runner.resumes[0]?.message).toContain('[system]');
      expect(h.runner.resumes[0]?.message).toContain('続きをやって');
      expect((await jobOf(h.stores))?.sessionInstanceId).toBe('boot-2');

      await h.close();
    });

    it('runner.resume が投げた回（ネットワーク）', async () => {
      const h = await harnessOf();
      await h.stores.jobs.putJob(doneJob(leaseReleasedBy('boot-1')));
      h.runner.resumeFailure = new Error('runner が応答しない');

      await expect(h.pool.send('mgr-1', '続きをやって')).rejects.toThrow('runner が応答しない');

      expect(h.runner.resumes).toEqual([]);
      expect((await jobOf(h.stores))?.lease).toMatchObject({ instanceId: 'boot-2' });
      expect((await jobOf(h.stores))?.sessionInstanceId).toBe('boot-1');

      h.runner.resumeFailure = undefined;
      await h.pool.send('mgr-1', '続きをやって');

      expect(h.runner.resumes).toHaveLength(1);
      expect(h.runner.resumes[0]?.message).toContain('[system]');
      expect((await jobOf(h.stores))?.sessionInstanceId).toBe('boot-2');

      await h.close();
    });
  });

  it('start() がセッションの器を台帳へ書く（欄が無ければ最初の入れ替えで告げられない）', async () => {
    const h = await harnessOf();

    const { managerId } = await h.pool.start({ request: '調べて' });

    const job = (await h.stores.jobs.listJobs()).find((entry) => entry.id === managerId);
    expect(job?.sessionInstanceId).toBe('boot-2');
    expect(job?.lease).toMatchObject({ instanceId: 'boot-2' });

    await h.close();
  });

  // 残る穴（失敗した回）は歯にしない: 欠陥を仕様として固定することになる（`#runnerSwappedSinceSession` の doc に逐語で書いてある）。
  it('この欄より前に作られたジョブでは貸し出しへ落ちる（1回は告げ、以後は新しい欄で回る）', async () => {
    const h = await harnessOf();
    const legacy = doneJob(leaseReleasedBy('boot-1'));
    delete legacy.sessionInstanceId;
    expect(legacy.sessionInstanceId).toBeUndefined();
    await h.stores.jobs.putJob(legacy);

    await h.pool.send('mgr-1', '続きをやって');

    expect(h.runner.resumes).toHaveLength(1);
    expect(h.runner.resumes[0]?.message).toContain('[system]');
    expect((await jobOf(h.stores))?.sessionInstanceId).toBe('boot-2');

    await h.close();
  });

  it('入れ替えを告げても、status / live / sessionMissingSince は告げない回と同じ', async () => {
    const swapped = await harnessOf();
    await swapped.stores.jobs.putJob(doneJob(leaseReleasedBy('boot-1')));
    await swapped.pool.send('mgr-1', '続きをやって');

    const same = await harnessOf();
    await same.stores.jobs.putJob(doneJob(leaseReleasedBy('boot-2')));
    await same.pool.send('mgr-1', '続きをやって');

    const view = async (h: Harness) => {
      const summary = (await h.pool.list()).find((manager) => manager.managerId === 'mgr-1');
      return {
        status: summary?.status,
        live: summary?.live,
        sessionMissingSince: summary?.sessionMissingSince,
      };
    };

    expect(swapped.runner.resumes[0]?.message).toContain('[system]');
    expect(same.runner.resumes[0]?.message).toBe('続きをやって');
    // 告げた側と告げなかった側を並べて比べる: 片側だけを見ると、両方が同じだけ壊れた変異を見逃す。
    expect(await view(swapped)).toEqual(await view(same));

    await swapped.close();
    await same.close();
  });

  // 絶対値ではなく差分で見る: 名簿の heartbeat（10秒間隔）も `identity()` を通るので、絶対値はテストが走った長さに依存する。
  it('判定のために新しい往復を1つも足していない', async () => {
    const h = await harnessOf();
    await h.stores.jobs.putJob(doneJob(leaseReleasedBy('boot-1')));
    await h.pool.list();

    const before = {
      identity: h.runner.identityCalled,
      list: h.runner.listCalled,
      setProfile: h.runner.setProfileCalled,
    };
    await h.pool.send('mgr-1', '続きをやって');

    expect({
      identity: h.runner.identityCalled,
      list: h.runner.listCalled,
      setProfile: h.runner.setProfileCalled,
    }).toEqual(before);
    expect(h.runner.resumes).toHaveLength(1);

    await h.close();
  });
});

describe('取り直しは、読めないまま runner に居る委譲を resume しない（#1661）', () => {
  it('猶予を過ぎていても、listWithUnreadable が名乗る委譲は resume しない', async () => {
    const h = await harnessOf();
    await h.stores.jobs.putJob(runningJob(leaseHeldBy('boot-1')));
    h.advance(LEASE_DRAIN_MS + LEASE_MARGIN_MS + 1_000);
    (h.runner as RunnerClient).listWithUnreadable = async () => ({
      states: [],
      unreadableIds: ['mgr-1'],
    });

    await h.pool.reattachRunner('runner-primary');

    expect(h.runner.resumes).toEqual([]);
    await h.close();
  });
});
