import { createHash } from 'node:crypto';

import { createRunnerHost } from '@alteroid/core';
import { describe, expect, it } from 'vitest';

import { createRunnerApp, Outbox } from './app.js';

/**
 * `GET /events` の `hello` に、マネージャー層の provider id が載ること（#486 段 S1）。
 * 渡さなければ欄そのものが無い ＝ 読み側が `claude` と読む（旧い runner と同じ形）。
 */
const TOKEN = 'daemon-only-token';
const TOKEN_SHA256 = createHash('sha256').update(TOKEN, 'utf8').digest('hex');

async function helloFrame(managerProvider?: string): Promise<Record<string, unknown>> {
  const app = createRunnerApp({
    host: createRunnerHost({
      runnerId: 'runner-hello-provider-test',
      workspacePath: '/workspace',
      emit: () => undefined,
    }),
    outbox: new Outbox(),
    tokenSha256: TOKEN_SHA256,
    sseHeartbeatMs: 60_000,
    ...(managerProvider === undefined ? {} : { managerProvider }),
  });
  const response = await app.request('/events', {
    headers: { authorization: `Bearer ${TOKEN}`, accept: 'text/event-stream' },
  });
  const reader = response.body?.getReader();
  if (reader === undefined) throw new Error('SSE の応答に本文が無い');
  const decoder = new TextDecoder();
  let seen = '';
  while (!seen.includes('\n\n')) {
    const next = await reader.read();
    if (next.done) break;
    seen += decoder.decode(next.value, { stream: true });
  }
  await reader.cancel();
  const data = /^data: (.*)$/m.exec(seen)?.[1];
  if (data === undefined) throw new Error(`hello の data が読めない: ${seen}`);
  return JSON.parse(data) as Record<string, unknown>;
}

describe('runner の hello の managerProvider', () => {
  it('渡した provider id を名乗る', async () => {
    expect(await helloFrame('claude')).toMatchObject({
      type: 'hello',
      runnerId: 'runner-hello-provider-test',
      managerProvider: 'claude',
    });
  });

  it('渡さなければ欄を載せない（旧い runner と同じ形）', async () => {
    expect(await helloFrame()).not.toHaveProperty('managerProvider');
  });

  it('命令で名指しされて起こせる provider を managerProviders で名乗る（#486 S7。既定の provider とは別の軸）', async () => {
    expect((await helloFrame()).managerProviders).toEqual(['claude', 'codex']);
  });
});
