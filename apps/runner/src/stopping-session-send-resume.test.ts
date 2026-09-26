import { createHash } from 'node:crypto';

import type { Options, Query, SDKMessage, query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { createRunnerHost, type RunnerHost } from '@alteroid/core';
import { afterEach, describe, expect, it } from 'vitest';

import { createRunnerApp, Outbox } from './app.js';

/**
 * **畳み中のセッションへの送信・resume を、黙って捨てない**（#1660）。
 *
 * `RunnerSession#stop()` の中身（`#stopBody`）は最初に `markStopped()` を呼ぶが、
 * `RunnerHost` の名簿から消える（`#onClosed()`）のは、いくつもの await の後である。
 * この窓の間に届いた送信は `push()` が黙って捨てるのに 200 `{ ok: true }` を返し、
 * resume は doc の「追加の一言だけを流す」を果たさないまま 200 を返していた。
 *
 * **窓は決定的に開ける。** `#flushUsage()` が読む usage の Promise を握ったまま
 * にして、`#stopBody` を `markStopped()` の直後・`#onClosed()` の手前で止める
 * （固定回数の microtask で決め打ちすると、それ自体が「測ったつもり」になる）。
 * 偽の SDK の入力ループが実際に読んだ本文を記録して、誰が読んだかを直接見る。
 */

const TOKEN = 'daemon-only-token-stopping';
const TOKEN_SHA256 = createHash('sha256').update(TOKEN, 'utf8').digest('hex');

function bearer(): Record<string, string> {
  return { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };
}

interface FakeSdk {
  fn: typeof sdkQuery;
  /** 入力ストリームから実際に読み出された（＝誰かが読んだ）本文の列。 */
  consumed: string[];
  /** 偽の SDK が呼ばれた回数（＝開いたセッションの数）。 */
  opened: () => number;
  /** `#flushUsage()` の内部の await を解放する栓。呼ぶまで `#stopBody` はそこで止まる。 */
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

async function waitUntil(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (check()) return;
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitUntil: ${String(timeoutMs)}ms 以内に条件が満たされなかった`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
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
    // `markStopped()` は同期に走り、`#stopBody` は栓（usage）で止まる。名簿にはまだ居る。
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

    // resume は畳み終わりを待つので、栓を抜く前に応答は返らない。
    const pending = s.app.request('/managers/mgr-resume/resume', {
      method: 'POST',
      headers: bearer(),
      body: resumeBody('mgr-resume', '追加の一言（畳み中の resume）'),
    });
    s.releaseUsage();
    const res = await pending;
    await s.stopped;

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
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
    s.releaseUsage();
    const [a, b] = await Promise.all([first, second]);
    await s.stopped;

    expect([a.status, b.status]).toEqual([200, 200]);
    await waitUntil(() => s.consumed.includes('一言目') && s.consumed.includes('二言目'));
    expect(s.opened()).toBe(2);
    expect(s.host.list().filter((m) => m.managerId === 'mgr-race')).toHaveLength(1);
  });
});
