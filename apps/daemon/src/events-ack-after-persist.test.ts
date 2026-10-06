/**
 * Issue #3679。`POST /events`・`POST /events/:source` は、受信箱への永続化ができたときだけ 200 を返す。
 * 書けなかったときは 503 を返し、**受信箱のメモリにも積まない**（積むと、503 を受けた相手の送り直しと
 * 二重に届く）。**本物の `createClone`（偽 SDK のみ差し替え）と本物の `createApp`** を組み、受信箱の
 * `put` だけを失敗させる器で測る。拾い直しの待ち（200ms の線形）は偽の `setTimeout` で進め、実時間は待たない。
 */
import type { Options, Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import {
  ALWAYS_REDELIVER,
  captureStderr,
  createClone,
  createLocalRunner,
  createMemoryStores,
  createRunnerRegistry,
  type InboxEvent,
} from '@alteroid/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createApp } from './app.js';

const OPERATOR = { authorization: 'Bearer test-token', 'content-type': 'application/json' };

afterEach(() => vi.useRealTimers());

function recordingSdk(inputs: string[]): typeof import('@anthropic-ai/claude-agent-sdk').query {
  return ((params: { prompt: unknown; options?: Options }) => {
    async function* generate(): AsyncGenerator<SDKMessage, void> {
      yield {
        type: 'system',
        subtype: 'init',
        session_id: 's',
        uuid: 'u-init',
        model: 'claude-fake',
        claude_code_version: '9.9.9',
        apiKeySource: 'user',
        permissionMode: 'default',
        mcp_servers: [],
      } as unknown as SDKMessage;
      const prompt = params.prompt;
      if (typeof prompt === 'string') return;
      let n = 0;
      for await (const message of prompt as AsyncIterable<{ message: { content: unknown } }>) {
        const content = message.message.content;
        inputs.push(typeof content === 'string' ? content : JSON.stringify(content));
        n += 1;
        yield {
          type: 'assistant',
          message: { content: [{ type: 'text', text: '見た' }] },
          parent_tool_use_id: null,
          session_id: 's',
          uuid: `u-a-${n}`,
        } as unknown as SDKMessage;
        yield {
          type: 'result',
          subtype: 'success',
          result: '見た',
          session_id: 's',
          uuid: `u-r-${n}`,
        } as unknown as SDKMessage;
      }
    }
    return Object.assign(generate(), {
      close: () => undefined,
      interrupt: async () => undefined,
    }) as unknown as Query;
  }) as unknown as typeof import('@anthropic-ai/claude-agent-sdk').query;
}

function setup() {
  const base = createMemoryStores();
  const control = { failing: false, putAttempts: 0 };
  const inbox = new Proxy(base.inbox, {
    get(target, key) {
      if (key === 'put') {
        return async (event: InboxEvent, at: string) => {
          control.putAttempts += 1;
          if (control.failing) throw new Error('inbox 書き込み失敗（テスト）');
          return target.put(event, at);
        };
      }
      const value = Reflect.get(target, key, target) as unknown;
      return typeof value === 'function' ? (value as () => unknown).bind(target) : value;
    },
  });
  const stores = { ...base, inbox };
  const inputs: string[] = [];
  const queryFn = recordingSdk(inputs);
  const clone = createClone({
    stores,
    queryFn,
    env: {},
    runners: createRunnerRegistry([
      createLocalRunner({ workspacePath: '/work', queryFn, env: {} }),
    ]),
    redeliveryGate: ALWAYS_REDELIVER,
  });
  const app = createApp({ clone, stores, token: 'test-token', shutdown: () => undefined });
  return { app, base, control, inputs };
}
type Setup = ReturnType<typeof setup>;

const sendEvent = (s: Setup, mark: string) =>
  s.app.request('/events', {
    method: 'POST',
    headers: OPERATOR,
    body: JSON.stringify({ source: 'ci.main', payload: { mark } }),
  });
const sendWebhook = (s: Setup, mark: string) =>
  s.app.request('/events/ci.main', {
    method: 'POST',
    headers: OPERATOR,
    body: JSON.stringify({ mark }),
  });

/** 偽の `setTimeout` を進めながら、拾い直しの待ちが終わるまで応答を待つ（実時間は待たない）。 */
async function settle(request: Promise<Response>): Promise<Response> {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const response = request.then((r) => r);
  await vi.advanceTimersByTimeAsync(10_000);
  const result = await response;
  vi.useRealTimers();
  return result;
}

/** 続けて送る /chat が閉じたとき、先に積まれた合図のターンは済んでいる（ターンは直列）。 */
async function flushWithChat(s: Setup): Promise<void> {
  const res = await s.app.request('/chat', {
    method: 'POST',
    headers: OPERATOR,
    body: JSON.stringify({ text: '区切り' }),
  });
  await res.text();
}

describe('POST /events・/events/:source は、受信箱へ永続化できたときだけ 200 を返す', () => {
  for (const [label, send] of [
    ['/events', (s: Setup, mark: string) => sendEvent(s, mark)],
    ['/events/:source', (s: Setup, mark: string) => sendWebhook(s, mark)],
  ] as const) {
    it(`${label}: 受信箱の書き込みが失敗したら 503 を返し、メモリにも積まない`, async () => {
      const s = setup();
      s.control.failing = true;
      let response!: Response;
      await captureStderr(async () => {
        response = await settle(send(s, 'lost-1'));
      });
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: expect.any(String) });
      expect(await s.base.inbox.pending()).toEqual({ count: 0 });

      // 相手が送り直す（器は直った）→ 届くのは1回だけ。最初の送信が裏で配達されていれば2回になる。
      s.control.failing = false;
      const retried = await send(s, 'retry-1');
      expect(retried.status).toBe(200);
      await flushWithChat(s);
      const delivered = s.inputs.filter((input) => input.includes('外部から出来事が届いた'));
      expect(delivered).toHaveLength(1);
      expect(delivered[0]).toContain('retry-1');
      expect(s.inputs.join('\n')).not.toContain('lost-1');
    });

    it(`${label}: 書けたときは 200 と { ok, id } を返し、応答の時点で受信箱の行が在る`, async () => {
      const s = setup();
      const response = await send(s, 'kept-1');
      expect(response.status).toBe(200);
      const body = (await response.json()) as { ok: boolean; id: string };
      expect(body.ok).toBe(true);
      // 配達が済む前に応答が返る場合でも、済んだ後でも「行が在った」ことは putAttempts で測る。
      expect(s.control.putAttempts).toBeGreaterThanOrEqual(1);
      await flushWithChat(s);
      expect(s.inputs.some((input) => input.includes('kept-1'))).toBe(true);
    });
  }

  it('書き込みが一度だけ失敗しても、拾い直しで書けたなら 200 を返す', async () => {
    const s = setup();
    s.control.failing = true;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const response = sendEvent(s, 'blip-1');
    await vi.advanceTimersByTimeAsync(0);
    s.control.failing = false;
    await vi.advanceTimersByTimeAsync(10_000);
    const result = await response;
    vi.useRealTimers();
    expect(result.status).toBe(200);
  });
});
