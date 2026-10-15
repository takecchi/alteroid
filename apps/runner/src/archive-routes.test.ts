import { createHash } from 'node:crypto';

import { createRunnerHost, type RunnerHost } from '@alteroid/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createRunnerApp, Outbox } from './app.js';

// 退避の本文を SSE の1行で運ばず、デーモンが取りに来る口（#4485）。
const TOKEN = 'daemon-only-token';
const TOKEN_SHA256 = createHash('sha256').update(TOKEN, 'utf8').digest('hex');
const MANAGER = 'mgr-abc123';
const ARCHIVE_ID = '0b5c6e1a-2f3d-4a7b-9c8d-1e2f3a4b5c6d';

let host: RunnerHost | undefined;
afterEach(async () => {
  await host?.shutdown();
  host = undefined;
  vi.restoreAllMocks();
});

function setup() {
  host = createRunnerHost({
    runnerId: 'runner-archive-routes',
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
  const call = (method: string, path: string, headers: Record<string, string> = {}) =>
    app.request(path, { method, headers: { authorization: `Bearer ${TOKEN}`, ...headers } });
  return { host, app, call };
}

describe('GET / DELETE /managers/:id/archive/:archiveId（#4485）', () => {
  it('預けた本文を text で返し、無ければ 404、形の不正な id は 400', async () => {
    const { host, call } = setup();
    const read = vi
      .spyOn(host, 'readArchive')
      .mockImplementation((managerId, id) =>
        managerId === MANAGER && id === ARCHIVE_ID ? '生ログの本文' : undefined,
      );

    const ok = await call('GET', `/managers/${MANAGER}/archive/${ARCHIVE_ID}`);
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe('生ログの本文');
    expect(read).toHaveBeenCalledWith(MANAGER, ARCHIVE_ID);

    expect((await call('GET', `/managers/mgr-other/archive/${ARCHIVE_ID}`)).status).toBe(404);
    expect((await call('GET', `/managers/${MANAGER}/archive/not-a-uuid`)).status).toBe(400);
  });

  it('GET は本文を全部返し終えたときに取り終えた印を付け、無いものには付けない（#4899）', async () => {
    const { host, call } = setup();
    vi.spyOn(host, 'readArchive').mockImplementation((managerId, id) =>
      managerId === MANAGER && id === ARCHIVE_ID ? '生ログの本文'.repeat(400_000) : undefined,
    );
    const fetched = vi.spyOn(host, 'markArchiveFetched');

    expect((await call('GET', `/managers/mgr-other/archive/${ARCHIVE_ID}`)).status).toBe(404);
    expect(fetched).not.toHaveBeenCalled();

    const ok = await call('GET', `/managers/${MANAGER}/archive/${ARCHIVE_ID}`);
    // 読み切る前には付けない（途中で切れたら、これまでどおり待つ・送り直す）
    expect(fetched).not.toHaveBeenCalled();
    expect((await ok.text()).length).toBe('生ログの本文'.length * 400_000);
    expect(fetched).toHaveBeenCalledExactlyOnceWith(MANAGER, ARCHIVE_ID);
  });

  it('DELETE は冪等に 204 を返し、形の不正な id は 400', async () => {
    const { host, call } = setup();
    const del = vi.spyOn(host, 'deleteArchive');
    expect((await call('DELETE', `/managers/${MANAGER}/archive/${ARCHIVE_ID}`)).status).toBe(204);
    expect((await call('DELETE', `/managers/${MANAGER}/archive/${ARCHIVE_ID}`)).status).toBe(204);
    expect(del).toHaveBeenCalledWith(MANAGER, ARCHIVE_ID);
    expect((await call('DELETE', `/managers/${MANAGER}/archive/not-a-uuid`)).status).toBe(400);
  });

  it('鍵の無い呼び出しは通さない', async () => {
    const { app } = setup();
    const res = await app.request(`/managers/${MANAGER}/archive/${ARCHIVE_ID}`);
    expect(res.status).toBe(401);
  });
});

describe('GET /events は、接続のたびに「参照で受け取れるか」を書き直す（#4485）', () => {
  it('ヘッダで archive-ref を名乗った接続では true、名乗らない接続では false', async () => {
    const { host, call } = setup();
    const set = vi.spyOn(host, 'setDaemonAcceptsArchiveRef');

    const first = await call('GET', '/events', { 'x-alteroid-accepts': 'archive-ref' });
    await first.body?.cancel();
    const second = await call('GET', '/events');
    await second.body?.cancel();

    expect(set.mock.calls).toEqual([[true], [false]]);
  });
});
