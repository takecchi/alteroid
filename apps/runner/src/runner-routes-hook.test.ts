import { createHash } from 'node:crypto';

import type { SDKMessage, query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { createRunnerHost, type RunnerHost } from '@alteroid/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { makeTempDirSync } from '../../../vitest.tmpdir.js';

import { createRunnerApp, Outbox } from './app.js';

/**
 * Issue #1852: `POST /managers`・`POST /managers/:id/resume`・
 * `POST /managers/:id/messages`・`POST /managers/:id/answers` の検査を、
 * 兄弟の経路（`POST /credentials`（PR #1791）・`POST /profile`（PR #1810）・
 * `POST /mcp-servers`）と揃える。
 *
 * 揃える前は、この4経路だけ `zValidator` に `hook` を渡していなかった——形の
 * 不正で 400 になったとき、`@hono/zod-validator` の既定は `c.json(result, 400)`
 * （`result = { success: false, error: <ZodError> }`）を返す。ここは委譲の
 * 依頼文・メッセージ・回答を運ぶ口なので、**送られてきた本文が1文字も応答へ
 * 出ないこと**をここで固定する（`credentials-hook.test.ts` / `profile-hook.test.ts`
 * と同じ形の足場）。
 *
 * ⛔ 本物の値を使わないこと——`createRunnerHost` の `env` には `PATH` だけを渡し、
 * `createCredentialStore` は使わない（この4経路は credentials/profile を経由
 * しない）。偽の目印はすべて `FAKE-` で始まる明らかな偽物だけを使う。
 */

const TOKEN = 'the-daemon-only-token';
const TOKEN_SHA256 = createHash('sha256').update(TOKEN, 'utf8').digest('hex');
const AUTH = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };

function fakeSdk(): typeof sdkQuery {
  return ((): unknown => {
    async function* generate(): AsyncGenerator<SDKMessage, void> {
      yield {
        type: 'system',
        subtype: 'init',
        session_id: 'sess-routes-hook',
        uuid: 'uuid-routes-hook',
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

/** credentials/profile を持たない、素の runner app を1つ作る。 */
function makeApp(dir: string) {
  host = createRunnerHost({
    runnerId: 'runner-primary',
    workspacePath: dir,
    emit: () => undefined,
    queryFn: fakeSdk(),
    env: { PATH: process.env.PATH ?? '' },
  });
  return createRunnerApp({ host, outbox: new Outbox(), tokenSha256: TOKEN_SHA256 });
}

describe('POST /managers の hook（#1852）', () => {
  it('形が不正な本文は、既定の400ではなく固定の理由文だけを返す', async () => {
    const dir = makeTempDirSync('alteroid-managers-hook-');
    const app = makeApp(dir);

    const res = await app.request('/managers', {
      method: 'POST',
      headers: AUTH,
      // `managerId` を欠く（必須）。偽の目印を無関係な欄に仕込む。
      body: JSON.stringify({ request: 'FAKE-do-something', cwd: '/work/project' }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as unknown;
    expect(body).toEqual({ ok: false, error: '起動命令の入力の形が不正（置いていない）' });
    const raw = JSON.stringify(body);
    expect(raw).not.toContain('FAKE-do-something');
  });

  it('正しい形は通り、cwd が返る（hook は成功時には何もしない）', async () => {
    const dir = makeTempDirSync('alteroid-managers-hook-');
    const app = makeApp(dir);

    const res = await app.request('/managers', {
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify({ managerId: 'mgr-1', request: '調べて', cwd: dir }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; cwd?: string };
    expect(body.ok).toBe(true);
  });
});

describe('POST /managers/:id/resume の hook（#1852）', () => {
  it('形が不正な本文は、既定の400ではなく固定の理由文だけを返す', async () => {
    const dir = makeTempDirSync('alteroid-resume-hook-');
    const app = makeApp(dir);

    const res = await app.request('/managers/mgr-1/resume', {
      method: 'POST',
      headers: AUTH,
      // `sessionId` を欠く（必須）。偽の目印を仕込む。
      body: JSON.stringify({
        managerId: 'mgr-1',
        cwd: '/work/project',
        request: 'FAKE-resume-request',
      }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as unknown;
    expect(body).toEqual({ ok: false, error: '再開命令の入力の形が不正（置いていない）' });
    const raw = JSON.stringify(body);
    expect(raw).not.toContain('FAKE-resume-request');
  });
});

describe('POST /managers/:id/messages の hook（#1852）', () => {
  it('形が不正な本文は、既定の400ではなく固定の理由文だけを返す', async () => {
    const dir = makeTempDirSync('alteroid-messages-hook-');
    const app = makeApp(dir);

    const res = await app.request('/managers/mgr-1/messages', {
      method: 'POST',
      headers: AUTH,
      // `text` が空文字（`.min(1)` に違反）。偽の目印を仕込む。
      body: JSON.stringify({ text: '', marker: 'FAKE-message-marker' }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as unknown;
    expect(body).toEqual({ ok: false, error: 'メッセージの入力の形が不正（置いていない）' });
    const raw = JSON.stringify(body);
    expect(raw).not.toContain('FAKE-message-marker');
  });
});

describe('POST /managers/:id/answers の hook（#1852）', () => {
  it('形が不正な本文は、既定の400ではなく固定の理由文だけを返す', async () => {
    const dir = makeTempDirSync('alteroid-answers-hook-');
    const app = makeApp(dir);

    const res = await app.request('/managers/mgr-1/answers', {
      method: 'POST',
      headers: AUTH,
      // `decision` に許されない値（`enum` 違反）。偽の目印を仕込む。
      body: JSON.stringify({
        requestId: 'req-1',
        message: 'FAKE-answer-message',
        decision: 'FAKE-not-allow-or-deny',
      }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as unknown;
    expect(body).toEqual({ ok: false, error: '回答の入力の形が不正（置いていない）' });
    const raw = JSON.stringify(body);
    expect(raw).not.toContain('FAKE-answer-message');
    expect(raw).not.toContain('FAKE-not-allow-or-deny');
  });
});

describe('POST /mcp-servers の 400（#2570）', () => {
  it('登録が投げた例外の2行目以降（束縛パラメータ等）は本文へ出さず、reasonOf の1行だけを返す', async () => {
    const dir = makeTempDirSync('alteroid-mcp-servers-400-');
    const app = makeApp(dir);
    vi.spyOn(host as RunnerHost, 'setMcpServers').mockImplementation(() => {
      throw new Error('登録できない\nparams: FAKE-secret-value');
    });

    const res = await app.request('/mcp-servers', {
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify({ mcpServers: {} }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain('登録できない');
    expect(JSON.stringify(body)).not.toContain('FAKE-secret-value');
  });
});
