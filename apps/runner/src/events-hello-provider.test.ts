import { createHash } from 'node:crypto';

import { createRunnerHost, readAttachmentLimits, runnerAttachmentBodyLimit } from '@alteroid/core';
import { describe, expect, it } from 'vitest';

import { createRunnerApp, Outbox } from './app.js';

const TOKEN = 'daemon-only-token';
const TOKEN_SHA256 = createHash('sha256').update(TOKEN, 'utf8').digest('hex');

async function helloFrame(
  models: { managerModel?: string; workerModel?: string } = {},
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
    ...models,
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

describe('runner の hello', () => {
  it('マネージャー層の provider を名乗らない（managerProvider / managerProviders。2026-10-07 の決定）', async () => {
    // 名乗ると、旧いデーモンが `provider` 付きの start / resume を送ってくる（名乗りを見て送る作りのため）。
    const hello = await helloFrame();
    expect(hello).toMatchObject({ type: 'hello', runnerId: 'runner-hello-provider-test' });
    expect(hello).not.toHaveProperty('managerProvider');
    expect(hello).not.toHaveProperty('managerProviders');
  });

  it('モデルを渡せば managerModel / workerModel で名乗り、渡さなければ欄を載せない（旧い runner と同じ形。#3921）', async () => {
    const named = await helloFrame({ managerModel: 'opus', workerModel: 'sonnet' });
    expect(named).toMatchObject({ managerModel: 'opus', workerModel: 'sonnet' });
    const none = await helloFrame();
    expect(none).not.toHaveProperty('managerModel');
    expect(none).not.toHaveProperty('workerModel');
    expect(none).not.toHaveProperty('models');
  });

  it('片方だけ渡されたら、渡された側だけ名乗る（もう一方を既定で埋めない）', async () => {
    const hello = await helloFrame({ workerModel: 'sonnet' });
    expect(hello).toMatchObject({ workerModel: 'sonnet' });
    expect(hello).not.toHaveProperty('managerModel');
  });

  it('添付を運ぶ口の本文の上限を attachmentBodyLimit で名乗る（#3111 段3。デーモンが送る前に検める）', async () => {
    expect((await helloFrame()).attachmentBodyLimit).toBe(
      runnerAttachmentBodyLimit(readAttachmentLimits().limits),
    );
  });
});
