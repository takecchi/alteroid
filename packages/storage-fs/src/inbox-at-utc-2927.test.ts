import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { InboxEvent } from '@alteroid/core';
import { beforeEach, describe, expect, it } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';

import { createFsStores } from './index.js';

/**
 * issue #2927 項目2。`inbox.put(event, at)` の外側の `at` は、fs も pg と同じ `Z` 付きの
 * ISO 表記（`new Date(at).toISOString()`）に正規化して保存する（対の歯は
 * `packages/storage-pg/src/inbox-at-utc-2927.test.ts`）。event の中の `at` は触らない。
 * 既に fs に書かれている `+09:00` のままの行は書き換えず、`compareIsoInstant` で実時刻
 * 比較するので、新しい `Z` の行と同居できる。
 */
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
    // 旧版が書いた行（オフセット付きのまま）を直接置く。
    const legacy = {
      events: [
        {
          event: event('evt-old', '2026-08-12T09:00:00+09:00'),
          at: '2026-08-12T09:00:00+09:00', // 実時刻 00:00Z
          deliveries: 0,
        },
      ],
      invalidEventsRaw: [],
    };
    const path = join(stores.paths.jobs, 'inbox.json');
    await mkdir(stores.paths.jobs, { recursive: true });
    await writeFile(path, JSON.stringify(legacy), 'utf8');
    // 実時刻では旧行（00:00Z）のほうが、新行（00:30Z）より前。文字列順だと逆になる組。
    await stores.inbox.put(event('evt-new', '2026-08-12T00:30:00Z'), '2026-08-12T00:30:00Z');
    const { entries } = await stores.inbox.peekPending();
    expect(entries.map((e) => e.event.id)).toEqual(['evt-old', 'evt-new']);
    expect(entries[0]?.at).toBe('2026-08-12T09:00:00+09:00'); // 書き換えない
    expect((await stores.inbox.pending()).oldestAt).toBe('2026-08-12T09:00:00+09:00');
    expect(JSON.parse(await readFile(path, 'utf8')).events[0].at).toBe('2026-08-12T09:00:00+09:00');
  });
});
