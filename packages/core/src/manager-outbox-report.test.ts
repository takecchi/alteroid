import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { Options, Query, SDKMessage, query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it, vi } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';
import { sha256Hex } from './auth.js';
import { createManagerPool, type ManagerPool } from './manager.js';
import { createLocalRunner } from './runner-local.js';
import {
  createRunnerRegistry,
  RUNNER_CAPABILITY_MANAGER_OUTBOX,
  runnerEventSchema,
  type RunnerClient,
  type RunnerEvent,
  type RunnerManagerState,
  type RunnerOutboxContent,
} from './runner-protocol.js';
import type { InboxEvent, Job } from './schema.js';
import type { Stores } from './store.js';
import { createMemoryStores } from './testing.js';

// 出来事は境界（`runnerEventSchema.safeParse`）を実際に通して渡す: スキーマに無い欄はそこで黙って落ちるため。

const MANAGER_ID = 'mgr-files';

interface Fake {
  runner: RunnerClient;
  alive: RunnerManagerState[];
  contents: Map<string, () => Promise<RunnerOutboxContent | undefined>>;
  opened: string[];
  deleted: string[];
  raw(event: RunnerEvent): void;
}

function fakeRunner(options: { names: boolean }): Fake {
  let emit: ((event: RunnerEvent) => void) | null = null;
  const alive: RunnerManagerState[] = [];
  const contents: Fake['contents'] = new Map();
  const opened: string[] = [];
  const deleted: string[] = [];
  const parse = (event: RunnerEvent): RunnerEvent => {
    const parsed = runnerEventSchema.safeParse(JSON.parse(JSON.stringify(event)) as unknown);
    if (!parsed.success) throw new Error(`境界で落ちた: ${parsed.error.message}`);
    return parsed.data;
  };
  const runner: RunnerClient = {
    runnerId: 'runner-primary',
    runnerIdKnown: true,
    workspacePath: '/work/project',
    workspacePathKnown: true,
    async connect(onEvent) {
      emit = onEvent;
      onEvent(
        parse({
          type: 'hello',
          runnerId: 'runner-primary',
          capabilities: options.names ? [RUNNER_CAPABILITY_MANAGER_OUTBOX] : [],
        }),
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
    async openOutboxFile(_managerId, fileId) {
      opened.push(fileId);
      return contents.get(fileId)?.();
    },
    async deleteOutboxFile(_managerId, fileId) {
      deleted.push(fileId);
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
    contents,
    opened,
    deleted,
    raw: (event) => emit?.(parse(event)),
  };
}

interface Setup {
  pool: ManagerPool;
  stores: Stores;
  inbox: InboxEvent[];
  fake: Fake;
}

async function setup(options: { names?: boolean; fileTimeoutMs?: number } = {}): Promise<Setup> {
  const job: Job = {
    id: MANAGER_ID,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    status: 'running',
    summary: '調べ物',
    request: '調べて',
    cwd: '/work/project',
    sessionId: `sess-${MANAGER_ID}`,
    runnerId: 'runner-primary',
  };
  const stores = createMemoryStores();
  await stores.jobs.putJob(job);
  const fake = fakeRunner({ names: options.names ?? true });
  fake.alive.push({
    managerId: job.id,
    status: 'running',
    cwd: '/work/project',
    request: '調べて',
    waiting: [],
    sessionId: job.sessionId,
  });
  const inbox: InboxEvent[] = [];
  const pool = createManagerPool({
    stores,
    post: (event) => inbox.push(event),
    runners: createRunnerRegistry([fake.runner]),
    synthesizedNoticeWindowMs: 60_000,
    outboxFetchFileTimeoutMs: options.fileTimeoutMs ?? 50,
    outboxFetchTotalTimeoutMs: 20_000,
  });
  await pool.restore();
  await vi.waitFor(() => {
    if (inbox.length === 0) throw new Error('reattach の知らせがまだ届いていない');
  });
  return { pool, stores, inbox, fake };
}

async function* chunked(bytes: Uint8Array, chunk = 3): AsyncGenerator<Uint8Array> {
  for (let at = 0; at < bytes.length; at += chunk) yield bytes.subarray(at, at + chunk);
}

const encode = (text: string) => new TextEncoder().encode(text);

function reportWithFiles(
  files: { fileId: string; name: string; bytes: Uint8Array; sha256?: string }[],
  extra: Partial<Extract<RunnerEvent, { type: 'report' }>> = {},
): RunnerEvent {
  return {
    type: 'report',
    managerId: MANAGER_ID,
    status: 'done',
    text: 'ファイルを作った',
    reportId: 'report-1',
    files: files.map((file) => ({
      fileId: file.fileId,
      name: file.name,
      mediaType: 'text/plain',
      size: file.bytes.length,
      sha256: file.sha256 ?? sha256Hex(file.bytes),
    })),
    ...extra,
  };
}

const reportMessages = (inbox: InboxEvent[]) =>
  inbox.filter(
    (event): event is Extract<InboxEvent, { type: 'manager_message' }> =>
      event.type === 'manager_message' && event.text.includes('ファイルを作った'),
  );

describe('担い手の報告に添えられたファイル — プール（#4126 P2b）', () => {
  it('取れたファイルは置き場に入って報告に結び付き、受信箱の報告に控えが載り、退避先が消される', async () => {
    const { pool, stores, inbox, fake } = await setup();
    const bytes = encode('成果物の中身');
    fake.contents.set('f'.repeat(32), async () => ({ size: bytes.length, body: chunked(bytes) }));

    fake.raw(reportWithFiles([{ fileId: 'f'.repeat(32), name: 'result.txt', bytes }]));
    await vi.waitFor(() => expect(reportMessages(inbox)).toHaveLength(1));

    const message = reportMessages(inbox)[0]!;
    expect(message.attachments).toEqual([
      {
        id: expect.any(String),
        name: 'result.txt',
        mediaType: 'text/plain',
        size: bytes.length,
        sha256: sha256Hex(bytes),
      },
    ]);
    expect(message.rejectedAttachments).toBeUndefined();
    const stored = await stores.attachments.get(message.attachments![0]!.id);
    expect(Buffer.from(stored!.bytes).toString()).toBe('成果物の中身');
    expect(stored!.meta.uploadedBy).toBe(`manager:${MANAGER_ID}`);
    expect(stored!.meta.managerReportId).toBe('report-1');
    expect(fake.deleted).toEqual(['f'.repeat(32)]);
    expect(await stores.attachments.prune(new Date(Date.now() + 2 * 3_600_000))).toBe(0);
    expect(await stores.attachments.getMeta(message.attachments![0]!.id)).toBeDefined();
    await pool.stop();
  });

  it('sha256 が合わないファイルは置かれず、報告には理由つきで載り、報告そのものは届く', async () => {
    const { pool, inbox, fake } = await setup();
    const bytes = encode('本物');
    fake.contents.set('a'.repeat(32), async () => ({ size: bytes.length, body: chunked(bytes) }));

    fake.raw(
      reportWithFiles([
        {
          fileId: 'a'.repeat(32),
          name: 'bad.txt',
          bytes,
          sha256: sha256Hex(encode('別物')),
        },
      ]),
    );
    await vi.waitFor(() => expect(reportMessages(inbox)).toHaveLength(1));

    const message = reportMessages(inbox)[0]!;
    expect(message.attachments).toBeUndefined();
    expect(message.rejectedAttachments).toEqual([
      { name: 'bad.txt', reason: 'sha256 が申告と合わない' },
    ]);
    expect(fake.deleted).toEqual([]);
    await pool.stop();
  });

  it('runner が断ったもの（rejectedFiles）だけの報告も、本文が空でも握り潰さず理由つきで届く', async () => {
    const { pool, inbox, fake } = await setup();

    fake.raw({
      type: 'report',
      managerId: MANAGER_ID,
      status: 'done',
      text: 'ファイルを作った',
      reportId: 'report-2',
      contentless: true,
      rejectedFiles: [{ name: 'link.txt', reason: 'symlink は送れない' }],
    });
    await vi.waitFor(() => expect(reportMessages(inbox)).toHaveLength(1));

    expect(reportMessages(inbox)[0]!.rejectedAttachments).toEqual([
      { name: 'link.txt', reason: 'symlink は送れない' },
    ]);
    expect(fake.opened).toEqual([]);
    await pool.stop();
  });

  it('取り出しの間に止まったファイルは時間切れで rejected になり、報告は先へ進む', async () => {
    const { pool, inbox, fake } = await setup();
    const bytes = encode('止まる');
    fake.contents.set('b'.repeat(32), async () => ({
      size: bytes.length,
      body: {
        [Symbol.asyncIterator]: () => ({
          next: () => new Promise<IteratorResult<Uint8Array>>(() => undefined),
        }),
      },
    }));

    fake.raw(reportWithFiles([{ fileId: 'b'.repeat(32), name: 'slow.txt', bytes }]));
    await vi.waitFor(() => expect(reportMessages(inbox)).toHaveLength(1));

    expect(reportMessages(inbox)[0]!.rejectedAttachments?.[0]?.reason).toContain('時間切れ');
    await pool.stop();
  });

  it('runner が manager-outbox を名乗っていなければ取りに行かず、「名乗っていない」で rejected に落とす', async () => {
    const { pool, inbox, fake } = await setup({ names: false });
    const bytes = encode('取れない');
    fake.contents.set('c'.repeat(32), async () => ({ size: bytes.length, body: chunked(bytes) }));

    fake.raw(reportWithFiles([{ fileId: 'c'.repeat(32), name: 'x.txt', bytes }]));
    await vi.waitFor(() => expect(reportMessages(inbox)).toHaveLength(1));

    expect(fake.opened).toEqual([]);
    expect(reportMessages(inbox)[0]!.rejectedAttachments).toEqual([
      { name: 'x.txt', reason: 'runner が取り出しの口を名乗っていない' },
    ]);
    await pool.stop();
  });

  it('取り出している間に届いた closed は、報告を追い越さずに処理される', async () => {
    const { pool, stores, inbox, fake } = await setup({ fileTimeoutMs: 10_000 });
    const bytes = encode('遅い');
    let release!: (content: RunnerOutboxContent) => void;
    const gate = new Promise<RunnerOutboxContent>((resolve) => {
      release = resolve;
    });
    fake.contents.set('d'.repeat(32), () => gate);
    const baseline = inbox.length;

    fake.raw(reportWithFiles([{ fileId: 'd'.repeat(32), name: 'late.txt', bytes }]));
    await vi.waitFor(() => expect(fake.opened).toEqual(['d'.repeat(32)]));
    fake.raw({ type: 'closed', managerId: MANAGER_ID, status: 'failed', reason: '畳んだ' });
    for (let i = 0; i < 30; i += 1) await new Promise<void>((resolve) => setImmediate(resolve));

    expect(inbox.slice(baseline)).toEqual([]);
    const jobs = await stores.jobs.listJobs();
    expect(jobs.find((job) => job.id === MANAGER_ID)?.status).not.toBe('failed');

    release({ size: bytes.length, body: chunked(bytes) });
    await vi.waitFor(() => expect(reportMessages(inbox)).toHaveLength(1));
    await vi.waitFor(async () => {
      const after = await stores.jobs.listJobs();
      expect(after.find((job) => job.id === MANAGER_ID)?.status).toBe('failed');
    });

    const after = inbox.slice(baseline);
    expect(after[0]).toMatchObject({ type: 'manager_message', kind: 'report' });
    expect(after[0]?.type === 'manager_message' ? after[0].attachments : undefined).toHaveLength(1);
    await pool.stop();
  });

  it('files を持たない報告は、門を立てず、後続を待たせない', async () => {
    const { pool, stores, inbox, fake } = await setup();

    fake.raw({
      type: 'report',
      managerId: MANAGER_ID,
      status: 'done',
      text: 'ファイルを作った',
      reportId: 'plain-1',
    });
    await vi.waitFor(() => expect(reportMessages(inbox)).toHaveLength(1));
    expect(reportMessages(inbox)[0]?.attachments).toBeUndefined();

    fake.raw({ type: 'closed', managerId: MANAGER_ID, status: 'failed', reason: '畳んだ' });
    await vi.waitFor(async () => {
      const jobs = await stores.jobs.listJobs();
      expect(jobs.find((job) => job.id === MANAGER_ID)?.status).toBe('failed');
    });
    expect(fake.opened).toEqual([]);
    await pool.stop();
  });
});

function fakeSdk(write: (outbox: string) => Promise<void>): typeof sdkQuery {
  return ((params: { prompt: AsyncIterable<unknown>; options?: Options }) => {
    const outbox = (params.options?.env as Record<string, string | undefined> | undefined)
      ?.ALTEROID_OUTBOX;
    async function* generate(): AsyncGenerator<SDKMessage, void> {
      yield {
        type: 'system',
        subtype: 'init',
        session_id: 'sess-local',
        uuid: 'uuid-init',
      } as unknown as SDKMessage;
      let n = 0;
      for await (const message of params.prompt) {
        void message;
        if (outbox !== undefined) await write(outbox);
        n += 1;
        yield {
          type: 'result',
          subtype: 'success',
          result: 'ファイルを作った',
          session_id: 'sess-local',
          uuid: `uuid-result-${n}`,
        } as unknown as SDKMessage;
      }
    }
    return Object.assign(generate(), {
      close: () => undefined,
      interrupt: async () => undefined,
    }) as unknown as Query;
  }) as unknown as typeof sdkQuery;
}

describe('担い手の報告に添えられたファイル — LocalRunner（#4126 P2b）', () => {
  it('同一プロセスの runner でも、出し箱のファイルが置き場に入り、報告に控えが載り、退避先が消える', async () => {
    const workspace = await makeTempDir('outbox-local-ws-');
    const stores = createMemoryStores();
    const inbox: InboxEvent[] = [];
    const runner = createLocalRunner({
      workspacePath: workspace,
      env: { PATH: '/usr/bin' },
      // 既定の根（os.tmpdir() 配下の共有の名前）に触らない: runner の器では root 所有で作れないため
      outboxRoot: join(workspace, 'outbox'),
      outboxStagedRoot: join(workspace, 'outbox-staged'),
      queryFn: fakeSdk((outbox) => writeFile(join(outbox, 'result.txt'), '成果物')),
    });
    const registry = createRunnerRegistry([runner]);
    const pool = createManagerPool({
      stores,
      post: (event) => inbox.push(event),
      runners: registry,
    });

    const { managerId } = await pool.start({ request: '依頼', cwd: workspace });
    await vi.waitFor(() => expect(reportMessages(inbox)).toHaveLength(1), { timeout: 10_000 });

    const message = reportMessages(inbox)[0]!;
    expect(message.managerId).toBe(managerId);
    expect(message.attachments).toHaveLength(1);
    expect(message.attachments?.[0]).toMatchObject({
      name: 'result.txt',
      size: Buffer.byteLength('成果物'),
    });
    const stored = await stores.attachments.get(message.attachments![0]!.id);
    expect(Buffer.from(stored!.bytes).toString()).toBe('成果物');
    expect(stored!.meta.uploadedBy).toBe(`manager:${managerId}`);
    expect(stored!.meta.managerReportId).toBeDefined();
    await pool.stop();
    await registry.stop();
  }, 20_000);
});
