import { createHash } from 'node:crypto';

import type { SDKMessage, query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { createRunnerHost, type RunnerHost } from '@alteroid/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

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
