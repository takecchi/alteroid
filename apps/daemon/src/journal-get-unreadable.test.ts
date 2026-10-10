import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { CloneHost } from '@alteroid/core';
import { createFsStores } from '@alteroid/storage-fs';
import { beforeEach, describe, expect, it } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';

import { createApp } from './app.js';

const BAD_ID = 'bad-1';
const json = (body: unknown) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

let root: string;
let app: ReturnType<typeof createApp>;
let stores: ReturnType<typeof createFsStores>;

beforeEach(async () => {
  root = await makeTempDir('alteroid-journal-get-unreadable-');
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
  });
});

describe('POST /conversations/:id/read — through が読めない行（issue #3288）', () => {
  it('在るが読めない through は 409（error は「在るが読めない」）。無い through は 404', async () => {
    const unreadable = await app.request('/conversations/c1/read', json({ through: BAD_ID }));
    const missing = await app.request('/conversations/c1/read', json({ through: 'no-such-id' }));

    expect(unreadable.status).toBe(409);
    expect(((await unreadable.json()) as { error: string }).error).toContain('在るが読めない');
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as { error: string }).error).toContain('見つからない');
  });
});

describe('POST /chat — supersedes が読めない行（issue #3288）', () => {
  it('在るが読めない supersedes は 409。無い supersedes は 400。どちらも何も積まない', async () => {
    // 在る会話へしか送れない。種は `before` を取る前に置く（「何も積まない」は種より後の差で測る）。
    await stores.journal.append({
      type: 'exchange',
      with: 'human',
      role: 'outbound',
      text: '(種)',
      conversationId: 'c1',
    });
    const before = await readFile(
      join(root, 'journal', `${new Date().toISOString().slice(0, 10)}.jsonl`),
      'utf8',
    );

    const unreadable = await app.request(
      '/chat',
      json({ text: '直した本文', conversationId: 'c1', supersedes: BAD_ID }),
    );
    const missing = await app.request(
      '/chat',
      json({ text: '直した本文', conversationId: 'c1', supersedes: 'no-such-id' }),
    );

    expect(unreadable.status).toBe(409);
    expect(((await unreadable.json()) as { error: string }).error).toContain('在るが読めない');
    expect(missing.status).toBe(400);
    expect(((await missing.json()) as { error: string }).error).toContain('見つからない');
    const after = await readFile(
      join(root, 'journal', `${new Date().toISOString().slice(0, 10)}.jsonl`),
      'utf8',
    );
    expect(after).toBe(before);
  });
});
