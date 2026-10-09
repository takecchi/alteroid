import { describe, expect, it } from 'vitest';

import { createManagerPool, mergeRescue } from './manager.js';
import {
  createRunnerRegistry,
  type RunnerClient,
  type RunnerRescueRefDeleteRequest,
  type RunnerRescueRefDeleteResult,
} from './runner-protocol.js';
import type { Job, RescueWorktree } from './schema.js';
import { describeRescue } from './tools.js';
import { createMemoryStores } from './testing.js';

const DAY = 24 * 60 * 60_000;
let nowMs = Date.parse('2026-10-20T00:00:00.000Z');
const iso = (offset: number): string => new Date(nowMs + offset).toISOString();

const REF = 'refs/alteroid-rescue/mgr-x/root-1234abcd';
const COMMIT = 'a'.repeat(40);
const REMOTE = 'https://github.com/o/r.git';

function pushedOf(extra: Partial<NonNullable<RescueWorktree['pushed']>> = {}) {
  return { ref: REF, commit: COMMIT, at: iso(-30 * DAY), remote: REMOTE, ...extra };
}

function jobOf(
  id: string,
  status: Job['status'],
  quietDays: number,
  worktrees: RescueWorktree[],
  runnerId = 'runner-primary',
  terminalDays = quietDays,
): Job {
  const terminal =
    status === 'done' || status === 'failed' || status === 'stopped'
      ? { terminal: { status, seenAt: iso(-terminalDays * DAY) } }
      : {};
  return {
    id,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: iso(0),
    status,
    summary: '調べ物',
    cwd: '/work/project',
    runnerId,
    lastRescue: { at: iso(-quietDays * DAY), worktrees, ...terminal },
  };
}

function wt(pushed: ReturnType<typeof pushedOf> | undefined, relativePath = '.'): RescueWorktree {
  return { relativePath, branch: 'main', at: iso(-30 * DAY), ...(pushed ? { pushed } : {}) };
}

interface Fake {
  runner: RunnerClient;
  calls: RunnerRescueRefDeleteRequest[];
  next: { result: RunnerRescueRefDeleteResult | 'throw' };
}

function fakeRunner(runnerId = 'runner-primary', withDelete = true): Fake {
  const calls: RunnerRescueRefDeleteRequest[] = [];
  const next: Fake['next'] = { result: { outcome: 'removed', alreadyGone: false } };
  const runner = {
    runnerId,
    runnerIdKnown: true,
    workspacePath: '/work/project',
    workspacePathKnown: true,
    async connect() {
      /* 使わない */
    },
    async list() {
      return [];
    },
    async close() {
      /* 使わない */
    },
    ...(withDelete
      ? {
          async deleteRescueRef(request: RunnerRescueRefDeleteRequest) {
            calls.push(request);
            if (next.result === 'throw') throw new Error('boom');
            return next.result;
          },
        }
      : {}),
  } as unknown as RunnerClient;
  return { runner, calls, next };
}

async function setup(jobs: Job[], runners: Fake[] = [fakeRunner()]) {
  const stores = createMemoryStores();
  for (const job of jobs) await stores.jobs.putJob(job);
  const pool = createManagerPool({
    stores,
    post: () => undefined,
    runners: createRunnerRegistry(runners.map((r) => r.runner)),
    now: () => nowMs,
  });
  const jobOfId = async (id: string) =>
    (await stores.jobs.listJobs()).find((j) => j.id === id) as Job;
  const journal = async () => JSON.stringify(await stores.journal.list({ types: ['decision'] }));
  return { pool, stores, jobOfId, journal };
}

