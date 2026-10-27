import { describe, expect, it, vi } from 'vitest';

import { sha256Hex } from './auth.js';
import { createManagerPool, type ManagerPool } from './manager.js';
import {
  createRunnerRegistry,
  RUNNER_CAPABILITY_RESCUE_FILES,
  runnerEventSchema,
  type RunnerClient,
  type RunnerEvent,
  type RunnerManagerState,
  type RunnerOutboxContent,
} from './runner-protocol.js';
import {
  RESCUE_STASH_MAX_BYTES_PER_JOB,
  RESCUE_STASH_MAX_FILES_PER_JOB,
  type Job,
  type RescueStashEntry,
} from './schema.js';
import { createMemoryStores } from './testing.js';
import type { Stores } from './store.js';

const DAY = 24 * 60 * 60_000;
const bytesOf = (text: string): Uint8Array => new TextEncoder().encode(text);

interface Fake {
  runner: RunnerClient;
  contents: Map<string, Uint8Array>;
  opened: string[];
  deleted: string[];
  send(event: RunnerEvent): void;
}

function fakeRunner(names: boolean): Fake {
  let emit: ((event: RunnerEvent) => void) | null = null;
  const contents = new Map<string, Uint8Array>();
  const opened: string[] = [];
  const deleted: string[] = [];
  const alive: RunnerManagerState[] = [];
  const parse = (raw: RunnerEvent): RunnerEvent => {
    const parsed = runnerEventSchema.safeParse(JSON.parse(JSON.stringify(raw)) as unknown);
    if (!parsed.success) throw new Error(`境界で落ちた: ${parsed.error.message}`);
    return parsed.data;
  };
  const runner = {
    runnerId: 'runner-primary',
    runnerIdKnown: true,
    workspacePath: '/work/project',
    workspacePathKnown: true,
    async connect(onEvent: (event: RunnerEvent) => void) {
      emit = onEvent;
      onEvent(
        parse({
          type: 'hello',
          runnerId: 'runner-primary',
          capabilities: names ? [RUNNER_CAPABILITY_RESCUE_FILES] : [],
        } as RunnerEvent),
      );
    },
    async start() {
      return {};
    },
    async resume() {
      return {};
    },
    async send() {
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
      opened.push(fileId);
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
    async deleteOutboxFile(_managerId: string, fileId: string) {
      deleted.push(fileId);
    },
  } as unknown as RunnerClient;
  alive.push({
    managerId: 'mgr-s',
    status: 'running',
    cwd: '/work/project',
    request: 'r',
    waiting: [],
    sessionId: 'sess-s',
  });
  return { runner, contents, opened, deleted, send: (e) => emit?.(parse(e)) };
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
    sessionId: 'sess-s',
    runnerId: 'runner-primary',
    ...extra,
  };
}

async function setup(names = true, job: Job = jobOf(), now: () => number = () => Date.now()) {
  const stores = createMemoryStores();
  await stores.jobs.putJob(job);
  const fake = fakeRunner(names);
  const pool = createManagerPool({
    stores,
    post: () => undefined,
    runners: createRunnerRegistry([fake.runner]),
    now,
  });
  await pool.restore();
  return { pool, stores, fake };
}

let counter = 0;
function offer(fake: Fake, path: string, text: string, worktree = '.') {
  counter += 1;
  const fileId = counter.toString(16).padStart(32, '0');
  const bytes = bytesOf(text);
  fake.contents.set(fileId, bytes);
  fake.send({
    type: 'rescue_files',
    managerId: 'mgr-s',
    worktree,
    files: [{ fileId, path, size: bytes.length, sha256: sha256Hex(bytes) }],
    skipped: [],
  });
  return fileId;
}

async function stashOf(stores: Stores): Promise<RescueStashEntry[]> {
  const job = (await stores.jobs.listJobs()).find((j) => j.id === 'mgr-s');
  return job?.rescueStash ?? [];
}

async function done(pool: ManagerPool): Promise<void> {
  await pool.stop();
}

