import { createHash } from 'node:crypto';

import { createRunnerHost, type RunnerHost } from '@alteroid/core';
import { describe, expect, it } from 'vitest';

import { createRunnerApp, Outbox } from './app.js';

const TOKEN = 'daemon-only-token';
const TOKEN_SHA256 = createHash('sha256').update(TOKEN, 'utf8').digest('hex');

function bearer(): Record<string, string> {
  return { authorization: `Bearer ${TOKEN}` };
}

async function readHealth(
  app: ReturnType<typeof createRunnerApp>,
): Promise<Record<string, unknown>> {
  const response = await app.request('/health', { headers: bearer() });
  expect(response.status).toBe(200);
  return (await response.json()) as Record<string, unknown>;
}

function newHost(): RunnerHost {
  return createRunnerHost({
    runnerId: 'runner-health-revision-test',
    workspacePath: '/workspace',
    emit: () => undefined,
  });
}

describe('runner の /health revision', () => {
  it('版が取れないとき、commit/short/source すべて null をそのまま返す（プレースホルダを返さない）', async () => {
    const host = newHost();
    const app = createRunnerApp({
      host,
      outbox: new Outbox(),
      tokenSha256: TOKEN_SHA256,
      revision: { commit: null, short: null, source: null },
    });

    const body = await readHealth(app);

    expect(body.revision).toEqual({ commit: null, short: null, source: null });
    const serialized = JSON.stringify(body.revision);
    expect(serialized).not.toMatch(/unknown/i);
    await host.shutdown();
  });

  it('版が取れているとき、そのまま渡した値が /health に出る', async () => {
    const host = newHost();
    const rev = { commit: 'a'.repeat(40), short: 'a'.repeat(12), source: 'build' as const };
    const app = createRunnerApp({
      host,
      outbox: new Outbox(),
      tokenSha256: TOKEN_SHA256,
      revision: rev,
    });

    const body = await readHealth(app);

    expect(body.revision).toEqual(rev);
    await host.shutdown();
  });
});

describe('runner の /health resources.pidOwnerRecords（#5157）', () => {
  it('持ち主の記録の件数・上限・忘れた累計が資源の欄に載る', async () => {
    const host = newHost();
    const app = createRunnerApp({ host, outbox: new Outbox(), tokenSha256: TOKEN_SHA256 });

    const body = await readHealth(app);

    expect((body.resources as Record<string, unknown>).pidOwnerRecords).toEqual({
      remembered: 0,
      cap: 4096,
      forgottenTotal: 0,
    });
    await host.shutdown();
  });
});
