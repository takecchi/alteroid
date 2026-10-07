import { createHash } from 'node:crypto';

import { createRunnerHost, readAttachmentLimits, runnerAttachmentBodyLimit } from '@alteroid/core';
import { describe, expect, it } from 'vitest';

import { createRunnerApp, Outbox } from './app.js';

const TOKEN = 'daemon-only-token';
const TOKEN_SHA256 = createHash('sha256').update(TOKEN, 'utf8').digest('hex');

async function helloFrame(
  managerProvider?: string,
  models?: Record<string, { manager: string; worker: string }>,
): Promise<Record<string, unknown>> {
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
    ...(models === undefined ? {} : { models }),
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

  it('models を渡せば provider ごとのモデルの表記を名乗り、渡さなければ欄を載せない（旧い runner と同じ形。#3921）', async () => {
    const models = { claude: { manager: 'opus', worker: 'sonnet' } };
    expect((await helloFrame('claude', models)).models).toEqual(models);
    expect(await helloFrame('claude')).not.toHaveProperty('models');
  });

  it('添付を運ぶ口の本文の上限を attachmentBodyLimit で名乗る（#3111 段3。デーモンが送る前に検める）', async () => {
    expect((await helloFrame()).attachmentBodyLimit).toBe(
      runnerAttachmentBodyLimit(readAttachmentLimits().limits),
    );
  });
});
