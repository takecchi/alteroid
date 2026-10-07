import { createHash } from 'node:crypto';

import type { SDKMessage, query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { createCredentialStore, createRunnerHost, type RunnerHost } from '@alteroid/core';
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
        session_id: 'sess-cred-hook',
        uuid: 'uuid-cred-hook',
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

// `seed: {}` を明示する: 既定が `process.env` で、本物の資格情報を拾うため。
function makeApp(dir: string) {
  const credentials = createCredentialStore({
    dir: `${dir}/creds`,
    seed: {},
    names: [],
  });
  host = createRunnerHost({
    runnerId: 'runner-primary',
    workspacePath: dir,
    emit: () => undefined,
    queryFn: fakeSdk(),
    env: { PATH: process.env.PATH ?? '' },
    credentials,
  });
  return createRunnerApp({ host, outbox: new Outbox(), tokenSha256: TOKEN_SHA256 });
}

describe('POST /credentials の hook（#1790）', () => {
  it('形が不正な本文は、既定の400ではなく sanitize された理由文だけを返す', async () => {
    const dir = makeTempDirSync('alteroid-cred-hook-');
    const app = makeApp(dir);

    const res = await app.request('/credentials', {
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify({
        credentials: [{ name: 'lowercase-not-allowed', value: 'fake-secret-should-not-leak' }],
      }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as unknown;
    expect(body).toEqual({ ok: false, error: '鍵の入力の形が不正（置いていない）' });
    const raw = JSON.stringify(body);
    expect(raw).not.toContain('fake-secret-should-not-leak');
    expect(raw).not.toContain('lowercase-not-allowed');
  });

  it('同じ回に送った無関係な鍵（正しい名前・偽の値）も 400 応答へ含まれない', async () => {
    const dir = makeTempDirSync('alteroid-cred-hook-');
    const app = makeApp(dir);

    const res = await app.request('/credentials', {
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify({
        credentials: [
          { name: 'FAKE_UNRELATED_TOKEN', value: 'fake-unrelated-secret-value' },
          { name: 'not-a-valid-name', value: 'fake-x' },
        ],
      }),
    });

    expect(res.status).toBe(400);
    const raw = await res.text();
    expect(raw).not.toContain('fake-unrelated-secret-value');
    expect(raw).not.toContain('FAKE_UNRELATED_TOKEN');
    expect(raw).not.toContain('not-a-valid-name');
    expect(raw).not.toContain('fake-x');
  });

  it('128文字を超える名前は runner の受け口（wire schema）で拒み、本文へも出さない', async () => {
    const dir = makeTempDirSync('alteroid-cred-hook-');
    const app = makeApp(dir);
    const tooLong = `FAKE_${'A'.repeat(200)}`;

    const res = await app.request('/credentials', {
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify({ credentials: [{ name: tooLong, value: 'fake-token' }] }),
    });

    expect(res.status).toBe(400);
    const raw = await res.text();
    expect(raw).not.toContain(tooLong);
    expect(raw).not.toContain('fake-token');
  });

  it('正しい形は通り、指紋だけが返る（hook は成功時には何もしない）', async () => {
    const dir = makeTempDirSync('alteroid-cred-hook-');
    const app = makeApp(dir);

    const res = await app.request('/credentials', {
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify({ credentials: [{ name: 'FAKE_TOKEN', value: 'fake-value-xyz' }] }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; credentials: { name: string }[] };
    expect(body.ok).toBe(true);
    expect(body.credentials.map((entry) => entry.name)).toEqual(['FAKE_TOKEN']);
    expect(JSON.stringify(body)).not.toContain('fake-value-xyz');
  });
});
