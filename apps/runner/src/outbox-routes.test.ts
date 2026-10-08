import { createHash } from 'node:crypto';
import { readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  collectManagerOutbox,
  createRunnerHost,
  prepareManagerOutbox,
  RUNNER_CAPABILITY_MANAGER_OUTBOX,
  type RunnerHost,
} from '@alteroid/core';
import { afterEach, describe, expect, it } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';
import { createRunnerApp, Outbox } from './app.js';

const TOKEN = 'daemon-only-token';
const TOKEN_SHA256 = createHash('sha256').update(TOKEN, 'utf8').digest('hex');
const MANAGER = 'mgr-abc123';

let host: RunnerHost | undefined;
afterEach(async () => {
  await host?.shutdown();
  host = undefined;
});

async function setup() {
  const outboxRoot = await makeTempDir('runner-outbox-routes-');
  const stagedRoot = await makeTempDir('runner-outbox-routes-staged-');
  host = createRunnerHost({
    runnerId: 'runner-outbox-routes',
    workspacePath: '/workspace',
    emit: () => undefined,
    outboxRoot,
    outboxStagedRoot: stagedRoot,
    scratchSweep: false,
  });
  const app = createRunnerApp({
    host,
    outbox: new Outbox(),
    tokenSha256: TOKEN_SHA256,
    sseHeartbeatMs: 60_000,
  });
  const dir = prepareManagerOutbox({ root: outboxRoot, managerId: MANAGER });
  await writeFile(join(dir, 'a.txt'), 'hello outbox');
  const { files } = await collectManagerOutbox({
    root: outboxRoot,
    stagedRoot,
    managerId: MANAGER,
    expectedUid: process.getuid?.(),
    limits: { maxFileBytes: 1024, maxPerMessage: 5, maxTotalBytes: 4096 },
  });
  const fileId = files[0]?.fileId ?? '';
  const call = (method: string, path: string, token: string | null = TOKEN) =>
    app.request(path, {
      method,
      headers: token === null ? {} : { authorization: `Bearer ${token}` },
    });
  return { stagedRoot, fileId, call };
}

describe('GET / DELETE /managers/:id/outbox/:fileId', () => {
  it('GET で中身が取れる（octet-stream・content-length つき）。無ければ 404', async () => {
    const { fileId, call } = await setup();
    const res = await call('GET', `/managers/${MANAGER}/outbox/${fileId}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/octet-stream');
    expect(res.headers.get('content-length')).toBe(String('hello outbox'.length));
    expect(await res.text()).toBe('hello outbox');
    expect((await call('GET', `/managers/${MANAGER}/outbox/${'0'.repeat(32)}`)).status).toBe(404);
    expect((await call('GET', `/managers/mgr-other/outbox/${fileId}`)).status).toBe(404);
  });

  it('DELETE で消え、もう一度消しても 204（冪等）', async () => {
    const { stagedRoot, fileId, call } = await setup();
    expect((await call('DELETE', `/managers/${MANAGER}/outbox/${fileId}`)).status).toBe(204);
    expect(await readdir(join(stagedRoot, MANAGER))).toEqual([]);
    expect((await call('DELETE', `/managers/${MANAGER}/outbox/${fileId}`)).status).toBe(204);
    expect((await call('GET', `/managers/${MANAGER}/outbox/${fileId}`)).status).toBe(404);
  });

  it('不正な fileId（`..`・パス区切り・形違い）は 400 で断る', async () => {
    const { call } = await setup();
    for (const bad of ['..', '%2e%2e', '..%2F..%2Fetc%2Fpasswd', 'ABC', 'x'.repeat(32)]) {
      // 経路の正規化で届かない形（`..`・`%2F`）は 404、届く形は 400。どちらも通さない
      expect([400, 404]).toContain(
        (await call('GET', `/managers/${MANAGER}/outbox/${bad}`)).status,
      );
      expect([400, 404]).toContain(
        (await call('DELETE', `/managers/${MANAGER}/outbox/${bad}`)).status,
      );
    }
  });

  it('合鍵が無ければ 401', async () => {
    const { fileId, call } = await setup();
    expect((await call('GET', `/managers/${MANAGER}/outbox/${fileId}`, null)).status).toBe(401);
    expect((await call('DELETE', `/managers/${MANAGER}/outbox/${fileId}`, 'wrong')).status).toBe(
      401,
    );
  });
});

describe('hello', () => {
  it('manager-outbox を名乗る', async () => {
    const { call } = await setup();
    const res = await call('GET', '/events');
    const reader = res.body?.getReader();
    const first = await reader?.read();
    await reader?.cancel();
    const text = new TextDecoder().decode(first?.value);
    expect(text).toContain(RUNNER_CAPABILITY_MANAGER_OUTBOX);
  });
});
