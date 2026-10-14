import { createHash } from 'node:crypto';

import type { RunnerHost } from '@alteroid/core';
import { describe, expect, it } from 'vitest';

import { createRunnerApp, Outbox } from './app.js';

const TOKEN = 'daemon-only-token-keep-peers';
const TOKEN_SHA256 = createHash('sha256').update(TOKEN, 'utf8').digest('hex');

// 鍵の付け替えのための畳みの印（keepPeers）をクエリで受け、host へ渡す（#4734）
describe('DELETE /managers/:id の keepPeers（#4734）', () => {
  function appWith(calls: { managerId: string; options: unknown }[]) {
    const host = {
      noteDaemonContact: () => undefined,
      stop: async (managerId: string, options?: unknown) => {
        calls.push({ managerId, options });
      },
    } as unknown as RunnerHost;
    return createRunnerApp({ host, outbox: new Outbox(), tokenSha256: TOKEN_SHA256 });
  }
  const del = (app: ReturnType<typeof appWith>, path: string) =>
    app.request(path, { method: 'DELETE', headers: { authorization: `Bearer ${TOKEN}` } });

  it('⭐ keepPeers=1 なら host に keepPeers を渡す', async () => {
    const calls: { managerId: string; options: unknown }[] = [];
    const response = await del(appWith(calls), '/managers/mgr-1?keepPeers=1');
    expect(response.status).toBe(200);
    expect(calls).toEqual([{ managerId: 'mgr-1', options: { keepPeers: true } }]);
  });

  it('印が無ければ今どおり（peer を閉じる停止）', async () => {
    const calls: { managerId: string; options: unknown }[] = [];
    await del(appWith(calls), '/managers/mgr-1');
    expect(calls).toEqual([{ managerId: 'mgr-1', options: {} }]);
  });
});
