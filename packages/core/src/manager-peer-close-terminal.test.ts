import { describe, expect, it } from 'vitest';

import { createManagerPool } from './manager.js';
import { createProfileService } from './profile-service.js';
import {
  createRunnerRegistry,
  type RunnerAnswerOutcome,
  type RunnerClient,
  type RunnerEvent,
  type RunnerManagerState,
  type RunnerProfileFingerprint,
  type RunnerProfileResult,
  type RunnerResumeCommand,
} from './runner-protocol.js';
import type { InboxEvent, Job } from './schema.js';
import { createMemoryStores } from './testing.js';

// 担当のセッションが終わる（落ちる・失効する）と、runner は `parked_peers_closed`（reason=failed）を `closed` より前に出す。
// その時点で job はまだ running なので知らせは台帳に積まれるが、`closed(failed / lost)` の後で担当が起こされないと、誰にも届かない。

const JOB: Job = {
  id: 'mgr-pc',
  managerId: 'mgr-pc',
  createdAt: '2026-10-05T00:00:00.000Z',
  updatedAt: '2026-10-05T01:00:00.000Z',
  status: 'running',
  summary: '調べもの',
  request: '調べておいて',
  cwd: '/work/project',
  sessionId: 'sess-1',
  runnerId: 'runner-primary',
};

function fakeRunner() {
  let emit: ((event: RunnerEvent) => void) | null = null;
  const resumes: RunnerResumeCommand[] = [];
  // 起動時の照合で「まだ走っている」と読ませる（空だと台帳が failed へ落ちる）
  const alive: RunnerManagerState[] = [
    {
      managerId: 'mgr-pc',
      status: 'running',
      cwd: '/work/project',
      request: '調べておいて',
      waiting: [],
      liveBackgroundTasks: 0,
      sessionId: 'sess-1',
    },
  ];
  const runner: RunnerClient = {
    runnerId: 'runner-primary',
    runnerIdKnown: true,
    workspacePath: '/work/project',
    workspacePathKnown: true,
    async connect(onEvent) {
      emit = onEvent;
    },
    async start(command): Promise<{ cwd: string }> {
      return { cwd: command.cwd };
    },
    async resume(command): Promise<{ cwd: string }> {
      resumes.push(command);
      return { cwd: command.cwd };
    },
    async send() {
      return true;
    },
    async answer(): Promise<RunnerAnswerOutcome> {
      return { delivered: false };
    },
    async stop() {
      /* この検証では使わない */
    },
    async list() {
      return alive;
    },
    async listWithUnreadable() {
      return { states: alive, unreadableIds: [] };
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
    async profile(): Promise<RunnerProfileFingerprint | undefined> {
      return undefined;
    },
    async setProfile(): Promise<RunnerProfileResult> {
      return { ok: false, error: 'この検証では使わない' };
    },
    async close() {
      /* この検証では使わない */
    },
  };
  return {
    runner,
    resumes,
    push(event: RunnerEvent): void {
      if (emit === null) throw new Error('connect されていない');
      if (event.type === 'closed') alive.length = 0;
      emit(event);
    },
  };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function setup() {
  const stores = createMemoryStores();
  await stores.jobs.putJob(JOB);
  const fake = fakeRunner();
  const registry = createRunnerRegistry([fake.runner]);
  const inbox: InboxEvent[] = [];
  const pool = createManagerPool({
    stores,
    post: (event) => inbox.push(event),
    runners: registry,
    profile: createProfileService({ stores, runners: registry }),
  });
  await pool.restore();
  fake.resumes.length = 0;
  return { pool, fake, stores, inbox };
}

const PEERS = [{ id: 'peer-zzz', provider: 'codex', interrupted: '調査の途中で止まった' }];

function peerClosed(): RunnerEvent {
  return { type: 'parked_peers_closed', managerId: 'mgr-pc', reason: 'failed', peers: PEERS };
}

function closed(status: 'failed' | 'lost'): RunnerEvent {
  return {
    type: 'closed',
    managerId: 'mgr-pc',
    status,
    reason: 'セッションが落ちた',
  } as RunnerEvent;
}

const noticeCount = (inbox: InboxEvent[]): number =>
  inbox.filter((event) => JSON.stringify(event).includes('codex[peer-zzz]')).length;

describe('担当が終端で終わったときの peer の閉じの知らせ', () => {
  for (const status of ['failed', 'lost'] as const) {
    it(`⭐ parked_peers_closed(failed) → closed(${status}) で起こされなくても、クローンへ知らせが1件出る`, async () => {
      const s = await setup();
      s.fake.push(peerClosed());
      await settle();
      expect(noticeCount(s.inbox)).toBe(0);

      s.fake.push(closed(status));
      await settle();

      expect(noticeCount(s.inbox)).toBe(1);
      expect(JSON.stringify(s.inbox)).toContain('担当のセッションが終わった');
      // 起こし直されたときのために、台帳には残す
      expect((await s.stores.jobs.listJobs())[0]?.pendingPeerCloseNotice?.peers).toHaveLength(1);
      await s.pool.stop();
    });
  }

  it('同じ閉じが重ねて届いても、クローンへ同じ知らせを2回出さない', async () => {
    const s = await setup();
    s.fake.push(peerClosed());
    await settle();
    s.fake.push(closed('failed'));
    await settle();
    s.fake.push(closed('failed'));
    await settle();

    expect(noticeCount(s.inbox)).toBe(1);
    await s.pool.stop();
  });

  it('あとで起こし直されたら、担当の先頭にも添う', async () => {
    const s = await setup();
    s.fake.push(peerClosed());
    // 出来事は非同期に捌かれる: closed を流す前に知らせを積ませる
    await settle();
    s.fake.push(closed('failed'));
    await settle();

    await s.pool.send('mgr-pc', '続きを');
    await settle();

    const message = s.fake.resumes[0]?.message ?? '';
    expect(message).toContain('codex[peer-zzz]');
    expect(message).toContain('調査の途中で止まった');
    await s.pool.stop();
  });
});
