import { describe, expect, it, vi } from 'vitest';

import { sha256Hex } from './auth.js';
import { createManagerPool } from './manager.js';
import { describeRescueStash } from './tools.js';
import {
  createRunnerRegistry,
  RUNNER_CAPABILITY_MANAGER_ATTACHMENTS,
  RUNNER_CAPABILITY_RESCUE_RESTORE,
  runnerEventSchema,
  type RunnerAttachment,
  type RunnerClient,
  type RunnerEvent,
  type RunnerManagerState,
  type RunnerResumeCommand,
  type RunnerStartCommand,
} from './runner-protocol.js';
import type { AttachmentLimits } from './attachment.js';
import type { Job, RescueStashEntry } from './schema.js';
import { createMemoryStores } from './testing.js';

const bytesOf = (text: string): Uint8Array => new TextEncoder().encode(text);

interface Sent {
  managerId: string;
  text: string;
  attachments: RunnerAttachment[];
}

function fakeRunner(options: { restore?: boolean; alive?: readonly string[] } = {}) {
  let emit: ((event: RunnerEvent) => void) | null = null;
  const sent: Sent[] = [];
  const starts: RunnerStartCommand[] = [];
  const resumes: RunnerResumeCommand[] = [];
  const alive: RunnerManagerState[] = (options.alive ?? ['mgr-s']).map((id) => ({
    managerId: id,
    status: 'running',
    cwd: '/work/project',
    request: 'r',
    waiting: [],
    sessionId: `sess-${id}`,
  }));
  const runner = {
    runnerId: 'runner-primary',
    runnerIdKnown: true,
    workspacePath: '/work/project',
    workspacePathKnown: true,
    async connect(onEvent: (event: RunnerEvent) => void) {
      emit = onEvent;
      const parsed = runnerEventSchema.parse({
        type: 'hello',
        runnerId: 'runner-primary',
        capabilities: [
          RUNNER_CAPABILITY_MANAGER_ATTACHMENTS,
          ...(options.restore === false ? [] : [RUNNER_CAPABILITY_RESCUE_RESTORE]),
        ],
      });
      onEvent(parsed);
    },
    async start(command: RunnerStartCommand) {
      starts.push(command);
      return {};
    },
    async resume(command: RunnerResumeCommand) {
      resumes.push(command);
      alive.push({
        managerId: command.managerId,
        status: 'running',
        cwd: command.cwd,
        request: command.request,
        waiting: [],
        sessionId: command.sessionId,
      });
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
  } as unknown as RunnerClient;
  return {
    runner,
    sent,
    starts,
    resumes,
    request(event: Omit<Extract<RunnerEvent, { type: 'rescue_restore_request' }>, 'type'>) {
      // デーモンが受ける形を通す（境界で落ちないこと）
      emit?.(runnerEventSchema.parse({ type: 'rescue_restore_request', ...event }));
    },
  };
}

function jobOf(id: string, extra: Partial<Job> = {}): Job {
  return {
    id,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    status: 'running',
    summary: 's',
    request: 'r',
    cwd: '/work/project',
    sessionId: `sess-${id}`,
    runnerId: 'runner-primary',
    ...extra,
  };
}

async function stash(
  stores: ReturnType<typeof createMemoryStores>,
  owner: string,
  files: { worktree?: string; path: string; text: string }[],
): Promise<RescueStashEntry[]> {
  const entries: RescueStashEntry[] = [];
  for (const file of files) {
    const bytes = bytesOf(file.text);
    const meta = await stores.attachments.put({
      name: file.path.split('/').pop() ?? file.path,
      mediaType: 'application/octet-stream',
      bytes,
      kept: true,
      uploadedBy: `manager:${owner}`,
    });
    entries.push({
      worktree: file.worktree ?? '.',
      path: file.path,
      attachmentId: meta.id,
      size: bytes.length,
      sha256: sha256Hex(bytes),
      at: '2026-10-01T00:00:00.000Z',
    });
  }
  return entries;
}

async function setup(
  build: (stores: ReturnType<typeof createMemoryStores>) => Promise<Job[]>,
  fakeOptions: Parameters<typeof fakeRunner>[0] = {},
  attachmentLimits?: AttachmentLimits,
) {
  const stores = createMemoryStores();
  for (const job of await build(stores)) await stores.jobs.putJob(job);
  const fake = fakeRunner(fakeOptions);
  const pool = createManagerPool({
    stores,
    post: () => undefined,
    runners: createRunnerRegistry([fake.runner]),
    ...(attachmentLimits === undefined ? {} : { attachmentLimits }),
  });
  await pool.restore();
  return { pool, stores, fake };
}

const decode = (attachment: RunnerAttachment): string =>
  Buffer.from(attachment.data ?? '', 'base64').toString('utf8');

describe('rescue_restore: 預かりを担当へ添付で返す（#4863 案A その2）', () => {
  it('全部: 預かりを添付つきで担当へ送る。中身が一致し、本文に元の場所・大きさ・sha256 の頭 12 桁・時刻・上書きの注意が出る', async () => {
    const { pool, stores, fake } = await setup(async (s) => [
      jobOf('mgr-s', {
        rescueStash: await stash(s, 'mgr-s', [
          { path: 'a.txt', text: 'alpha' },
          { worktree: 'repo', path: 'art/b.png', text: 'beta!!' },
        ]),
      }),
    ]);
    fake.request({ managerId: 'mgr-s' });
    await vi.waitFor(() => expect(fake.sent).toHaveLength(1));
    const [sent] = fake.sent;
    expect(sent!.managerId).toBe('mgr-s');
    expect(sent!.attachments.map(decode).sort()).toEqual(['alpha', 'beta!!']);
    expect(sent!.text).toContain('a.txt');
    expect(sent!.text).toContain('repo/art/b.png');
    expect(sent!.text).toContain(sha256Hex(bytesOf('alpha')).slice(0, 12));
    expect(sent!.text).toContain('2026-10-01T00:00:00.000Z');
    expect(sent!.text).toContain('上書きする前に確かめること');
    const journal = JSON.stringify(await stores.journal.list({ types: ['decision'] }));
    expect(journal).toContain('rescue_restore');
    await pool.stop();
  });

  it('paths: `<worktree>/<path>` でも path だけでも絞れる。預かりに無い指定は本文に出す', async () => {
    const { pool, fake } = await setup(async (s) => [
      jobOf('mgr-s', {
        rescueStash: await stash(s, 'mgr-s', [
          { path: 'a.txt', text: 'alpha' },
          { worktree: 'repo', path: 'art/b.png', text: 'beta!!' },
          { worktree: 'repo', path: 'c.txt', text: 'gamma' },
        ]),
      }),
    ]);
    fake.request({ managerId: 'mgr-s', paths: ['repo/art/b.png', 'a.txt', 'nope.txt'] });
    await vi.waitFor(() => expect(fake.sent).toHaveLength(1));
    const [sent] = fake.sent;
    expect(sent!.attachments.map(decode).sort()).toEqual(['alpha', 'beta!!']);
    expect(sent!.text).toContain('預かりに無かった指定: nope.txt');
    await pool.stop();
  });

  it('上限（1通の個数）を超える分は送らず、残りのパスと呼び直しの案内を本文に書く', async () => {
    const limits: AttachmentLimits = {
      maxImageBytes: 1_000_000,
      maxFileBytes: 1_000_000,
      maxLargeFileBytes: 0,
      maxPerMessage: 2,
      maxTotalBytes: 1_000_000,
      retentionDays: 7,
    };
    const { pool, fake } = await setup(
      async (s) => [
        jobOf('mgr-s', {
          rescueStash: await stash(s, 'mgr-s', [
            { path: 'a.txt', text: 'a' },
            { path: 'b.txt', text: 'b' },
            { path: 'c.txt', text: 'c' },
          ]),
        }),
      ],
      {},
      limits,
    );
    fake.request({ managerId: 'mgr-s' });
    await vi.waitFor(() => expect(fake.sent).toHaveLength(1));
    const [sent] = fake.sent;
    expect(sent!.attachments).toHaveLength(2);
    expect(sent!.text).toContain('残り 1 件');
    expect(sent!.text).toContain('c.txt');
    expect(sent!.text).toContain('paths に残りのパスを渡して呼び直すこと');
    await pool.stop();
  });

  it('from: 自分が後継になっている前任の預かりは送る（supersededBy が自分）', async () => {
    const { pool, fake } = await setup(async (s) => [
      jobOf('mgr-old', {
        status: 'failed',
        supersededBy: 'mgr-s',
        rescueStash: await stash(s, 'mgr-old', [{ path: 'old.txt', text: 'from-old' }]),
      }),
      jobOf('mgr-s', { supersedes: 'mgr-old' }),
    ]);
    fake.request({ managerId: 'mgr-s', from: 'mgr-old' });
    await vi.waitFor(() => expect(fake.sent).toHaveLength(1));
    expect(fake.sent[0]!.managerId).toBe('mgr-s');
    expect(fake.sent[0]!.attachments.map(decode)).toEqual(['from-old']);
    await pool.stop();
  });

  it('from: 関係の無い委譲は断り、理由を本文だけで知らせる（添付は送らない）', async () => {
    const { pool, stores, fake } = await setup(async (s) => [
      jobOf('mgr-other', {
        status: 'failed',
        rescueStash: await stash(s, 'mgr-other', [{ path: 'secret.txt', text: 'nope' }]),
      }),
      jobOf('mgr-s'),
    ]);
    fake.request({ managerId: 'mgr-s', from: 'mgr-other' });
    await vi.waitFor(() => expect(fake.sent).toHaveLength(1));
    expect(fake.sent[0]!.attachments).toEqual([]);
    expect(fake.sent[0]!.text).toContain('rescue_restore を断った');
    expect(fake.sent[0]!.text).toContain('前任ではない');
    expect(JSON.stringify(await stores.journal.list({ types: ['decision'] }))).toContain('断った');
    await pool.stop();
  });

  it('預かりが無ければ、無いと本文で知らせる', async () => {
    const { pool, fake } = await setup(async () => [jobOf('mgr-s')]);
    fake.request({ managerId: 'mgr-s' });
    await vi.waitFor(() => expect(fake.sent).toHaveLength(1));
    expect(fake.sent[0]!.attachments).toEqual([]);
    expect(fake.sent[0]!.text).toContain('依頼のファイルは無かった');
    await pool.stop();
  });
});

describe('預かりの知らせ（担当が口の存在を知る）', () => {
  it('器が入れ替わった後の再開の文に、件数と先頭 10 件のパスと rescue_restore が出る。空なら出ない', async () => {
    const files = Array.from({ length: 12 }, (_, i) => ({
      path: `f${String(i)}.txt`,
      text: `x${String(i)}`,
    }));
    const withStash = await setup(
      async (s) => [jobOf('mgr-s', { rescueStash: await stash(s, 'mgr-s', files) })],
      { alive: [] },
    );
    const message = withStash.fake.resumes[0]?.message ?? '';
    expect(message).toContain('12 件ある');
    expect(message).toContain('f9.txt');
    expect(message).not.toContain('f10.txt');
    expect(message).toContain('ほか 2 件');
    expect(message).toContain('rescue_restore');
    await withStash.pool.stop();

    const without = await setup(async () => [jobOf('mgr-s')], { alive: [] });
    expect(without.fake.resumes[0]?.message ?? '').not.toContain('rescue_restore');
    await without.pool.stop();
  });

  it('道具を名乗らない器には、呼べない道具を指さない', async () => {
    const { pool, fake } = await setup(
      async (s) => [
        jobOf('mgr-s', { rescueStash: await stash(s, 'mgr-s', [{ path: 'a.txt', text: 'a' }]) }),
      ],
      { alive: [], restore: false },
    );
    const message = fake.resumes[0]?.message ?? '';
    expect(message).toContain('a.txt');
    expect(message).toContain('道具が無い');
    expect(message).not.toContain('rescue_restore({');
    await pool.stop();
  });

  it('後継の最初の依頼文の末尾に、前任の預かりと rescue_restore({ from }) が出る。空なら依頼文は元のまま', async () => {
    const { pool, stores, fake } = await setup(
      async (s) => [
        jobOf('mgr-old', {
          status: 'failed',
          rescueStash: await stash(s, 'mgr-old', [{ path: 'old.txt', text: 'o' }]),
        }),
        jobOf('mgr-empty', { status: 'failed' }),
      ],
      { alive: [] },
    );
    await pool.start({ request: '続きをやって', supersedes: 'mgr-old', cwd: '/work/project' });
    const withNote = fake.starts.at(-1)!;
    expect(withNote.request.startsWith('続きをやって')).toBe(true);
    expect(withNote.request).toContain("rescue_restore({ from: 'mgr-old' })");
    expect(withNote.request).toContain('old.txt');
    // 台帳の request は元の文のまま
    const jobs = await stores.jobs.listJobs();
    expect(jobs.find((j) => j.supersedes === 'mgr-old')?.request).toBe('続きをやって');

    await pool.start({ request: '続きをやって', supersedes: 'mgr-empty', cwd: '/work/project' });
    expect(fake.starts.at(-1)!.request).toBe('続きをやって');
    await pool.stop();
  });
});

describe('像に預かりの件数と合計が出る', () => {
  it('ManagerSummary.rescueStash と describeRescueStash', async () => {
    const { pool, fake } = await setup(async (s) => [
      jobOf('mgr-s', {
        rescueStash: await stash(s, 'mgr-s', [
          { path: 'a.txt', text: 'alpha' },
          { path: 'b.txt', text: 'be' },
        ]),
      }),
      jobOf('mgr-none'),
    ]);
    void fake;
    const list = await pool.list();
    const summary = list.find((m) => m.managerId === 'mgr-s');
    expect(summary?.rescueStash).toEqual({
      count: 2,
      totalBytes: 7,
      latestAt: '2026-10-01T00:00:00.000Z',
    });
    expect(describeRescueStash(summary!)).toContain('2 件・合計 7 バイト');
    expect(list.find((m) => m.managerId === 'mgr-none')?.rescueStash).toBeUndefined();
    expect(describeRescueStash(list.find((m) => m.managerId === 'mgr-none')!)).toBeNull();
    await pool.stop();
  });
});