describe('退避 ref の後始末の走査（#1266）', () => {
  it('done が猶予（7日）を過ぎていたら runner に消させ、pushed を残して removal を付け、日誌へ書く', async () => {
    const fake = fakeRunner();
    const { pool, jobOfId, journal } = await setup(
      [jobOf('mgr-x', 'done', 8, [wt(pushedOf())])],
      [fake],
    );
    await pool.sweepRescueRefs?.();
    expect(fake.calls).toEqual([{ remote: REMOTE, ref: REF, commit: COMMIT }]);
    const pushed = (await jobOfId('mgr-x')).lastRescue?.worktrees[0]?.pushed;
    expect(pushed?.ref).toBe(REF);
    expect(pushed?.removal).toEqual({ at: iso(0), reason: 'done' });
    const text = await journal();
    expect(text).toContain(REF);
    expect(text).toContain('猶予');
    await pool.stop();
  });

  it('猶予の手前の done（6日）と、何日放置された lost は消さない', async () => {
    const fake = fakeRunner();
    const { pool, jobOfId } = await setup(
      [
        jobOf('mgr-done', 'done', 6, [wt(pushedOf())]),
        jobOf('mgr-lost', 'lost', 400, [wt(pushedOf())]),
        jobOf('mgr-failed', 'failed', 13, [wt(pushedOf())]),
      ],
      [fake],
    );
    await pool.sweepRescueRefs?.();
    expect(fake.calls).toEqual([]);
    expect((await jobOfId('mgr-lost')).lastRescue?.worktrees[0]?.pushed?.removal).toBeUndefined();
    await pool.stop();
  });

  it('failed / stopped は14日で消す', async () => {
    const fake = fakeRunner();
    const { pool, jobOfId } = await setup(
      [
        jobOf('mgr-f', 'failed', 14, [wt(pushedOf({ ref: `${REF}f` }))]),
        jobOf('mgr-s', 'stopped', 14, [wt(pushedOf({ ref: `${REF}s` }))]),
      ],
      [fake],
    );
    await pool.sweepRescueRefs?.();
    expect(fake.calls.map((c) => c.ref).sort()).toEqual([`${REF}f`, `${REF}s`]);
    expect((await jobOfId('mgr-f')).lastRescue?.worktrees[0]?.pushed?.removal?.reason).toBe(
      'failed',
    );
    expect((await jobOfId('mgr-s')).lastRescue?.worktrees[0]?.pushed?.removal?.reason).toBe(
      'stopped',
    );
    await pool.stop();
  });

  it('内容が origin に入っている（landedAt）なら、lost でも猶予なしで消す', async () => {
    const fake = fakeRunner();
    const { pool, jobOfId } = await setup(
      [jobOf('mgr-l', 'lost', 0, [wt(pushedOf({ landedAt: iso(-1000) }))])],
      [fake],
    );
    await pool.sweepRescueRefs?.();
    expect(fake.calls).toHaveLength(1);
    expect((await jobOfId('mgr-l')).lastRescue?.worktrees[0]?.pushed?.removal?.reason).toBe(
      'landed',
    );
    await pool.stop();
  });

  it('消した記録のあるものは二度撃たない', async () => {
    const fake = fakeRunner();
    const { pool } = await setup(
      [jobOf('mgr-x', 'done', 40, [wt(pushedOf({ removal: { at: iso(-DAY), reason: 'done' } }))])],
      [fake],
    );
    await pool.sweepRescueRefs?.();
    expect(fake.calls).toEqual([]);
    await pool.stop();
  });

  it('消せなかったら分類を残し、間隔を空けて再試行し、日誌は初回だけ。消せたら removed になる', async () => {
    const fake = fakeRunner();
    fake.next.result = { outcome: 'failed', kind: 'auth' };
    const { pool, jobOfId, journal } = await setup(
      [jobOf('mgr-x', 'done', 8, [wt(pushedOf())])],
      [fake],
    );
    await pool.sweepRescueRefs?.();
    expect((await jobOfId('mgr-x')).lastRescue?.worktrees[0]?.pushed?.removal).toEqual({
      at: iso(0),
      reason: 'done',
      failureKind: 'auth',
      attempts: 1,
    });
    nowMs += 5 * 60_000;
    await pool.sweepRescueRefs?.();
    expect(fake.calls).toHaveLength(1);
    nowMs += 20 * 60_000;
    await pool.sweepRescueRefs?.();
    expect(fake.calls).toHaveLength(2);
    expect((await jobOfId('mgr-x')).lastRescue?.worktrees[0]?.pushed?.removal?.attempts).toBe(2);
    expect((await journal()).split('消せなかった').length - 1).toBe(1);
    fake.next.result = { outcome: 'removed', alreadyGone: true };
    nowMs += 3 * 60 * 60_000;
    await pool.sweepRescueRefs?.();
    const removal = (await jobOfId('mgr-x')).lastRescue?.worktrees[0]?.pushed?.removal;
    expect(removal?.failureKind).toBeUndefined();
    expect(removal?.reason).toBe('done');
    await pool.stop();
  });

  it('runner が投げたら other。消したことにしない', async () => {
    const fake = fakeRunner();
    fake.next.result = 'throw';
    const { pool, jobOfId } = await setup([jobOf('mgr-x', 'done', 8, [wt(pushedOf())])], [fake]);
    await pool.sweepRescueRefs?.();
    expect((await jobOfId('mgr-x')).lastRescue?.worktrees[0]?.pushed?.removal?.failureKind).toBe(
      'other',
    );
    await pool.stop();
  });

  it('後始末の口を持つ runner が1台も無ければ no-runner（消したことにしない）', async () => {
    const { pool, jobOfId } = await setup(
      [jobOf('mgr-x', 'done', 8, [wt(pushedOf())])],
      [fakeRunner('runner-primary', false)],
    );
    await pool.sweepRescueRefs?.();
    expect((await jobOfId('mgr-x')).lastRescue?.worktrees[0]?.pushed?.removal).toMatchObject({
      failureKind: 'no-runner',
    });
    await pool.stop();
  });

  it('委譲の runner が名簿に居なくても、別の開いている runner で消す（器の入れ替わり）', async () => {
    const other = fakeRunner('runner-other');
    const { pool } = await setup(
      [jobOf('mgr-x', 'done', 8, [wt(pushedOf())], 'runner-gone')],
      [other],
    );
    await pool.sweepRescueRefs?.();
    expect(other.calls).toHaveLength(1);
    await pool.stop();
  });

  it('送り先（remote）が台帳に無ければ撃たず no-remote', async () => {
    const fake = fakeRunner();
    const noRemote = { ...pushedOf() } as Partial<ReturnType<typeof pushedOf>>;
    delete noRemote.remote;
    const { pool, jobOfId } = await setup(
      [jobOf('mgr-x', 'done', 8, [wt(noRemote as ReturnType<typeof pushedOf>)])],
      [fake],
    );
    await pool.sweepRescueRefs?.();
    expect(fake.calls).toEqual([]);
    expect((await jobOfId('mgr-x')).lastRescue?.worktrees[0]?.pushed?.removal?.failureKind).toBe(
      'no-remote',
    );
    await pool.stop();
  });

  it('消して一定期間が過ぎた作業ツリーの項目は台帳から落とす（C3）。消せなかったものは残す', async () => {
    const fake = fakeRunner();
    const { pool, jobOfId } = await setup(
      [
        jobOf('mgr-x', 'failed', 20, [
          wt(pushedOf({ removal: { at: iso(-8 * DAY), reason: 'failed' } }), 'old'),
          wt(
            pushedOf({
              ref: `${REF}z`,
              removal: { at: iso(-90 * DAY), reason: 'failed', failureKind: 'auth', attempts: 3 },
            }),
            'stuck',
          ),
        ]),
      ],
      [fake],
    );
    await pool.sweepRescueRefs?.();
    const paths = (await jobOfId('mgr-x')).lastRescue?.worktrees.map((w) => w.relativePath);
    expect(paths).toEqual(['stuck']);
    await pool.stop();
  });

  it('lost のまま20日放置→stopped になった直後は猶予ゼロで消さない。終端を見た時刻から14日で消す', async () => {
    const fake = fakeRunner();
    const stoppedNow = jobOf('mgr-x', 'stopped', 20, [wt(pushedOf())]);
    delete stoppedNow.lastRescue?.terminal;
    const { pool, jobOfId } = await setup([stoppedNow], [fake]);
    await pool.sweepRescueRefs?.();
    expect(fake.calls).toEqual([]);
    const marked = (await jobOfId('mgr-x')).lastRescue?.terminal;
    expect(marked).toEqual({ status: 'stopped', seenAt: iso(0) });
    nowMs += 14 * DAY - 5 * 60_000;
    await pool.sweepRescueRefs?.();
    expect(fake.calls).toEqual([]);
    nowMs += 11 * 60_000;
    await pool.sweepRescueRefs?.();
    expect(fake.calls).toHaveLength(1);
    await pool.stop();
  });

  it('変わらない委譲へは台帳の書き込みを打たない（印の付け直し・片付け・削除のどれも無いとき）', async () => {
    const fake = fakeRunner();
    const { pool, stores } = await setup(
      [
        jobOf('mgr-run', 'running', 90, [wt(pushedOf())]),
        jobOf('mgr-lost', 'lost', 90, [wt(pushedOf())]),
        jobOf('mgr-done', 'done', 1, [wt(pushedOf())]),
      ],
      [fake],
    );
    let writes = 0;
    const original = stores.jobs.updateJob.bind(stores.jobs);
    stores.jobs.updateJob = (...args) => {
      writes += 1;
      return original(...args);
    };
    await pool.sweepRescueRefs?.();
    expect(writes).toBe(0);
    expect(fake.calls).toEqual([]);
    await pool.stop();
  });

  it('1回の走査で撃つ削除は20本まで。残りは次の回へ回す', async () => {
    const fake = fakeRunner();
    const jobs = Array.from({ length: 25 }, (_, i) =>
      jobOf(`mgr-${String(i).padStart(2, '0')}`, 'done', 30, [
        wt(pushedOf({ ref: `${REF}${String(i).padStart(2, '0')}` })),
      ]),
    );
    const { pool } = await setup(jobs, [fake]);
    await pool.sweepRescueRefs?.();
    expect(fake.calls).toHaveLength(20);
    nowMs += 11 * 60_000;
    await pool.sweepRescueRefs?.();
    expect(fake.calls).toHaveLength(25);
    expect(new Set(fake.calls.map((c) => c.ref)).size).toBe(25);
    await pool.stop();
  });

  it('旧 runner（other）なら次の runner へ進む。auth など他でも同じ結果になるものはそこで止める', async () => {
    const old = fakeRunner('runner-primary');
    old.next.result = { outcome: 'failed', kind: 'other' };
    const fresh = fakeRunner('runner-new');
    const { pool, jobOfId } = await setup(
      [jobOf('mgr-x', 'done', 8, [wt(pushedOf())])],
      [old, fresh],
    );
    await pool.sweepRescueRefs?.();
    expect(old.calls).toHaveLength(1);
    expect(fresh.calls).toHaveLength(1);
    expect(
      (await jobOfId('mgr-x')).lastRescue?.worktrees[0]?.pushed?.removal?.failureKind,
    ).toBeUndefined();
    await pool.stop();

    const a = fakeRunner('runner-primary');
    a.next.result = { outcome: 'failed', kind: 'auth' };
    const b = fakeRunner('runner-new');
    const second = await setup([jobOf('mgr-y', 'done', 8, [wt(pushedOf())])], [a, b]);
    await second.pool.sweepRescueRefs?.();
    expect(b.calls).toEqual([]);
    expect(
      (await second.jobOfId('mgr-y')).lastRescue?.worktrees[0]?.pushed?.removal?.failureKind,
    ).toBe('auth');
    await second.pool.stop();
  });

  it('送り先の無い古い台帳は no-remote を1回だけ書き、以後は何も書かない。manager_list は手で消すと言う', async () => {
    const fake = fakeRunner();
    const noRemote = { ...pushedOf() } as Partial<ReturnType<typeof pushedOf>>;
    delete noRemote.remote;
    const { pool, stores, jobOfId, journal } = await setup(
      [jobOf('mgr-x', 'done', 30, [wt(noRemote as ReturnType<typeof pushedOf>)])],
      [fake],
    );
    await pool.sweepRescueRefs?.();
    let writes = 0;
    const original = stores.jobs.updateJob.bind(stores.jobs);
    stores.jobs.updateJob = (...args) => {
      writes += 1;
      return original(...args);
    };
    for (const days of [1, 3, 10]) {
      nowMs += days * DAY;
      await pool.sweepRescueRefs?.();
    }
    expect(writes).toBe(0);
    expect(fake.calls).toEqual([]);
    expect((await journal()).split('消せなかった').length - 1).toBe(1);
    const text = describeRescue({ lastRescue: (await jobOfId('mgr-x')).lastRescue } as never);
    expect(text).toContain('自動では消せない');
    await pool.stop();
  });

  it('mergeRescue は、同じ退避 commit のあいだ removal を引き継ぎ、新しい退避には付けない', () => {
    const removal = { at: iso(0), reason: 'done' as const };
    const before = { at: iso(0), worktrees: [wt(pushedOf({ removal }))] };
    const same = mergeRescue(before, [wt(pushedOf())], iso(1));
    expect(same.worktrees[0]?.pushed?.removal).toEqual(removal);
    const withMark = mergeRescue(
      { ...before, terminal: { status: 'stopped', seenAt: iso(-DAY) } },
      [wt(pushedOf())],
      iso(1),
    );
    expect(withMark.terminal).toEqual({ status: 'stopped', seenAt: iso(-DAY) });
    const fresh = mergeRescue(before, [wt(pushedOf({ commit: 'b'.repeat(40) }))], iso(1));
    expect(fresh.worktrees[0]?.pushed?.removal).toBeUndefined();
  });

  it('manager_list の行は、消した ref を「在る」と読ませない', () => {
    const text = describeRescue({
      lastRescue: {
        at: iso(0),
        worktrees: [
          wt(pushedOf({ removal: { at: iso(0), reason: 'landed' } })),
          wt(
            pushedOf({
              removal: { at: iso(0), reason: 'done', failureKind: 'network', attempts: 2 },
            }),
            'wt2',
          ),
        ],
      },
    } as never);
    expect(text).toContain('に消した（内容が origin の枝に入っていた）');
    expect(text).toContain('消せなかった（network');
  });
});
