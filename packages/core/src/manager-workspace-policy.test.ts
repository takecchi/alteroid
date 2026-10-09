import { describe, expect, it } from 'vitest';

import {
  createManagerPool,
  resolveWorkspacePolicy,
  WORKSPACE_KIND_ENV_KEY,
  WORKSPACE_REF_ENV_KEY,
  WORKSPACE_REPOSITORY_ENV_KEY,
  type WorkspacePolicy,
} from './manager.js';
import { createProfileService } from './profile-service.js';
import {
  createRunnerRegistry,
  type RunnerClient,
  type RunnerManagerState,
  type RunnerStartCommand,
} from './runner-protocol.js';
import type { InboxEvent, Job } from './schema.js';
import { createMemoryStores } from './testing.js';

const UNVERIFIED_WORKSPACE_REASON =
  '器の workspace がボリュームかどうかを runner が名乗らないので、' +
  '入れ替えを跨いで残るかを確かめられない（roadmap M5「workspace locator の運用選択」）。';

// env は引数で渡し、`process.env` は書き換えない: 並列実行で他のテストを汚さないため。
// 読めない設定・不足した設定は `runner-volume`（肯定的な永続性の主張）へは倒さず `unknown` へ倒す。
describe('resolveWorkspacePolicy', () => {
  it('未設定なら unknown で、reason は今日の既定の文字列と完全一致する', () => {
    const policy = resolveWorkspacePolicy({});

    expect(policy).toEqual({ kind: 'unknown', reason: UNVERIFIED_WORKSPACE_REASON });
  });

  it('=runner-volume なら { kind: "runner-volume" }', () => {
    const policy = resolveWorkspacePolicy({ [WORKSPACE_KIND_ENV_KEY]: 'runner-volume' });

    expect(policy).toEqual({ kind: 'runner-volume' });
  });

  it('=shared-volume なら { kind: "shared-volume" }', () => {
    const policy = resolveWorkspacePolicy({ [WORKSPACE_KIND_ENV_KEY]: 'shared-volume' });

    expect(policy).toEqual({ kind: 'shared-volume' });
  });

  it('=git ＋ _REPOSITORY があれば git。_REF 省略時の既定は main', () => {
    const policy = resolveWorkspacePolicy({
      [WORKSPACE_KIND_ENV_KEY]: 'git',
      [WORKSPACE_REPOSITORY_ENV_KEY]: 'https://github.com/acme/widgets.git',
    });

    expect(policy).toEqual({
      kind: 'git',
      repository: 'https://github.com/acme/widgets.git',
      ref: 'main',
    });
  });

  it('=git ＋ _REPOSITORY ＋ _REF があれば、その ref を使う', () => {
    const policy = resolveWorkspacePolicy({
      [WORKSPACE_KIND_ENV_KEY]: 'git',
      [WORKSPACE_REPOSITORY_ENV_KEY]: 'https://github.com/acme/widgets.git',
      [WORKSPACE_REF_ENV_KEY]: 'release/prod',
    });

    expect(policy).toEqual({
      kind: 'git',
      repository: 'https://github.com/acme/widgets.git',
      ref: 'release/prod',
    });
  });

  it('=git だが _REPOSITORY が無いと unknown になる——runner-volume にはならない', () => {
    const policy = resolveWorkspacePolicy({ [WORKSPACE_KIND_ENV_KEY]: 'git' });

    expect(policy.kind).toBe('unknown');
    // 設定不足・読めない設定は runner-volume（肯定的な永続性の主張）へ倒さず unknown へ倒す。
    expect(policy.kind).not.toBe('runner-volume');
    expect((policy as { reason: string }).reason).toContain(WORKSPACE_REPOSITORY_ENV_KEY);
  });

  it('読めない値（nfs）は unknown になる——同じく runner-volume にはならない', () => {
    const policy = resolveWorkspacePolicy({ [WORKSPACE_KIND_ENV_KEY]: 'nfs' });

    expect(policy.kind).toBe('unknown');
    expect(policy.kind).not.toBe('runner-volume');
    expect((policy as { reason: string }).reason).toContain('nfs');
  });

  it('空文字は未設定と同じ扱いになる', () => {
    const policy = resolveWorkspacePolicy({ [WORKSPACE_KIND_ENV_KEY]: '' });

    expect(policy).toEqual({ kind: 'unknown', reason: UNVERIFIED_WORKSPACE_REASON });
  });

  describe('_REPOSITORY の資格は台帳へ入れる前に落とす（#2492）', () => {
    const repositoryOf = (value: string): string => {
      const policy = resolveWorkspacePolicy({
        [WORKSPACE_KIND_ENV_KEY]: 'git',
        [WORKSPACE_REPOSITORY_ENV_KEY]: value,
      });
      if (policy.kind !== 'git') throw new Error('git のはず');
      return policy.repository;
    };
    const fakeToken = 'ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8';

    it('userinfo（user:pass・token だけ）・クエリ・フラグメントを落とす', () => {
      expect(repositoryOf(`https://x-access-token:${fakeToken}@github.com/o/r.git`)).toBe(
        'https://github.com/o/r.git',
      );
      expect(repositoryOf(`https://${fakeToken}@github.com/o/r.git`)).toBe(
        'https://github.com/o/r.git',
      );
      expect(repositoryOf('https://github.com/o/r.git?access=secret#frag')).toBe(
        'https://github.com/o/r.git',
      );
    });

    it('scheme の無い user:pass@host は伏せる', () => {
      expect(repositoryOf('x:secretpass@github.com/o/r.git')).not.toContain('secretpass');
    });

    it('資格の無い URL は1バイトも変えない', () => {
      expect(repositoryOf('https://github.com/acme/widgets.git')).toBe(
        'https://github.com/acme/widgets.git',
      );
      expect(repositoryOf('https://github.com')).toBe('https://github.com');
      expect(repositoryOf('takecchi/alteroid')).toBe('takecchi/alteroid');
    });

    it('scp 形式と ssh のアカウント名（パスワード無し）は変えない', () => {
      expect(repositoryOf('git@github.com:o/r.git')).toBe('git@github.com:o/r.git');
      expect(repositoryOf('ssh://git@github.com/o/r.git')).toBe('ssh://git@github.com/o/r.git');
    });
  });
});

