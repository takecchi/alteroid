import { runnerSessionOpenResultSchema } from '@alteroid/core';
import { describe, expect, it } from 'vitest';

import { createHttpRunner } from './runner-client.js';

/**
 * **`HttpRunner#resume()` は、runner が「生きた旧プロセスへ流しただけ」と名乗ったかを運ぶ**
 * （#2877。`runnerSessionOpenResultSchema.reusedLiveSession`）。
 *
 * 版が混ざる窓: 欄を持たない古い runner の応答は `undefined`（分からない）のまま運び、
 * `false` へ倒さない。古い daemon の zod は未知の欄を捨てるだけで落ちない。
 */

const COMMAND = {
  managerId: 'mgr-1',
  sessionId: 'sess-1',
  cwd: '/workspace',
  request: '調べて',
} as const;

function fetchResumeReplying(body: unknown): typeof fetch {
  return (async (input: string | URL | Request) => {
    const path = new URL(typeof input === 'string' ? input : input.toString()).pathname;
    if (path === '/health') return Response.json({ runnerId: 'r', workspacePath: '/workspace' });
    if (path === '/managers/mgr-1/resume') return Response.json(body);
    throw new Error(`想定していないパス: ${path}`);
  }) as typeof fetch;
}

async function resumeWith(body: unknown) {
  const client = await createHttpRunner({
    baseUrl: 'http://runner.test',
    token: 'test-runner-token',
    fetchFn: fetchResumeReplying(body),
  });
  return client.resume(COMMAND);
}

describe('HttpRunner#resume() の reusedLiveSession（#2877）', () => {
  it('欄あり true: 運ぶ', async () => {
    expect(await resumeWith({ ok: true, cwd: '/workspace', reusedLiveSession: true })).toEqual({
      cwd: '/workspace',
      reusedLiveSession: true,
    });
  });

  it('欄あり false: 運ぶ', async () => {
    expect(await resumeWith({ ok: true, cwd: '/workspace', reusedLiveSession: false })).toEqual({
      cwd: '/workspace',
      reusedLiveSession: false,
    });
  });

  it('欄なし（古い runner）: undefined のまま。false へ倒さない', async () => {
    const result = await resumeWith({ ok: true, cwd: '/workspace' });
    expect(result).toEqual({ cwd: '/workspace' });
    expect(result).not.toHaveProperty('reusedLiveSession');
  });

  it('形が崩れた欄は「分からない」として捨てる（他欄を巻き込まない）', async () => {
    expect(await resumeWith({ ok: true, cwd: '/workspace', reusedLiveSession: 'yes' })).toEqual({
      cwd: '/workspace',
    });
  });

  it('古い daemon の zod（欄を知らない形）は、欄付きの応答を落とさず読める', () => {
    const legacy = runnerSessionOpenResultSchema.pick({ ok: true, cwd: true });
    expect(legacy.safeParse({ ok: true, cwd: '/w', reusedLiveSession: true }).success).toBe(true);
  });
});