describe('未追跡のファイルの預かり（デーモン側。#4863）', () => {
  it('取りに行き、保存の印つき・uploadedBy manager:<id> で入れて、job.rescueStash に載せ、退避先を消させる', async () => {
    const { pool, stores, fake } = await setup();
    const fileId = offer(fake, 'art/a.png', 'pixels');
    await vi.waitFor(async () => expect(await stashOf(stores)).toHaveLength(1));
    const [entry] = await stashOf(stores);
    expect(entry).toMatchObject({
      worktree: '.',
      path: 'art/a.png',
      size: 6,
      sha256: sha256Hex(bytesOf('pixels')),
    });
    const stored = await stores.attachments.get(entry!.attachmentId);
    expect(new TextDecoder().decode(stored?.bytes)).toBe('pixels');
    expect(stored?.meta.keptAt).toBeDefined();
    expect(stored?.meta.expiresAt).toBeUndefined();
    expect(stored?.meta.uploadedBy).toBe('manager:mgr-s');
    await vi.waitFor(() => expect(fake.deleted).toContain(fileId));
    await done(pool);
  });

  it('git でない置き場の位置（絶対パスの worktree）でも、同じに取り込み、同じ path でも作業ツリーの預かりと別の項目にする（#5255）', async () => {
    const { pool, stores, fake } = await setup();
    const fileId = offer(fake, 'script.sh', 'echo bench', '/tmp/mgr-abcd1234-bench');
    offer(fake, 'script.sh', 'echo tree', '.');
    await vi.waitFor(async () => expect(await stashOf(stores)).toHaveLength(2));
    const entries = await stashOf(stores);
    const scratch = entries.find((e) => e.worktree === '/tmp/mgr-abcd1234-bench');
    expect(scratch).toMatchObject({ path: 'script.sh', sha256: sha256Hex(bytesOf('echo bench')) });
    const stored = await stores.attachments.get(scratch!.attachmentId);
    expect(new TextDecoder().decode(stored?.bytes)).toBe('echo bench');
    expect(entries.find((e) => e.worktree === '.')?.path).toBe('script.sh');
    await vi.waitFor(() => expect(fake.deleted).toContain(fileId));
    await done(pool);
  });

  it('同じ (worktree, path) が新しい中身で来たら古い添付を消して差し替える。同じ sha256 なら取りに行かず退避先だけ消す', async () => {
    const { pool, stores, fake } = await setup();
    offer(fake, 'a.txt', 'v1');
    await vi.waitFor(async () => expect(await stashOf(stores)).toHaveLength(1));
    const [first] = await stashOf(stores);

    const same = offer(fake, 'a.txt', 'v1');
    await vi.waitFor(() => expect(fake.deleted).toContain(same));
    expect(fake.opened).not.toContain(same);
    expect(await stashOf(stores)).toHaveLength(1);

    offer(fake, 'a.txt', 'v2-longer');
    await vi.waitFor(async () => expect((await stashOf(stores))[0]?.size).toBe(9));
    const stash = await stashOf(stores);
    expect(stash).toHaveLength(1);
    expect(stash[0]!.attachmentId).not.toBe(first!.attachmentId);
    expect(await stores.attachments.getMeta(first!.attachmentId)).toBeUndefined();
    expect(await stores.attachments.getMeta(stash[0]!.attachmentId)).toBeDefined();
    await done(pool);
  });

  it('預けた後に添付が消えていたら、同じ sha256 でも取り込み直して項目を差し替える（#4874）', async () => {
    const { pool, stores, fake } = await setup();
    offer(fake, 'a.txt', 'v1');
    await vi.waitFor(async () => expect(await stashOf(stores)).toHaveLength(1));
    const [first] = await stashOf(stores);
    await stores.attachments.remove(first!.attachmentId);

    const again = offer(fake, 'a.txt', 'v1');
    await vi.waitFor(async () => {
      const stash = await stashOf(stores);
      expect(stash).toHaveLength(1);
      expect(stash[0]!.attachmentId).not.toBe(first!.attachmentId);
    });
    expect(fake.opened).toContain(again);
    const [next] = await stashOf(stores);
    expect(await stores.attachments.getMeta(next!.attachmentId)).toBeDefined();
    await done(pool);
  });

  it('委譲ごとの上限（件数）を超える分は預けず job-budget として日誌へ残す', async () => {
    const existing: RescueStashEntry[] = Array.from(
      { length: RESCUE_STASH_MAX_FILES_PER_JOB },
      (_, i) => ({
        worktree: '.',
        path: `f${String(i)}`,
        attachmentId: `att-${String(i)}`,
        size: 1,
        sha256: 'a'.repeat(64),
        at: '2026-10-01T00:00:00.000Z',
      }),
    );
    const { pool, stores, fake } = await setup(true, jobOf({ rescueStash: existing }));
    const fileId = offer(fake, 'one-too-many', 'x');
    await vi.waitFor(() => expect(fake.deleted).toContain(fileId));
    expect(fake.opened).toEqual([]);
    expect(await stashOf(stores)).toHaveLength(RESCUE_STASH_MAX_FILES_PER_JOB);
    const journal = JSON.stringify(await stores.journal.list({ types: ['decision'] }));
    expect(journal).toContain('one-too-many');
    expect(journal).toContain('job-budget');
    // 器の機構が定型で書く行: 要約の一覧から外す印が付く
    const rows = await stores.journal.list({ types: ['decision'] });
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row).toMatchObject({ routine: true });
    await done(pool);
  });

  it('委譲ごとの上限（合計 1 GiB）を超える分は預けない', async () => {
    const existing: RescueStashEntry[] = [
      {
        worktree: '.',
        path: 'huge',
        attachmentId: 'att-huge',
        size: RESCUE_STASH_MAX_BYTES_PER_JOB,
        sha256: 'b'.repeat(64),
        at: '2026-10-01T00:00:00.000Z',
      },
    ];
    const { pool, stores, fake } = await setup(true, jobOf({ rescueStash: existing }));
    const fileId = offer(fake, 'more', 'x');
    await vi.waitFor(() => expect(fake.deleted).toContain(fileId));
    expect(fake.opened).toEqual([]);
    expect(await stashOf(stores)).toHaveLength(1);
    await done(pool);
  });

  it('rescue-files を名乗らない runner からは取りに行かず、日誌へ残す', async () => {
    const { pool, stores, fake } = await setup(false);
    const fileId = offer(fake, 'a.txt', 'x');
    await vi.waitFor(async () =>
      expect(JSON.stringify(await stores.journal.list({ types: ['decision'] }))).toContain('a.txt'),
    );
    expect(fake.opened).toEqual([]);
    expect(await stashOf(stores)).toEqual([]);
    // 取りに行かなくても、退避先は消させる（#4925）
    await vi.waitFor(() => expect(fake.deleted).toContain(fileId));
    await done(pool);
  });

  it('台帳に無い担当の預かり・出し箱も、退避先を消させる（#4925）', async () => {
    const { pool, fake } = await setup();
    const rescueId = 'a'.repeat(32);
    const outboxId = 'b'.repeat(32);
    fake.send({
      type: 'rescue_files',
      managerId: 'mgr-unknown',
      worktree: '.',
      files: [{ fileId: rescueId, path: 'a.txt', size: 1, sha256: sha256Hex(bytesOf('x')) }],
      skipped: [],
    });
    fake.send({
      type: 'report',
      managerId: 'mgr-unknown',
      status: 'done',
      text: '終わった',
      files: [
        {
          fileId: outboxId,
          name: 'o.txt',
          mediaType: 'text/plain',
          size: 1,
          sha256: sha256Hex(bytesOf('x')),
        },
      ],
    } as RunnerEvent);
    await vi.waitFor(() =>
      expect(fake.deleted).toEqual(expect.arrayContaining([rescueId, outboxId])),
    );
    expect(fake.opened).toEqual([]);
    await done(pool);
  });

  it('申告と中身が合わないものは入れず、置き場に残さない', async () => {
    const { pool, stores, fake } = await setup();
    const fileId = '9'.repeat(32);
    fake.contents.set(fileId, bytesOf('actual'));
    fake.send({
      type: 'rescue_files',
      managerId: 'mgr-s',
      worktree: '.',
      files: [{ fileId, path: 'bad.txt', size: 6, sha256: sha256Hex(bytesOf('other!')) }],
      skipped: [],
    });
    await vi.waitFor(() => expect(fake.deleted).toContain(fileId));
    expect(await stashOf(stores)).toEqual([]);
    expect((await stores.attachments.usage()).count).toBe(0);
    await done(pool);
  });

  it('runner が預けなかったもの（secret-like）は、パスと規則の名前だけを日誌へ残す。同じものは繰り返さない', async () => {
    const { pool, stores, fake } = await setup();
    const send = () =>
      fake.send({
        type: 'rescue_files',
        managerId: 'mgr-s',
        worktree: 'wt',
        files: [],
        skipped: [{ path: 'notes.txt', reason: 'secret-like', patterns: ['aws-access-key'] }],
      });
    send();
    await vi.waitFor(async () =>
      expect(JSON.stringify(await stores.journal.list({ types: ['decision'] }))).toContain(
        'aws-access-key',
      ),
    );
    send();
    // 実時間で待たない（#2146）: 同じ委譲の預かりは直列に処理されるので、後ろに送った別の出来事が日誌に出たら、重複の分も処理済み
    fake.send({
      type: 'rescue_files',
      managerId: 'mgr-s',
      worktree: 'wt',
      files: [],
      skipped: [{ path: 'fence.txt', reason: 'not-regular' }],
    });
    await vi.waitFor(async () =>
      expect(JSON.stringify(await stores.journal.list({ types: ['decision'] }))).toContain(
        'fence.txt',
      ),
    );
    const entries = await stores.journal.list({ types: ['decision'] });
    expect(entries.filter((e) => JSON.stringify(e).includes('notes.txt'))).toHaveLength(1);
    expect(JSON.stringify(entries)).toContain('鍵らしい文字列');
    await done(pool);
  });
});