function fakeRunner(runnerId: string, workspacePath: string) {
  const alive: RunnerManagerState[] = [];
  const started: RunnerStartCommand[] = [];
  const runner: RunnerClient = {
    runnerId,
    runnerIdKnown: true,
    workspacePathKnown: true,
    workspacePath,
    async connect() {
      /* この検証では使わない */
    },
    async start(command): Promise<{ cwd?: string }> {
      started.push(command);
      alive.push({
        managerId: command.managerId,
        status: 'running',
        cwd: command.cwd,
        request: command.request,
        waiting: [],
      });
      return {};
    },
    async resume(): Promise<{ cwd?: string }> {
      return {};
    },
    async send() {
      return true;
    },
    async answer() {
      return { delivered: false };
    },
    async stop() {
      /* この検証では使わない */
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
      return { ok: true };
    },
    async close() {
      /* この検証では使わない */
    },
  };
  return { runner, started };
}

function setup(runner: RunnerClient, workspace?: WorkspacePolicy) {
  const stores = createMemoryStores();
  const inbox: InboxEvent[] = [];
  const registry = createRunnerRegistry([runner]);
  const pool = createManagerPool({
    stores,
    post: (event) => inbox.push(event),
    runners: registry,
    profile: createProfileService({ stores, runners: registry }),
    ...(workspace === undefined ? {} : { workspace }),
  });
  return { pool, stores, inbox };
}

async function jobOf(
  stores: ReturnType<typeof createMemoryStores>,
  managerId: string,
): Promise<Job> {
  const jobs = await stores.jobs.listJobs();
  const job = jobs.find((j) => j.managerId === managerId);
  if (job === undefined) throw new Error(`job not found: ${managerId}`);
  return job;
}

describe('start() が台帳へ書く job.workspace は ManagerPoolOptions.workspace から決まる', () => {
  it('shared-volume を渡すと { kind: "shared-volume", path: cwd } になる', async () => {
    const { runner } = fakeRunner('runner-a', '/work/project');
    const s = setup(runner, { kind: 'shared-volume' });

    const { managerId } = await s.pool.start({ request: '調べて' });
    const job = await jobOf(s.stores, managerId);

    expect(job.workspace).toEqual({ kind: 'shared-volume', path: '/work/project' });

    await s.pool.stop();
  });

  it('git を渡すと { kind: "git", repository, ref } になる', async () => {
    const { runner } = fakeRunner('runner-a', '/work/project');
    const s = setup(runner, {
      kind: 'git',
      repository: 'https://github.com/acme/widgets.git',
      ref: 'feature/migrate-db',
    });

    const { managerId } = await s.pool.start({ request: '調べて' });
    const job = await jobOf(s.stores, managerId);

    expect(job.workspace).toEqual({
      kind: 'git',
      repository: 'https://github.com/acme/widgets.git',
      ref: 'feature/migrate-db',
    });

    await s.pool.stop();
  });

  it('workspace を渡さない（既定）と、今日と同じ unknown（runnerId / path / reason が3つとも一致）になる', async () => {
    const { runner } = fakeRunner('runner-a', '/work/project');
    const s = setup(runner);

    const { managerId } = await s.pool.start({ request: '調べて' });
    const job = await jobOf(s.stores, managerId);

    expect(job.workspace).toEqual({
      kind: 'unknown',
      runnerId: 'runner-a',
      path: '/work/project',
      reason: UNVERIFIED_WORKSPACE_REASON,
    });

    await s.pool.stop();
  });

  it('runner-volume を渡すと { kind: "runner-volume", runnerId, path } になる', async () => {
    const { runner } = fakeRunner('runner-a', '/work/project');
    const s = setup(runner, { kind: 'runner-volume' });

    const { managerId } = await s.pool.start({ request: '調べて' });
    const job = await jobOf(s.stores, managerId);

    expect(job.workspace).toEqual({
      kind: 'runner-volume',
      runnerId: 'runner-a',
      path: '/work/project',
    });

    await s.pool.stop();
  });
});
