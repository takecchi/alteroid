import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { Query, SDKMessage, query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import {
  createRunnerHost,
  runnerAttachmentBodyLimit,
  type AttachmentLimits,
  type RunnerAttachment,
  type RunnerHost,
} from '@alteroid/core';
import { afterEach, describe, expect, it } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';
import { createRunnerApp, Outbox } from './app.js';

/**
 * 担い手への添付を運ぶ2つの口（`POST /managers` / `POST /managers/:id/messages`。Issue #3111 段3）。
 * 本文の上限（添付の上限から計算）・sha256 不一致の 422・合鍵の内側にあること・置かれた中身を確かめる。
 */
const TOKEN = 'daemon-only-token';
const TOKEN_SHA256 = createHash('sha256').update(TOKEN, 'utf8').digest('hex');

const LIMITS: AttachmentLimits = {
  maxImageBytes: 1024,
  maxFileBytes: 1024,
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

function attachmentOf(id: string, name: string, bytes: Uint8Array): RunnerAttachment {
  return {
    id,
    name,
    mediaType: 'text/plain',
    size: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    data: Buffer.from(bytes).toString('base64'),
  };
}

let host: RunnerHost | undefined;
afterEach(async () => {
  await host?.shutdown();
  host = undefined;
});

async function setup() {
  const root = await makeTempDir('runner-att-routes-');
  host = createRunnerHost({
    runnerId: 'runner-att-routes',
    workspacePath: '/workspace',
    emit: () => undefined,
    queryFn: fakeSdk(),
    env: { PATH: '/usr/bin' },
    attachmentsRoot: root,
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
  const post = (path: string, body: unknown, token: string | null = TOKEN) =>
    app.request(path, {
      method: 'POST',
      headers: {
        ...(token === null ? {} : { authorization: `Bearer ${token}` }),
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });
  return { root, post };
}

const start = (attachments?: RunnerAttachment[]) => ({
  managerId: 'mgr-abc123',
  request: '依頼',
  cwd: '/workspace',
  ...(attachments === undefined ? {} : { attachments }),
});

describe('POST /managers の添付（Issue #3111 段3）', () => {
  it('添付つきの起動が通り、中身が元と同じで置かれる', async () => {
    const { root, post } = await setup();
    const bytes = Buffer.from('ログ本文');
    const res = await post('/managers', start([attachmentOf('att-1', 'run.log', bytes)]));
    expect(res.status).toBe(200);
    expect(await readFile(join(root, 'mgr-abc123', 'att-1', 'run.log'))).toEqual(bytes);
  });

  it('sha256 が合わない添付は 422 で断り、セッションを作らない', async () => {
    const { post } = await setup();
    const tampered = {
      ...attachmentOf('att-1', 'run.log', Buffer.from('original')),
      data: Buffer.from('tampered!').toString('base64'),
    };
    const res = await post('/managers', start([tampered]));
    expect(res.status).toBe(422);
    expect(host?.list()).toEqual([]);
  });

  it('同じ id の添付が2つあれば 422 で断り、セッションを作らず何も置かない（#3561）', async () => {
    const { root, post } = await setup();
    const res = await post(
      '/managers',
      start([
        attachmentOf('att-1', 'run.log', Buffer.from('first')),
        attachmentOf('att-1', 'run.log', Buffer.from('second!')),
      ]),
    );
    expect(res.status).toBe(422);
    expect(host?.list()).toEqual([]);
    await expect(readFile(join(root, 'mgr-abc123', 'att-1', 'run.log'))).rejects.toThrow();
  });

  it('本文の上限（添付の合計上限から計算した値）を超えれば 413。本文は読まない', async () => {
    const { post } = await setup();
    const limit = runnerAttachmentBodyLimit(LIMITS);
    const res = await post('/managers', { ...start(), request: 'x'.repeat(limit + 1) });
    expect(res.status).toBe(413);
    expect(host?.list()).toEqual([]);
  });

  it('合鍵が無ければ 401（添付の口も制御面の内側にある）', async () => {
    const { post } = await setup();
    expect(
      (await post('/managers', start([attachmentOf('a', 'a.txt', Buffer.from('x'))]), null)).status,
    ).toBe(401);
    expect((await post('/managers/mgr-abc123/messages', { text: 'x' }, 'wrong-token')).status).toBe(
      401,
    );
  });
});

describe('POST /managers/:id/messages の添付', () => {
  it('添付つきの追加指示が通り、置かれる。セッションが無ければ 404', async () => {
    const { root, post } = await setup();
    const bytes = Buffer.from('追加の資料');
    const missing = await post('/managers/mgr-none/messages', {
      text: 'x',
      attachments: [attachmentOf('att-1', 'doc.txt', bytes)],
    });
    expect(missing.status).toBe(404);

    expect((await post('/managers', start())).status).toBe(200);
    const res = await post('/managers/mgr-abc123/messages', {
      text: '資料です',
      attachments: [attachmentOf('att-1', 'doc.txt', bytes)],
    });
    expect(res.status).toBe(200);
    expect(await readFile(join(root, 'mgr-abc123', 'att-1', 'doc.txt'))).toEqual(bytes);
  });

  it('sha256 の不一致は 422、本文の上限超えは 413', async () => {
    const { post } = await setup();
    expect((await post('/managers', start())).status).toBe(200);
    const tampered = {
      ...attachmentOf('att-1', 'doc.txt', Buffer.from('original')),
      data: Buffer.from('tampered!').toString('base64'),
    };
    expect(
      (await post('/managers/mgr-abc123/messages', { text: 'x', attachments: [tampered] })).status,
    ).toBe(422);
    const limit = runnerAttachmentBodyLimit(LIMITS);
    expect(
      (await post('/managers/mgr-abc123/messages', { text: 'x'.repeat(limit + 1) })).status,
    ).toBe(413);
  });
});
