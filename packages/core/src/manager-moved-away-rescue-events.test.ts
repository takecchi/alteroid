import { describe, expect, it, vi } from 'vitest';

import { sha256Hex } from './auth.js';
import { createManagerPool } from './manager.js';
import {
  createRunnerRegistry,
  RUNNER_CAPABILITY_MANAGER_ATTACHMENTS,
  RUNNER_CAPABILITY_RESCUE_FILES,
  RUNNER_CAPABILITY_RESCUE_RESTORE,
  runnerEventSchema,
  type RunnerAttachment,
  type RunnerClient,
  type RunnerEvent,
  type RunnerManagerState,
  type RunnerOutboxContent,
} from './runner-protocol.js';
import type { Job } from './schema.js';
import { createMemoryStores } from './testing.js';

// #4924: 担当が別の器へ移った後、古い器から遅れて届いた rescue_files / rescue_restore_request / parked_peers_closed は取り込まない。
const bytesOf = (text: string): Uint8Array => new TextEncoder().encode(text);

function fakeRunner(runnerId: string) {
  let emit: ((event: RunnerEvent) => void) | null = null;
  const contents = new Map<string, Uint8Array>();
  const deleted: string[] = [];
  const sent: { managerId: string; text: string; attachments: RunnerAttachment[] }[] = [];
  const alive: RunnerManagerState[] = [
    {
      managerId: 'mgr-s',
      status: 'running',
      cwd: '/work/project',
      request: 'r',
      waiting: [],
      sessionId: 'sess-mgr-s',
    },
  ];
  const runner = {
    runnerId,
    runnerIdKnown: true,
    workspacePath: '/work/project',
    workspacePathKnown: true,
    async connect(onEvent: (event: RunnerEvent) => void) {
      emit = onEvent;
      onEvent(
        runnerEventSchema.parse({
          type: 'hello',
          runnerId,
          capabilities: [
            RUNNER_CAPABILITY_RESCUE_FILES,
            RUNNER_CAPABILITY_RESCUE_RESTORE,
            RUNNER_CAPABILITY_MANAGER_ATTACHMENTS,
          ],
        }),
      );
    },
    async start() {
      return {};
    },
    async resume() {
      return {};
    },
    async send(managerId: string, text: string, attachments?: RunnerAttachment[]) {
      sent.push({ managerId, text, attachments: attachments ?? [] });
      return true;
    },
    async answer() {
      return { delivered: false };
    },
    async stop() {
      /* 使わない */
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
      /* 使わない */
    },
    async openRescueFile(
      _managerId: string,
      fileId: string,
    ): Promise<RunnerOutboxContent | undefined> {
      const bytes = contents.get(fileId);
      if (bytes === undefined) return undefined;
      return {
        size: bytes.length,
        body: (async function* () {
          yield bytes;
        })(),
      };
    },
    async deleteRescueFile(_managerId: string, fileId: string) {
      deleted.push(fileId);
    },
  } as unknown as RunnerClient;
  return {
    runner,
    contents,
    deleted,
    sent,
    raw(event: object) {
      emit?.(runnerEventSchema.parse(event));
    },
  };
}

function jobOf(extra: Partial<Job> = {}): Job {
  return {
    id: 'mgr-s',
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    status: 'running',
    summary: 's',
    request: 'r',
    cwd: '/work/project',
    sessionId: 'sess-mgr-s',
    runnerId: 'runner-b',
    ...extra,
  };
}

async function setup(job: Job = jobOf()) {
  const stores = createMemoryStores();
  await stores.jobs.putJob(job);
  const a = fakeRunner('runner-a');
  const b = fakeRunner('runner-b');
  const pool = createManagerPool({
    stores,
    post: () => undefined,
    runners: createRunnerRegistry([a.runner, b.runner]),
  });
  await pool.restore();
  return { pool, stores, a, b };
}

async function jobNow(stores: ReturnType<typeof createMemoryStores>): Promise<Job> {
  const job = (await stores.jobs.listJobs()).find((j) => j.id === 'mgr-s');
  if (job === undefined) throw new Error('job が無い');
  return job;
}

async function journalHas(
  stores: ReturnType<typeof createMemoryStores>,
  kind: string,
): Promise<boolean> {
  const entries = await stores.journal.list({ types: ['exchange'] });
  return entries.some(
    (entry) =>
      entry.type === 'exchange' &&
      entry.text.includes(`移った後に届いた古い runner の ${kind} を無視した`),
  );
}

function offer(fake: ReturnType<typeof fakeRunner>, fileId: string, text: string) {
  const bytes = bytesOf(text);
  fake.contents.set(fileId, bytes);
  fake.raw({
    type: 'rescue_files',
    managerId: 'mgr-s',
    worktree: '.',
    files: [{ fileId, path: 'art/a.png', size: bytes.length, sha256: sha256Hex(bytes) }],
    skipped: [],
  });
}

describe('移った後の古い器からの rescue 系の出来事（#4924）', () => {
  it('rescue_files: 古い器からは取り込まず（新しい預かりを置き換えない）、その器へ DELETE し、日誌に1行残す。今の器からは取り込む', async () => {
    const { pool, stores, a, b } = await setup();
    offer(b, '1'.repeat(32), 'new');
    await vi.waitFor(async () => expect((await jobNow(stores)).rescueStash).toHaveLength(1));
    const before = (await jobNow(stores)).rescueStash;

    offer(a, '2'.repeat(32), 'stale-old');
    await vi.waitFor(() => expect(a.deleted).toContain('2'.repeat(32)));
    await vi.waitFor(async () => expect(await journalHas(stores, 'rescue_files')).toBe(true));
    expect((await jobNow(stores)).rescueStash).toEqual(before);
    await pool.stop();
  });

  it('rescue_restore_request: 古い器からは届けず日誌に残す。今の器からは届ける', async () => {
    const { pool, stores, a, b } = await setup(
      jobOf({
        rescueStash: [],
      }),
    );
    a.raw({ type: 'rescue_restore_request', managerId: 'mgr-s' });
    await vi.waitFor(async () =>
      expect(await journalHas(stores, 'rescue_restore_request')).toBe(true),
    );
    expect(a.sent).toHaveLength(0);
    expect(b.sent).toHaveLength(0);
    // 今の器からは取り込まれる（預かりが空でも断りの本文が今の器へ届く）
    b.raw({ type: 'rescue_restore_request', managerId: 'mgr-s' });
    await vi.waitFor(() => expect(b.sent.length).toBeGreaterThan(0));
    expect(a.sent).toHaveLength(0);
    await pool.stop();
  });

  it('parked_peers_closed: 古い器からは積まず日誌に残す。今の器からは積む', async () => {
    const { pool, stores, a, b } = await setup();
    const peers = [{ id: 'peer-1', provider: 'codex' }];
    a.raw({ type: 'parked_peers_closed', managerId: 'mgr-s', reason: 'expired', peers });
    await vi.waitFor(async () =>
      expect(await journalHas(stores, 'parked_peers_closed')).toBe(true),
    );
    expect((await jobNow(stores)).pendingPeerCloseNotice).toBeUndefined();
    b.raw({ type: 'parked_peers_closed', managerId: 'mgr-s', reason: 'expired', peers });
    await vi.waitFor(async () =>
      expect((await jobNow(stores)).pendingPeerCloseNotice?.peers).toHaveLength(1),
    );
    await pool.stop();
  });
});
