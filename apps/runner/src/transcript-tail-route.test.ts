import { createHash } from 'node:crypto';

import { createRunnerHost, RUNNER_CAPABILITIES, type RunnerHost } from '@alteroid/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createRunnerApp, Outbox } from './app.js';

// 見回りが使う、生ログの末尾だけを返す口（#5160）。
const TOKEN = 'daemon-only-token';
const TOKEN_SHA256 = createHash('sha256').update(TOKEN, 'utf8').digest('hex');
const MANAGER = 'mgr-abc123';

let host: RunnerHost | undefined;
afterEach(async () => {
  await host?.shutdown();
  host = undefined;
  vi.restoreAllMocks();
});

function setup() {
  host = createRunnerHost({
    runnerId: 'runner-tail-route',
    workspacePath: '/workspace',
    emit: () => undefined,
    scratchSweep: false,
  });
  const app = createRunnerApp({
    host,
    outbox: new Outbox(),
    tokenSha256: TOKEN_SHA256,
    sseHeartbeatMs: 60_000,
  });
  const call = (path: string) =>
    app.request(path, { method: 'GET', headers: { authorization: `Bearer ${TOKEN}` } });
  return { host, call };
}

describe('GET /managers/:id/transcript/tail?maxChars=N（#5160）', () => {
  it('200: 末尾を text で返し、maxChars を host へ渡す', async () => {
    const { host, call } = setup();
    const tail = vi
      .spyOn(host, 'transcriptTail')
      .mockImplementation(async (managerId, maxChars) =>
        managerId === MANAGER ? `末尾${String(maxChars)}` : null,
      );

    const ok = await call(`/managers/${MANAGER}/transcript/tail?maxChars=1234`);

    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe('末尾1234');
    expect(tail).toHaveBeenCalledExactlyOnceWith(MANAGER, 1234);
  });

  it('404: 委譲が無い・生ログが読めないときは、全文の口と同じ 404', async () => {
    const { host, call } = setup();
    const tail = vi.spyOn(host, 'transcriptTail');

    const missing = await call(`/managers/mgr-nothing/transcript/tail?maxChars=10`);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: 'not found' });
    expect((await call(`/managers/mgr-nothing/transcript`)).status).toBe(404);
    expect(tail).toHaveBeenCalledOnce();
  });

  it('400: maxChars が無い・正の整数でない・上限を超えると、host を呼ばずに断る', async () => {
    const { host, call } = setup();
    const tail = vi.spyOn(host, 'transcriptTail').mockResolvedValue('x');

    for (const query of [
      '',
      '?maxChars=',
      '?maxChars=0',
      '?maxChars=-5',
      '?maxChars=1.5',
      '?maxChars=abc',
      '?maxChars=1e3',
      '?maxChars=2000001',
      '?maxChars=99999999999999999999',
    ]) {
      const response = await call(`/managers/${MANAGER}/transcript/tail${query}`);
      expect(response.status, query).toBe(400);
    }
    expect(tail).not.toHaveBeenCalled();

    // 上限ちょうどは通る
    expect((await call(`/managers/${MANAGER}/transcript/tail?maxChars=2000000`)).status).toBe(200);
    expect(tail).toHaveBeenCalledExactlyOnceWith(MANAGER, 2_000_000);
  });

  it('認証が無ければ 401（全文の口と同じ門の内側にある）', async () => {
    const { host } = setup();
    vi.spyOn(host, 'transcriptTail').mockResolvedValue('x');
    const app = createRunnerApp({
      host,
      outbox: new Outbox(),
      tokenSha256: TOKEN_SHA256,
      sseHeartbeatMs: 60_000,
    });
    const response = await app.request(`/managers/${MANAGER}/transcript/tail?maxChars=10`);
    expect(response.status).toBe(401);
  });

  it('能力の名乗り（hello の元）に transcript-tail が入っている', () => {
    expect(RUNNER_CAPABILITIES).toContain('transcript-tail');
  });
});