describe('預かりの掃除（退避 ref と同じ猶予）', () => {
  const NOW = Date.parse('2026-10-20T00:00:00.000Z');
  const iso = (offset: number): string => new Date(NOW + offset).toISOString();

  async function sweepCase(status: Job['status'], quietDays: number) {
    const stores = createMemoryStores();
    const meta = await stores.attachments.put({
      name: 'a.txt',
      mediaType: 'application/octet-stream',
      bytes: bytesOf('x'),
      kept: true,
      uploadedBy: 'manager:mgr-s',
    });
    const terminal =
      status === 'done' || status === 'failed' || status === 'stopped'
        ? { terminal: { status, seenAt: iso(-quietDays * DAY) } }
        : {};
    await stores.jobs.putJob(
      jobOf({
        status,
        lastRescue: { at: iso(-quietDays * DAY), worktrees: [], ...terminal },
        rescueStash: [
          {
            worktree: '.',
            path: 'a.txt',
            attachmentId: meta.id,
            size: 1,
            sha256: meta.sha256,
            at: iso(-quietDays * DAY),
          },
        ],
      }),
    );
    const pool = createManagerPool({
      stores,
      post: () => undefined,
      runners: createRunnerRegistry([fakeRunner(true).runner]),
      now: () => NOW,
    });
    await pool.sweepRescueRefs?.();
    const job = (await stores.jobs.listJobs()).find((j) => j.id === 'mgr-s')!;
    const attachment = await stores.attachments.getMeta(meta.id);
    const decisions = await stores.journal.list({ types: ['decision'] });
    await pool.stop();
    return { job, attachment, decisions };
  }

  it('done は7日を過ぎたら添付を消し、欄を空にする。6日では消さない', async () => {
    const gone = await sweepCase('done', 8);
    expect(gone.attachment).toBeUndefined();
    expect(gone.job.rescueStash).toBeUndefined();
    // 預かりの掃除の行は定型: 要約の一覧から外す印が付く
    expect(gone.decisions.length).toBeGreaterThan(0);
    for (const row of gone.decisions) expect(row).toMatchObject({ routine: true });
    const kept = await sweepCase('done', 6);
    expect(kept.attachment).toBeDefined();
    expect(kept.job.rescueStash).toHaveLength(1);
  });

  it('failed は14日。13日では消さない', async () => {
    expect((await sweepCase('failed', 14)).job.rescueStash).toBeUndefined();
    expect((await sweepCase('failed', 13)).job.rescueStash).toHaveLength(1);
  });

  it('lost は何日放置されても時間では消さない', async () => {
    const result = await sweepCase('lost', 400);
    expect(result.attachment).toBeDefined();
    expect(result.job.rescueStash).toHaveLength(1);
  });
});
