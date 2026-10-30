import { createHash } from 'node:crypto';
import { join } from 'node:path';

import type { SDKMessage, query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import {
  createProfileVessel,
  createRunnerHost,
  WITHHELD_ENV_KEYS,
  type RunnerHost,
} from '@alteroid/core';
import { afterEach, describe, expect, it } from 'vitest';

import { makeTempDirSync } from '../../../vitest.tmpdir.js';

import { createRunnerApp, Outbox } from './app.js';
import { appDefaults } from './app-defaults.test-support.js';

/**
 * 降ろした状態の指紋は `GET /health` に載り、値は載らない。置く口（POST）は鍵が無いと 401（#5882）。
 * 指紋だけを返す `GET /profile`・`/mcp-servers`・`/codex-auth` を外した後も、同じ事実をここで縛る。
 */
const TOKEN = 'the-daemon-only-token';
const TOKEN_SHA256 = createHash('sha256').update(TOKEN, 'utf8').digest('hex');
const AUTH = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };
const SECRET = 'fake-secret-value-5882';

function fakeSdk(): typeof sdkQuery {
  return ((): unknown => {
    async function* generate(): AsyncGenerator<SDKMessage, void> {
      yield {
        type: 'system',
        subtype: 'init',
        session_id: 'sess-health-fp',
        uuid: 'uuid-health-fp',
      } as unknown as SDKMessage;
    }
    return Object.assign(generate(), {
      close: () => undefined,
      interrupt: async () => undefined,
    });
  }) as unknown as typeof sdkQuery;
}

let host: RunnerHost | undefined;

afterEach(async () => {
  await host?.shutdown().catch(() => undefined);
  host = undefined;
});

function makeApp() {
  const dir = makeTempDirSync('alteroid-health-fp-');
  host = createRunnerHost({
    runnerId: 'runner-primary',
    workspacePath: dir,
    emit: () => undefined,
    queryFn: fakeSdk(),
    env: { PATH: process.env.PATH ?? '' },
    profile: createProfileVessel({
      path: join(dir, 'profile', 'profile.sh'),
      withheldEnvKeys: WITHHELD_ENV_KEYS,
    }),
  });
  return createRunnerApp({
    host,
    outbox: new Outbox(),
    tokenSha256: TOKEN_SHA256,
    ...appDefaults(),
  });
}

type App = ReturnType<typeof makeApp>;

async function health(app: App) {
  const res = await app.request('/health', { headers: AUTH });
  expect(res.status).toBe(200);
  const text = await res.text();
  return { text, body: JSON.parse(text) as Record<string, unknown> };
}

describe('降ろした状態の指紋は /health に載り、値は載らない', () => {
  it('profile: 置く前は無く、POST /profile の後は指紋が載り、本文は載らない', async () => {
    const app = makeApp();
    expect((await health(app)).body.profile).toBeUndefined();

    const placed = await app.request('/profile', {
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify({ script: `export GH_TOKEN=${SECRET}\n` }),
    });
    expect(placed.status).toBe(200);

    const after = await health(app);
    expect(after.body.profile).toMatchObject({ sha256: expect.any(String) });
    expect(after.text).not.toContain(SECRET);
  });

  it('mcpServers: 置く前は無く、POST /mcp-servers の後は指紋が載り、値は載らない', async () => {
    const app = makeApp();
    expect((await health(app)).body.mcpServers).toBeUndefined();

    const placed = await app.request('/mcp-servers', {
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify({
        mcpServers: {
          demo: { type: 'http', url: 'https://example.test/mcp', headers: { K: SECRET } },
        },
      }),
    });
    expect(placed.status).toBe(200);

    const after = await health(app);
    expect(after.body.mcpServers).toBeDefined();
    expect(after.text).not.toContain(SECRET);
  });
});

describe('置く口（POST）は鍵が無いと 401 で、何も置かない', () => {
  it.each([
    ['/profile', { script: `export GH_TOKEN=${SECRET}\n` }],
    ['/mcp-servers', { mcpServers: { demo: { command: 'attacker' } } }],
    ['/codex-auth', { codexAuth: { value: SECRET, revision: 'r1' } }],
  ])('POST %s', async (path, payload) => {
    const app = makeApp();
    const headers = { 'content-type': 'application/json' };

    const none = await app.request(path, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });
    const wrong = await app.request(path, {
      method: 'POST',
      headers: { ...headers, authorization: 'Bearer not-the-token' },
      body: JSON.stringify(payload),
    });

    expect(none.status).toBe(401);
    expect(wrong.status).toBe(401);
    const after = await health(app);
    expect(after.body.profile).toBeUndefined();
    expect(after.body.mcpServers).toBeUndefined();
  });
});
