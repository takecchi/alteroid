import { createHash } from 'node:crypto';
import { readdir, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

import type { Query, SDKMessage, query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { createRunnerHost, type AttachmentLimits, type RunnerHost } from '@alteroid/core';
import { afterEach, describe, expect, it } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';
import { createRunnerApp, Outbox } from './app.js';

const TOKEN = 'daemon-only-token';
const TOKEN_SHA256 = createHash('sha256').update(TOKEN, 'utf8').digest('hex');

const LIMITS: AttachmentLimits = {
  maxImageBytes: 1024,
  maxFileBytes: 1024,
  maxLargeFileBytes: 0,
  maxPerMessage: 2,
  maxTotalBytes: 2048,
  retentionDays: 30,
};

function fakeSdk(): typeof sdkQuery {
  return ((params: { prompt: AsyncIterable<unknown> }) => {
    let finish: (() => void) | null = null;
    async function* generate(): AsyncGenerator<SDKMessage, void> {
      yield {
        type: 'system',
        subtype: 'init',
        session_id: 'sess-1',
        uuid: 'uuid-init',
      } as unknown as SDKMessage;
      void (async () => {
        for await (const message of params.prompt) void message;
      })();
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
    }
    return Object.assign(generate(), {
      close: () => finish?.(),
      interrupt: async () => undefined,
    }) as unknown as Query;
  }) as unknown as typeof sdkQuery;
}

const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

let host: RunnerHost | undefined;
afterEach(async () => {
  await host?.shutdown();
  host = undefined;
});

async function setup(stageLimit = 1_000_000) {
  const root = await makeTempDir('runner-att-stage-');
  host = createRunnerHost({
    runnerId: 'runner-att-stage',
    workspacePath: '/workspace',
    emit: () => undefined,
    queryFn: fakeSdk(),
    env: { PATH: '/usr/bin' },
    attachmentsRoot: root,
    attachmentStageLimit: stageLimit,
    scratchSweep: false,
    cwdExistsFn: () => true,
    readCgroupEventCountersFn: async () => ({}),
    finishUnpushedWorkFn: async () => ({ cwd: '/workspace', worktrees: [] }),
  });
  const app = createRunnerApp({
    host,
    outbox: new Outbox(),
    tokenSha256: TOKEN_SHA256,
    attachmentLimits: LIMITS,
  });
  const put = (
    id: string,
    body: Uint8Array,
    meta: { name?: string; size?: number; sha256?: string; type?: string } = {},
    options: { token?: string | null; contentType?: string; managerId?: string } = {},
  ) => {
    const query = new URLSearchParams({
      name: meta.name ?? 'big.bin',
      type: meta.type ?? 'application/octet-stream',
      size: String(meta.size ?? body.length),
      sha256: meta.sha256 ?? sha(body),
    });
    const token = options.token === undefined ? TOKEN : options.token;
    return app.request(
      `/managers/${options.managerId ?? 'mgr-abc123'}/attachments/${id}?${query.toString()}`,
      {
        method: 'PUT',
        headers: {
          ...(token === null ? {} : { authorization: `Bearer ${token}` }),
          'content-type': options.contentType ?? 'application/octet-stream',
        },
        body,
      },
    );
  };
  const post = (path: string, body: unknown) =>
    app.request(path, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const start = (attachments: unknown[]) =>
    post('/managers', {
      managerId: 'mgr-abc123',
      request: '依頼',
      cwd: '/workspace',
      attachments,
    });
  return { root, put, post, start };
}

const ref = (id: string, bytes: Uint8Array, name = 'big.bin') => ({
  id,
  name,
  mediaType: 'application/octet-stream',
  size: bytes.length,
  sha256: sha(bytes),
  staged: true,
});

describe('PUT /managers/:id/attachments/:attachmentId（#4128 段3a の別口）', () => {
  it('流した中身を <root>/<managerId>/<id>/<名前> に置き、200 で控えを返す（読み取り専用）', async () => {
    const { root, put } = await setup();
    const bytes = Buffer.from('大きいファイルの中身\n'.repeat(50));
    const res = await put('att-1', bytes);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      id: 'att-1',
      name: 'big.bin',
      mediaType: 'application/octet-stream',
      size: bytes.length,
      sha256: sha(bytes),
    });
    const path = join(root, 'mgr-abc123', 'att-1', 'big.bin');
    expect(await readFile(path)).toEqual(bytes);
    expect((await stat(path)).mode & 0o777).toBe(0o400);
    expect(await readdir(join(root, 'mgr-abc123', 'att-1'))).toEqual(['big.bin']);
  });

  it('同じ id をもう一度流すと置き直す（同じ中身は冪等、違う中身は差し替わる）', async () => {
    const { root, put } = await setup();
    const first = Buffer.from('one');
    expect((await put('att-1', first)).status).toBe(200);
    expect((await put('att-1', first)).status).toBe(200);
    const second = Buffer.from('two-different');
    expect((await put('att-1', second)).status).toBe(200);
    expect(await readFile(join(root, 'mgr-abc123', 'att-1', 'big.bin'))).toEqual(second);
    expect(await readdir(join(root, 'mgr-abc123', 'att-1'))).toEqual(['big.bin']);
  });

  it('申告の size を超える中身は 413 で断り、tmp も何も残らない', async () => {
    const { root, put } = await setup();
    const bytes = Buffer.alloc(100, 1);
    const res = await put('att-1', bytes, { size: 40, sha256: sha(bytes.subarray(0, 40)) });
    expect(res.status).toBe(413);
    expect(await readdir(join(root, 'mgr-abc123'))).toEqual([]);
  });

  it('終わって size が合わない（足りない）中身は 422 で断り、何も残らない', async () => {
    const { root, put } = await setup();
    const bytes = Buffer.alloc(40, 1);
    const res = await put('att-1', bytes, { size: 100, sha256: sha(bytes) });
    expect(res.status).toBe(422);
    expect(await readdir(join(root, 'mgr-abc123'))).toEqual([]);
  });

  it('sha256 が合わない中身は 422 で断り、何も残らない', async () => {
    const { root, put } = await setup();
    const bytes = Buffer.alloc(40, 1);
    const res = await put('att-1', bytes, { sha256: sha(Buffer.alloc(40, 2)) });
    expect(res.status).toBe(422);
    expect(await readdir(join(root, 'mgr-abc123'))).toEqual([]);
  });

  it('断った置き直しは、すでに置いてあった中身を壊さない', async () => {
    const { root, put } = await setup();
    const good = Buffer.from('good');
    expect((await put('att-1', good)).status).toBe(200);
    const bad = Buffer.from('badd');
    expect((await put('att-1', bad, { sha256: sha(good) })).status).toBe(422);
    const dir = join(root, 'mgr-abc123', 'att-1');
    expect(await readFile(join(dir, 'big.bin'))).toEqual(good);
    expect(await readdir(dir)).toEqual(['big.bin']);
  });

  it('attachmentStageLimit を超える size は、読む前に 413 で断る', async () => {
    const { root, put } = await setup(10);
    const bytes = Buffer.alloc(11, 1);
    const res = await put('att-1', bytes);
    expect(res.status).toBe(413);
    expect(await readdir(join(root, 'mgr-abc123')).catch(() => [])).toEqual([]);
    expect((await put('att-2', Buffer.alloc(10, 1))).status).toBe(200);
  });

  it('門番（合鍵）を通らなければ 401 で、何も置かない', async () => {
    const { root, put } = await setup();
    const bytes = Buffer.from('x');
    expect((await put('att-1', bytes, {}, { token: null })).status).toBe(401);
    expect((await put('att-1', bytes, {}, { token: 'wrong' })).status).toBe(401);
    expect(await readdir(root)).toEqual([]);
  });

  it('content-type が octet-stream でなければ 415、クエリが不正なら 400（置かない）', async () => {
    const { root, put } = await setup();
    const bytes = Buffer.from('x');
    expect((await put('att-1', bytes, {}, { contentType: 'text/plain' })).status).toBe(415);
    expect((await put('att-1', bytes, { sha256: 'ABC' })).status).toBe(400);
    expect((await put('att-1', bytes, {}, { managerId: '..' })).status).not.toBe(200);
    expect(await readdir(root)).toEqual([]);
  });
});

describe('命令の staged の添付（#4128 段3a）', () => {
  it('別口で置いたファイルを指して start が通る（中身を書き直さない）', async () => {
    const { root, put, start } = await setup();
    const bytes = Buffer.from('big content');
    expect((await put('att-1', bytes)).status).toBe(200);
    const path = join(root, 'mgr-abc123', 'att-1', 'big.bin');
    const before = await stat(path);
    const res = await start([ref('att-1', bytes)]);
    expect(res.status).toBe(200);
    const after = await stat(path);
    expect(after.ino).toBe(before.ino);
    expect(await readFile(path)).toEqual(bytes);
  });

  it('置いていない staged は 422 で断る', async () => {
    const { start } = await setup();
    const res = await start([ref('att-1', Buffer.from('never staged'))]);
    expect(res.status).toBe(422);
  });

  it('命令の size / sha256 / 名前が置いた控えと食い違えば 422 で断り、置いたファイルは消さない', async () => {
    const { root, put, start } = await setup();
    const bytes = Buffer.from('big content');
    expect((await put('att-1', bytes)).status).toBe(200);
    const other = Buffer.from('other bytes');
    expect((await start([ref('att-1', other)])).status).toBe(422);
    expect((await start([{ ...ref('att-1', bytes), size: bytes.length + 1 }])).status).toBe(422);
    expect((await start([{ ...ref('att-1', bytes), sha256: sha(other) }])).status).toBe(422);
    expect((await start([ref('att-1', bytes, 'renamed.bin')])).status).toBe(422);
    expect(await readFile(join(root, 'mgr-abc123', 'att-1', 'big.bin'))).toEqual(bytes);
    // 食い違いのない参照は、断られたあとでも通る
    expect((await start([ref('att-1', bytes)])).status).toBe(200);
  });

  it('置き場から消えたものを指す staged は 422 で断る', async () => {
    const { root, put, start } = await setup();
    const bytes = Buffer.from('big content');
    expect((await put('att-1', bytes)).status).toBe(200);
    await rm(join(root, 'mgr-abc123', 'att-1'), { recursive: true });
    expect((await start([ref('att-1', bytes)])).status).toBe(422);
  });

  it('data と staged はちょうど一方（両方・どちらも無いは 400）', async () => {
    const { put, start } = await setup();
    const bytes = Buffer.from('big content');
    expect((await put('att-1', bytes)).status).toBe(200);
    const both = { ...ref('att-1', bytes), data: bytes.toString('base64') };
    expect((await start([both])).status).toBe(400);
    const neither = { ...ref('att-1', bytes), staged: undefined };
    expect((await start([neither])).status).toBe(400);
  });
});
