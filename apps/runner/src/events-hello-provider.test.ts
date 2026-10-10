import { createHash } from 'node:crypto';

import {
  CODEX_PEER_CLOSED_REASON,
  createCredentialStore,
  createRunnerHost,
  readAttachmentLimits,
  RUNNER_CAPABILITY_MANAGER_PEERS,
  runnerAttachmentBodyLimit,
  type RunnerHost,
} from '@alteroid/core';
import { describe, expect, it } from 'vitest';

import { makeTempDirSync } from '../../../vitest.tmpdir.js';
import { createRunnerApp, Outbox } from './app.js';

const TOKEN = 'daemon-only-token';
const TOKEN_SHA256 = createHash('sha256').update(TOKEN, 'utf8').digest('hex');

async function helloFrame(
  options: {
    managerModel?: string;
    workerModel?: string;
    /**
     * peer の口を持つ器にする。`closed` は資格が届いていない器、`open` は `CODEX_API_KEY` が
     * 届いた器（hello は接続のたびに host から読む）。省略は peer の口を持たない器。
     */
    peer?: 'closed' | 'open';
  } = {},
): Promise<Record<string, unknown>> {
  const { peer, ...models } = options;
  const host = peerHost(peer);
  if (peer === 'open') await host.setCredentials([{ name: 'CODEX_API_KEY', value: 'sk-test' }]);
  const app = createRunnerApp({
    host,
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
  await host.shutdown();
  const data = /^data: (.*)$/m.exec(seen)?.[1];
  if (data === undefined) throw new Error(`hello の data が読めない: ${seen}`);
  return JSON.parse(data) as Record<string, unknown>;
}

function peerHost(peer: 'closed' | 'open' | undefined): RunnerHost {
  return createRunnerHost({
    runnerId: 'runner-hello-provider-test',
    workspacePath: '/workspace',
    emit: () => undefined,
    credentials: createCredentialStore({
      dir: makeTempDirSync('runner-hello-cred-'),
      seed: {},
    }),
    codexHome: makeTempDirSync('runner-hello-codex-'),
    ...(peer === undefined
      ? {}
      : {
          peer: {
            openSocket: async () => ({
              socketPath: '/run/alteroid/peer/peer.sock',
              register: () => 'tok',
              close: () => undefined,
            }),
            models: { codex: ['gpt-5.5'] },
            reportsUsage: () => true,
          },
        }),
  });
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

  it('peer を名乗る版であることを能力で名乗り、開いている peer とモデルを managerPeers に載せる（#3940・#4118）', async () => {
    const hello = await helloFrame({ peer: 'open' });
    expect(hello.capabilities).toContain(RUNNER_CAPABILITY_MANAGER_PEERS);
    expect(hello.managerPeers).toEqual([{ provider: 'codex', models: ['gpt-5.5'] }]);
    expect(hello).not.toHaveProperty('managerPeersClosed');
  });

  it('資格が届いていなければ managerPeers を送らず、閉じている理由を managerPeersClosed で送る（#4118）', async () => {
    const closed = await helloFrame({ peer: 'closed' });
    expect(closed).not.toHaveProperty('managerPeers');
    expect(closed.managerPeersClosed).toEqual([
      { provider: 'codex', reason: CODEX_PEER_CLOSED_REASON },
    ]);
    // peer の口を持たない器はどちらも送らない
    const none = await helloFrame();
    expect(none).not.toHaveProperty('managerPeers');
    expect(none).not.toHaveProperty('managerPeersClosed');
  });
});
