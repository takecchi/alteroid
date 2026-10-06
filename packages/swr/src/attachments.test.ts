// @vitest-environment node
/**
 * `uploadAttachment` / `fetchAttachment` / `postChat` の `attachments`（Issue #3111 段1c）。
 * 添付は生のバイト列で `application/octet-stream`、返った id を `/chat` へ渡す。
 */
import { createAlteroidClient } from '@alteroid/api-client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AttachmentGoneError, fetchAttachment, postChat, uploadAttachment } from './api';
import { json, sse, stubFetch, TEST_BASE_URL } from './test-support';

let originalFetch: typeof fetch;
beforeEach(() => {
  originalFetch = globalThis.fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});

const META = {
  id: 'att-1',
  name: 'a.png',
  mediaType: 'image/png',
  size: 3,
  sha256: 'x',
  createdAt: '2026-10-06T00:00:00Z',
  expiresAt: '2026-10-06T01:00:00Z',
};

describe('uploadAttachment', () => {
  it('生のバイト列を octet-stream で POST し、名前と型をクエリで運ぶ', async () => {
    const stub = stubFetch(() => json(META));
    const client = createAlteroidClient({ baseUrl: TEST_BASE_URL });
    const file = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' });

    const meta = await uploadAttachment(client, file, { name: 'a b.png', type: 'image/png' });

    expect(meta.id).toBe('att-1');
    const request = stub.entries[0]?.request;
    expect(request?.method).toBe('POST');
    expect(request?.headers.get('content-type')).toBe('application/octet-stream');
    const url = new URL(request?.url ?? '');
    expect(url.pathname).toBe('/attachments');
    expect(url.searchParams.get('name')).toBe('a b.png');
    expect(url.searchParams.get('type')).toBe('image/png');
    expect([...new Uint8Array(await request!.arrayBuffer())]).toEqual([1, 2, 3]);
  });

  it('413 は {error} の文を持つ ApiError で投げる', async () => {
    stubFetch(() => json({ error: '大きすぎる', code: 'too_large' }, 413));
    const client = createAlteroidClient({ baseUrl: TEST_BASE_URL });
    await expect(
      uploadAttachment(client, new Blob(['x']), { name: 'x', type: 'text/plain' }),
    ).rejects.toMatchObject({ status: 413, code: 'too_large', message: '大きすぎる' });
  });
});

describe('fetchAttachment', () => {
  it('中身を Blob で返す', async () => {
    stubFetch(
      () => new Response(new Uint8Array([9, 8]), { headers: { 'content-type': 'image/png' } }),
    );
    const client = createAlteroidClient({ baseUrl: TEST_BASE_URL });
    const blob = await fetchAttachment(client, 'att-1');
    expect(blob.size).toBe(2);
  });

  it('404 は AttachmentGoneError', async () => {
    stubFetch(() => json({ error: 'ない' }, 404));
    const client = createAlteroidClient({ baseUrl: TEST_BASE_URL });
    await expect(fetchAttachment(client, 'att-1')).rejects.toBeInstanceOf(AttachmentGoneError);
  });
});

describe('postChat の attachments', () => {
  it('id の配列を本文へ載せる（空なら載せない）', async () => {
    const stub = stubFetch(() =>
      sse([{ event: 'open', data: { conversationId: 'c1' } }], { delayMs: 0 }),
    );
    const client = createAlteroidClient({ baseUrl: TEST_BASE_URL });
    for await (const _ of postChat(client, { text: 'これ', attachments: ['att-1', 'att-2'] })) {
      void _;
    }
    for await (const _ of postChat(client, { text: 'なし', attachments: [] })) void _;
    const bodies = await Promise.all(stub.entries.map((e) => e.request?.clone().json()));
    expect(bodies[0]).toEqual({ text: 'これ', attachments: ['att-1', 'att-2'] });
    expect(bodies[1]).toEqual({ text: 'なし' });
  });
});
