import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { InboxEvent } from '@alteroid/core';
import { beforeEach, describe, expect, it } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';

import { createFsStores } from './index.js';

describe('InboxStore.put() — 外側の at の表記（fs 実装）', () => {
  let stores: ReturnType<typeof createFsStores>;

  beforeEach(async () => {
    const root = await makeTempDir('alteroid-test-');
    stores = createFsStores(root);
  });

  const event = (id: string, at: string): InboxEvent => ({
    type: 'human_message',
    id,
    at,
    conversationId: 'c',
    text: id,
  });

  it('+09:00 を渡すと Z で返る（peekPending と pending().oldestAt）', async () => {
    await stores.inbox.put(
      event('evt-a', '2026-08-12T09:00:00+09:00'),
      '2026-08-12T09:00:00+09:00',
    );
    const [entry] = (await stores.inbox.peekPending()).entries;
    expect(entry?.at).toBe('2026-08-12T00:00:00.000Z');
    expect(entry?.event.at).toBe('2026-08-12T09:00:00+09:00');
    expect((await stores.inbox.pending()).oldestAt).toBe('2026-08-12T00:00:00.000Z');
  });

  it('不正な時刻は put が拒む（throw する。何も保存しない）', async () => {
    await expect(
      stores.inbox.put(event('evt-a', '2026-08-12T09:00:00+09:00'), 'not-a-date'),
    ).rejects.toThrow();
    expect((await stores.inbox.pending()).count).toBe(0);
  });

  it('既にある +09:00 のままの行は書き換えず、新しい Z の行と実時刻で並ぶ', async () => {
    const legacy = {
      events: [
        {
          event: event('evt-old', '2026-08-12T09:00:00+09:00'),
          at: '2026-08-12T09:00:00+09:00',
          deliveries: 0,
        },
      ],
      invalidEventsRaw: [],
    };
    const path = join(stores.paths.jobs, 'inbox.json');
    await mkdir(stores.paths.jobs, { recursive: true });
    await writeFile(path, JSON.stringify(legacy), 'utf8');
    await stores.inbox.put(event('evt-new', '2026-08-12T00:30:00Z'), '2026-08-12T00:30:00Z');
    const { entries } = await stores.inbox.peekPending();
    expect(entries.map((e) => e.event.id)).toEqual(['evt-old', 'evt-new']);
    expect(entries[0]?.at).toBe('2026-08-12T09:00:00+09:00');
    expect((await stores.inbox.pending()).oldestAt).toBe('2026-08-12T09:00:00+09:00');
    expect(JSON.parse(await readFile(path, 'utf8')).events[0].at).toBe('2026-08-12T09:00:00+09:00');
  });
});
