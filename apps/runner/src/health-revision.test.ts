import { createHash } from 'node:crypto';

import { createRunnerHost, type BuildRevision, type RunnerHost } from '@alteroid/core';
import { describe, expect, it, vi } from 'vitest';

import { createRunnerApp, Outbox } from './app.js';
import { appDefaults } from './app-defaults.test-support.js';

// 版は `resolveBuildRevision()`（焼き込み > ALTEROID_BUILD_REV > RAILWAY_GIT_COMMIT_SHA）だけが決める。焼き込みはビルドで埋まり
// env より優先されるので、env では「取れない」を作れない。app が呼ぶ関数を差し替えて、返った値がそのまま /health に出ることを見る。
const resolved = vi.hoisted(() => ({
  revision: { commit: null, short: null, source: null } as BuildRevision,
}));
vi.mock('@alteroid/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@alteroid/core')>()),
  resolveBuildRevision: () => resolved.revision,
}));

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
    resolved.revision = { commit: null, short: null, source: null };
    const app = createRunnerApp({
      host,
      outbox: new Outbox(),
      tokenSha256: TOKEN_SHA256,
      ...appDefaults(),
    });

    const body = await readHealth(app);

    expect(body.revision).toEqual({ commit: null, short: null, source: null });
    const serialized = JSON.stringify(body.revision);
    expect(serialized).not.toMatch(/unknown/i);
    await host.shutdown();
  });

  it('版が取れているとき、解決された値が /health に出る', async () => {
    const host = newHost();
    const rev = { commit: 'a'.repeat(40), short: 'a'.repeat(12), source: 'build' as const };
    resolved.revision = rev;
    const app = createRunnerApp({
      host,
      outbox: new Outbox(),
      tokenSha256: TOKEN_SHA256,
      ...appDefaults(),
    });

    const body = await readHealth(app);

    expect(body.revision).toEqual(rev);
    await host.shutdown();
  });
});

describe('runner の /health resources.pidOwnerRecords（#5157）', () => {
  it('持ち主の記録の件数・上限・忘れた累計が資源の欄に載る', async () => {
    const host = newHost();
    const app = createRunnerApp({
      host,
      outbox: new Outbox(),
      tokenSha256: TOKEN_SHA256,
      ...appDefaults(),
    });

    const body = await readHealth(app);

    expect((body.resources as Record<string, unknown>).pidOwnerRecords).toEqual({
      remembered: 0,
      cap: 4096,
      forgottenTotal: 0,
    });
    await host.shutdown();
  });
});
