import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { journalEntrySchema } from '@alteroid/core';
import type { CloneHost } from '@alteroid/core';
import { createFsStores } from '@alteroid/storage-fs';
import { beforeEach, describe, expect, it } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';

import { createApp } from './app.js';

const BAD_ID = 'bad-1';
const authed = { authorization: 'Bearer test-token' };

let app: ReturnType<typeof createApp>;
let stores: ReturnType<typeof createFsStores>;

beforeEach(async () => {
  const root = await makeTempDir('alteroid-journal-by-id-');
  stores = createFsStores(root);
  const journalDir = join(root, 'journal');
  await mkdir(journalDir, { recursive: true });
  const today = new Date().toISOString().slice(0, 10);
  await writeFile(
    join(journalDir, `${today}.jsonl`),
    `${JSON.stringify({ id: BAD_ID, at: `${today}T00:00:00.000Z`, type: 'no-such-type' })}\n`,
  );
  app = createApp({
    clone: {} as unknown as CloneHost,
    stores,
    token: 'test-token',
    shutdown: () => undefined,
    journalEvents: { subscribe: () => () => undefined },
  });
});

describe('GET /journal/:id', () => {
  it('在る id は 200 で、一覧の1行と同じ形の1件を全文で返す', async () => {
    const long = '長い判断の理由。'.repeat(200);
    const saved = await stores.journal.append({
      type: 'decision',
      decision: '自分で決めた',
      grounds: long,
    });

    const response = await app.request(`/journal/${saved.id}`, { headers: authed });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(journalEntrySchema.parse(body)).toEqual(saved);
    expect((body as { grounds: string }).grounds).toBe(long);
    const list = (await (await app.request('/journal?limit=10', { headers: authed })).json()) as {
      entries: unknown[];
    };
    expect(list.entries).toContainEqual(body);
  });

  it('無い id は 404（error は not found）。NUL を含む id も同じ', async () => {
    const missing = await app.request('/journal/no-such-id', { headers: authed });
    const nul = await app.request('/journal/no-such%00id', { headers: authed });

    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: 'not found' });
    expect(nul.status).toBe(404);
    expect(await nul.json()).toEqual({ error: 'not found' });
  });

  it('在るが読めない行は 409（「無い」と言わない。本文を載せない）', async () => {
    const response = await app.request(`/journal/${BAD_ID}`, { headers: authed });

    expect(response.status).toBe(409);
    const { error } = (await response.json()) as { error: string };
    expect(error).toContain(`日誌 ${BAD_ID} は在るが読めない`);
  });

  it('GET /journal/stream を id として食わない', async () => {
    const response = await app.request('/journal/stream', { headers: authed });

    expect(response.headers.get('content-type')).toContain('text/event-stream');
    await response.body?.cancel();
  });
});
