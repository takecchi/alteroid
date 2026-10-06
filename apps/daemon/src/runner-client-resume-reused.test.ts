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

/**
 * **`HttpRunner` は start / resume の応答のセッションの世代を運ぶ**（Issue #3170。
 * `runnerSessionOpenResultSchema.sessionGeneration`）。欄が無い・形が崩れた回は「分からない」（省く）。
 */
describe('HttpRunner の sessionGeneration（#3170）', () => {
  it('resume: 欄ありは運び、欄なし・形崩れは省く', async () => {
    expect(await resumeWith({ ok: true, sessionGeneration: 'gen-1' })).toEqual({
      sessionGeneration: 'gen-1',
    });
    expect(await resumeWith({ ok: true })).toEqual({});
    expect(await resumeWith({ ok: true, sessionGeneration: 7 })).toEqual({});
  });

  it('start: 欄ありは運び、欄なし・形崩れは省く（cwd は従来どおり）', async () => {
    const startWith = async (body: unknown) => {
      const client = await createHttpRunner({
        baseUrl: 'http://runner.test',
        token: 'test-runner-token',
        fetchFn: (async (input: string | URL | Request) => {
          const path = new URL(typeof input === 'string' ? input : input.toString()).pathname;
          if (path === '/health')
            return Response.json({ runnerId: 'r', workspacePath: '/workspace' });
          if (path === '/managers') return Response.json(body);
          throw new Error(`想定していないパス: ${path}`);
        }) as typeof fetch,
      });
      return client.start({ managerId: 'mgr-1', request: '調べて', cwd: '/workspace' });
    };
    expect(await startWith({ ok: true, cwd: '/workspace', sessionGeneration: 'gen-1' })).toEqual({
      cwd: '/workspace',
      sessionGeneration: 'gen-1',
    });
    expect(await startWith({ ok: true, cwd: '/workspace' })).toEqual({ cwd: '/workspace' });
    expect(await startWith({ ok: true, cwd: '/workspace', sessionGeneration: null })).toEqual({
      cwd: '/workspace',
    });
  });
});

/**
 * **`HttpRunner#list()`（古い daemon も使う読み口）は、`tokenFingerprint` や、まだ誰も知らない欄が
 * 付いた応答を、委譲ごと飛ばさずに読む**（#2877 PR2）。strict な schema に変えると、新しい runner の
 * 委譲が「runner に居ない」側に落ちる（`#1661`）ので、ここで落ちる形にしてある。
 */
describe('HttpRunner#list() は未知の欄が付いた応答を読む（#2877 PR2）', () => {
  it('tokenFingerprint と未知の欄が付いていても、委譲を飛ばさず、既存の欄が欠けない', async () => {
    const managers = [
      {
        managerId: 'mgr-1',
        status: 'done',
        cwd: '/workspace',
        request: '調べて',
        waiting: [],
        sessionId: 'sess-1',
        liveBackgroundTasks: 0,
        tokenFingerprint: 'aaaaaaaaaaaa',
        someFutureField: 'まだ誰も知らない欄',
      },
    ];
    const client = await createHttpRunner({
      baseUrl: 'http://runner.test',
      token: 'test-runner-token',
      fetchFn: (async (input: string | URL | Request) => {
        const path = new URL(typeof input === 'string' ? input : input.toString()).pathname;
        if (path === '/health')
          return Response.json({ runnerId: 'r', workspacePath: '/workspace' });
        if (path === '/managers') return Response.json({ managers });
        throw new Error(`想定していないパス: ${path}`);
      }) as typeof fetch,
    });

    const listed = await client.list();

    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      managerId: 'mgr-1',
      status: 'done',
      cwd: '/workspace',
      request: '調べて',
      waiting: [],
      sessionId: 'sess-1',
      liveBackgroundTasks: 0,
      tokenFingerprint: 'aaaaaaaaaaaa',
    });
  });
});
