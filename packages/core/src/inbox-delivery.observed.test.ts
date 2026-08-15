/**
 * **調査中の観測記録であって、受け入れ基準ではない。**
 *
 * 「マネージャーの報告がクローンに届かない」を (a) 経路で落ちている / (b) 届いて
 * いるが起こしていない、に切り分けるために、受信箱の各窓の実際の挙動を測った。
 * ここに固定してあるのは**いまの挙動そのもの**で、こうあるべきという主張ではない。
 * 直すと決めた時点で、この記録は「基準」に書き換えるか捨てること。
 */
import type { query as sdkQuery, Options, Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';

import { createClone } from './clone.js';
import type { InboxEvent } from './schema.js';
import { createMemoryStores } from './testing.js';

/** クローンへ渡った入力を記録するだけの偽 SDK。`delayMs` でターンを長引かせる。 */
function fakeSdk(onInput: (text: string) => void, delayMs = 0) {
  return ((params: { prompt: unknown; options?: Options }) => {
    async function* generate(): AsyncGenerator<SDKMessage, void> {
      yield {
        type: 'system',
        subtype: 'init',
        session_id: 'sess-fake',
        uuid: 'uuid-init',
      } as unknown as SDKMessage;
      for await (const message of params.prompt as AsyncIterable<{
        message: { content: unknown };
      }>) {
        onInput(String(message.message.content));
        if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
        yield {
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'ok' }] },
          parent_tool_use_id: null,
          session_id: 'sess-fake',
          uuid: 'uuid-assistant',
        } as unknown as SDKMessage;
        yield {
          type: 'result',
          subtype: 'success',
          result: 'ok',
          session_id: 'sess-fake',
          uuid: 'uuid-result',
        } as unknown as SDKMessage;
      }
    }
    const generator = generate();
    return Object.assign(generator, {
      close: () => undefined,
      interrupt: async () => undefined,
    }) as unknown as Query;
  }) as unknown as typeof sdkQuery;
}

function report(text: string): InboxEvent {
  return {
    type: 'manager_message',
    id: `evt-${text}`,
    at: new Date().toISOString(),
    managerId: 'mgr-1',
    kind: 'report',
    text,
  } as InboxEvent;
}

describe('受信箱への配達（観測）', () => {
  it('平常時は、報告がそのままクローンのターンになる', async () => {
    const seen: string[] = [];
    const clone = createClone({
      stores: createMemoryStores(),
      queryFn: fakeSdk((text) => seen.push(text)),
    });
    clone.post(report('平常'));
    await expect.poll(() => seen.some((text) => text.includes('平常')), { timeout: 3000 }).toBe(true);
    await clone.stop();
  });

  it('stop() 後に届いた報告は、記録も残らず黙って捨てられる', async () => {
    const seen: string[] = [];
    const clone = createClone({
      stores: createMemoryStores(),
      queryFn: fakeSdk((text) => seen.push(text)),
    });
    clone.post(report('起動'));
    await expect.poll(() => seen.length > 0, { timeout: 3000 }).toBe(true);
    await clone.stop();

    seen.length = 0;
    clone.post(report('停止後'));
    await new Promise((resolve) => setTimeout(resolve, 100));
    // `Clone#post` は `#stopped` なら即 return する（clone.ts）。
    expect(seen).toEqual([]);
  });

  it('ターン走行中に積まれた報告は、行儀のよい stop() なら読まれる', async () => {
    const seen: string[] = [];
    const clone = createClone({
      stores: createMemoryStores(),
      queryFn: fakeSdk((text) => seen.push(text), 200),
    });
    clone.post(report('長いターン'));
    await new Promise((resolve) => setTimeout(resolve, 30));
    clone.post(report('走行中に届いた報告'));
    await new Promise((resolve) => setTimeout(resolve, 10));

    // `Inbox#close` は積まれている分を捨てない（`next()` が queue を先に見る）ので、
    // #pump は残りを吐き切ってから終わる。**プロセスが生きている限り**は落ちない。
    await clone.stop();
    await expect
      .poll(() => seen.some((text) => text.includes('走行中に届いた報告')), { timeout: 3000 })
      .toBe(true);
  });
});
