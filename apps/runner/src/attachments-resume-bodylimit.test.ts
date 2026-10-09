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

describe('POST /managers/:id/resume の本文の上限', () => {
  it('添付の上限から計算した本文の上限（runnerAttachmentBodyLimit）を超える添付つきの resume は、/messages と同じく 413 で断り、置かない', async () => {
    const { root, post } = await setup();
    const limit = runnerAttachmentBodyLimit(LIMITS);
    const huge = attachmentOf('att-1', 'huge.bin', Buffer.alloc(limit + 1024, 7));
    const res = await post('/managers/mgr-abc123/resume', {
      managerId: 'mgr-abc123',
      sessionId: 'sess-old',
      cwd: '/workspace',
      request: '元の依頼',
      message: '続きです',
      attachments: [huge],
    });
    expect(res.status).toBe(413);
    await expect(readFile(join(root, 'mgr-abc123', 'att-1', 'huge.bin'))).rejects.toThrow();
  });
});

describe('POST /managers/:id/resume の本文の上限（検める量と対象外）', () => {
  it('添付の data の合計が上限ちょうどの resume は 413 にならず、通る（上限は「超えたら」断る）', async () => {
    const { post } = await setup();
    const limit = runnerAttachmentBodyLimit(LIMITS);
    const bytes = Buffer.alloc(Math.floor(limit / 4) * 3, 7);
    const exact = attachmentOf('att-1', 'exact.bin', bytes);
    expect(exact.data?.length ?? 0).toBeLessThanOrEqual(limit);
    expect(exact.data?.length ?? 0).toBeGreaterThan(limit - 4);
    const res = await post('/managers/mgr-abc123/resume', {
      managerId: 'mgr-abc123',
      sessionId: 'sess-old',
      cwd: '/workspace',
      request: '元の依頼',
      message: '続きです',
      attachments: [exact],
    });
    expect(res.status).toBe(200);
  });

  it('大きな entries（添付の上限を超える大きさ）を運ぶ添付なしの resume は通る（entries は対象外）', async () => {
    const { post } = await setup();
    const limit = runnerAttachmentBodyLimit(LIMITS);
    const entries = [{ type: 'user', uuid: 'u-1', padding: 'x'.repeat(limit + 1024) }];
    const res = await post('/managers/mgr-abc123/resume', {
      managerId: 'mgr-abc123',
      sessionId: 'sess-old',
      cwd: '/workspace',
      request: '元の依頼',
      message: '続きです',
      entries,
    });
    expect(JSON.stringify(entries).length).toBeGreaterThan(limit);
    expect(res.status).toBe(200);
  });
});
