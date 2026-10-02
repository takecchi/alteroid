// @vitest-environment jsdom
/**
 * `getChatStream`（途中経過に戻る口、Issue #2652）。`postChat` と同じ形で、GET を張って
 * SSE を `{event, data}` に解く。
 */
import { createAlteroidClient } from '@alteroid/api-client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getChatStream } from './api';
import { sse, stubFetch, TEST_BASE_URL } from './test-support';

let originalFetch: typeof fetch;
beforeEach(() => {
  originalFetch = globalThis.fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('getChatStream', () => {
  it('会話 id を URL に載せて GET し、open と出来事を順に返す', async () => {
    const stub = stubFetch(() =>
      sse(
        [
          { event: 'open', data: { conversationId: 'c/1', inProgress: true } },
          { event: 'text', data: { type: 'text', text: 'こんにちは' } },
          { event: 'done', data: { type: 'done' } },
        ],
        { delayMs: 0 },
      ),
    );
    const client = createAlteroidClient({ baseUrl: TEST_BASE_URL });

    const messages = [];
    for await (const message of getChatStream(client, 'c/1')) messages.push(message);

    expect(stub.calls).toEqual([`${TEST_BASE_URL}/chat/c%2F1/stream`]);
    expect(stub.entries[0]?.request?.method).toBe('GET');
    expect(messages).toEqual([
      { event: 'open', data: { conversationId: 'c/1', inProgress: true } },
      { event: 'text', data: { type: 'text', text: 'こんにちは' } },
      { event: 'done', data: { type: 'done' } },
    ]);
  });

  it('503 は握り潰さず投げる', async () => {
    stubFetch(
      () =>
        new Response(JSON.stringify({ error: '途中経過を持たない' }), {
          status: 503,
          headers: { 'content-type': 'application/json' },
        }),
    );
    const client = createAlteroidClient({ baseUrl: TEST_BASE_URL });
    await expect(getChatStream(client, 'c1').next()).rejects.toThrow('途中経過を持たない');
  });
});
