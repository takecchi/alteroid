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

const TOKEN = 'the-daemon-only-token';
const TOKEN_SHA256 = createHash('sha256').update(TOKEN, 'utf8').digest('hex');
const AUTH = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };

function fakeSdk(): typeof sdkQuery {
  return ((): unknown => {
    async function* generate(): AsyncGenerator<SDKMessage, void> {
      yield {
        type: 'system',
        subtype: 'init',
        session_id: 'sess-profile-hook',
        uuid: 'uuid-profile-hook',
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

// `env` は明示したキーだけを渡す: 既定が `process.env` で、渡し忘れると本物の環境変数（`GH_TOKEN` 等）を拾うため。
function makeApp(dir: string) {
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
  return createRunnerApp({ host, outbox: new Outbox(), tokenSha256: TOKEN_SHA256 });
}

describe('POST /profile の hook（#1806）', () => {
  it('形が不正な本文は、既定の400ではなく sanitize された理由文だけを返す', async () => {
    const dir = makeTempDirSync('alteroid-profile-hook-');
    const app = makeApp(dir);

    const res = await app.request('/profile', {
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify({ script: { leak: 'fake-profile-should-not-leak' } }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as unknown;
    expect(body).toEqual({ ok: false, error: 'プロファイルの入力の形が不正（置いていない）' });
    const raw = JSON.stringify(body);
    expect(raw).not.toContain('fake-profile-should-not-leak');
    expect(raw).not.toContain('leak');
  });

  it('script を欠いた本文も同じ固定文言だけを返す', async () => {
    const dir = makeTempDirSync('alteroid-profile-hook-');
    const app = makeApp(dir);

    const res = await app.request('/profile', {
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify({ notScript: 'fake-unrelated-value' }),
    });

    expect(res.status).toBe(400);
    const raw = await res.text();
    expect(raw).toBe(
      JSON.stringify({ ok: false, error: 'プロファイルの入力の形が不正（置いていない）' }),
    );
    expect(raw).not.toContain('fake-unrelated-value');
    expect(raw).not.toContain('notScript');
  });

  it('正しい形は通り、評価結果が返る（hook は成功時には何もしない）', async () => {
    const dir = makeTempDirSync('alteroid-profile-hook-');
    const app = makeApp(dir);

    const res = await app.request('/profile', {
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify({ script: 'echo fake-profile' }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; profile?: { sha256: string } };
    expect(body.ok).toBe(true);
    expect(body.profile?.sha256).toEqual(expect.any(String));
  });

  it('壊れたスクリプトは 200 のまま ok:false で理由を返す（hook が横取りしない）', async () => {
    const dir = makeTempDirSync('alteroid-profile-hook-');
    const app = makeApp(dir);

    const res = await app.request('/profile', {
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify({ script: 'if [ ; then' }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(false);
  });
});
