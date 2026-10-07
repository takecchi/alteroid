import { createHash } from 'node:crypto';

import type { Options, Query, SDKMessage, query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { createRunnerHost, type RunnerHost } from '@alteroid/core';
import { afterEach, describe, expect, it } from 'vitest';

import { createRunnerApp, Outbox } from './app.js';

const TOKEN = 'daemon-only-token-stopping';
const TOKEN_SHA256 = createHash('sha256').update(TOKEN, 'utf8').digest('hex');

function bearer(): Record<string, string> {
  return { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };
}

interface FakeSdk {
  fn: typeof sdkQuery;
  consumed: string[];
  opened: () => number;
  releaseUsage: () => void;
}

function fakeSdk(): FakeSdk {
  const consumed: string[] = [];
  let calls = 0;
  let releaseUsage: (() => void) | null = null;
  const usageGate = new Promise<undefined>((resolve) => {
    releaseUsage = () => resolve(undefined);
  });

  const fn = ((params: { prompt: unknown; options?: Options }) => {
    calls += 1;
    let finish: (() => void) | null = null;

    async function* generate(): AsyncGenerator<SDKMessage, void> {
      yield {
        type: 'system',
        subtype: 'init',
        session_id: `sess-stopping-${String(calls)}`,
        uuid: `uuid-init-${String(calls)}`,
      } as unknown as SDKMessage;
      void (async () => {
        for await (const message of params.prompt as AsyncIterable<{
          message?: { content?: unknown };
        }>) {
          const content = message?.message?.content;
          if (typeof content === 'string') consumed.push(content);
        }
      })();
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
    }

    return Object.assign(generate(), {
      close: () => finish?.(),
      interrupt: async () => undefined,
      usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: () => usageGate,
    }) as unknown as Query;
  }) as unknown as typeof sdkQuery;

  return { fn, consumed, opened: () => calls, releaseUsage: () => releaseUsage?.() };
}

let testEpoch = 0;
afterEach(() => {
  testEpoch += 1;
});

async function waitUntil(check: () => boolean): Promise<void> {
  const epoch = testEpoch;
  for (;;) {
    if (check()) return;
    if (testEpoch !== epoch) {
      throw new Error('waitUntil: 条件が満たされないままテストが終わった');
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

// `app.request` の直後に栓を抜かない: 経路が `host.resume` に届く前に畳みが終わり、窓が閉じた状態の resume を測ってしまうため。
async function settledBeforeRelease(
  pending: (Response | Promise<Response>)[],
  ms = 200,
): Promise<void> {
  await Promise.race([Promise.all(pending), new Promise((resolve) => setTimeout(resolve, ms))]);
}

function resumeBody(managerId: string, message: string): string {
  return JSON.stringify({
    managerId,
    sessionId: 'sess-previous',
    cwd: '/work/project',
    request: '続き',
    message,
  });
}

describe('畳み中のセッションへの送信・resume（#1660）', () => {
  let hosts: RunnerHost[] = [];

  afterEach(async () => {
    await Promise.all(hosts.map((host) => host.shutdown().catch(() => undefined)));
    hosts = [];
  });

  async function openStopping(managerId: string) {
    const sdk = fakeSdk();
    const host = createRunnerHost({
      runnerId: `runner-${managerId}`,
      workspacePath: '/work/project',
      emit: () => undefined,
      queryFn: sdk.fn,
    });
    hosts.push(host);
    await host.start({ managerId, request: '最初の依頼', cwd: '/work/project' });
    await waitUntil(() => sdk.consumed.length > 0);
    const app = createRunnerApp({ host, outbox: new Outbox(), tokenSha256: TOKEN_SHA256 });
    const stopped = host.stop(managerId);
    expect(host.list().some((m) => m.managerId === managerId)).toBe(true);
    return { ...sdk, host, app, stopped };
  }

  it('送信は積まずに 404 { error: "not found" } を返す（「セッションが無い」と同じ）', async () => {
    const s = await openStopping('mgr-send');

    const res = await s.app.request('/managers/mgr-send/messages', {
      method: 'POST',
      headers: bearer(),
      body: JSON.stringify({ text: '追加の指示（畳み中に届いた）' }),
    });

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not found' });

    s.releaseUsage();
    await s.stopped;
    expect(s.consumed).toEqual(['最初の依頼']);
  });

  it('resume は畳み終わりを待ってから新しいセッションを開き、渡した一言をそこで読ませる', async () => {
    const s = await openStopping('mgr-resume');

    const pending = s.app.request('/managers/mgr-resume/resume', {
      method: 'POST',
      headers: bearer(),
      body: resumeBody('mgr-resume', '追加の一言（畳み中の resume）'),
    });
    await settledBeforeRelease([pending]);
    s.releaseUsage();
    const res = await pending;
    await s.stopped;

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      cwd: '/work/project',
      reusedLiveSession: false,
      sessionGeneration: expect.any(String),
    });
    await waitUntil(() => s.consumed.includes('追加の一言（畳み中の resume）'));
    expect(s.opened()).toBe(2);
    expect(s.host.list().filter((m) => m.managerId === 'mgr-resume')).toHaveLength(1);
  });

  it('並行した resume 2本が同じ畳み中のセッションに当たっても、新しいセッションは1本だけ開く', async () => {
    const s = await openStopping('mgr-race');

    const first = s.app.request('/managers/mgr-race/resume', {
      method: 'POST',
      headers: bearer(),
      body: resumeBody('mgr-race', '一言目'),
    });
    const second = s.app.request('/managers/mgr-race/resume', {
      method: 'POST',
      headers: bearer(),
      body: resumeBody('mgr-race', '二言目'),
    });
    await settledBeforeRelease([first, second]);
    s.releaseUsage();
    const [a, b] = await Promise.all([first, second]);
    await s.stopped;

    expect([a.status, b.status]).toEqual([200, 200]);
    const bodies = (await Promise.all([a.json(), b.json()])) as { reusedLiveSession: boolean }[];
    const reused = bodies.map((body) => body.reusedLiveSession);
    expect(reused.sort()).toEqual([false, true]);
    await waitUntil(() => s.consumed.includes('一言目') && s.consumed.includes('二言目'));
    expect(s.opened()).toBe(2);
    expect(s.host.list().filter((m) => m.managerId === 'mgr-race')).toHaveLength(1);
  });
});
