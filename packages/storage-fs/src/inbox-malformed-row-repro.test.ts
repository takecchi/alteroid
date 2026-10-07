import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { captureStderr } from '@alteroid/core';
import type { InboxEvent } from '@alteroid/core';
import { beforeEach, describe, expect, it } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';

import { createFsStores } from './index.js';

describe('FsInboxStore — inbox.json の不正な1行を読み飛ばす（issue #1966）', () => {
  let root: string;
  let inboxPath: string;

  const GOOD_EVENT = {
    type: 'human_message',
    id: 'evt-good',
    at: '2026-09-28T00:00:00.000Z',
    text: '正しい合図の本文',
    conversationId: 'conv-1',
  } as unknown as InboxEvent;

  const BAD_ROW_RAW = {
    event: {
      type: 'not-a-real-event-type',
      id: 'evt-bad',
      text: '壊れた合図の本文（跡に出てはいけない）',
    },
    at: '2026-09-27T00:00:00.000Z',
    deliveries: 0,
  };

  beforeEach(async () => {
    root = await makeTempDir('alteroid-test-');
    inboxPath = join(root, 'jobs', 'inbox.json');
  });

  async function writeRawInboxFile(): Promise<ReturnType<typeof createFsStores>> {
    const stores = createFsStores(root);
    await stores.inbox.put(GOOD_EVENT, '2026-09-28T00:00:00.000Z');
    const raw = JSON.parse(await readFile(inboxPath, 'utf8')) as { events: unknown[] };
    raw.events.push(BAD_ROW_RAW);
    await writeFile(inboxPath, `${JSON.stringify(raw, null, 2)}\n`);
    return stores;
  }

  async function rawEventIds(): Promise<unknown[]> {
    const raw = JSON.parse(await readFile(inboxPath, 'utf8')) as {
      events: { event?: { id?: unknown } }[];
    };
    return raw.events.map((row) => row.event?.id);
  }

  it('peekPending() は正しい行だけを返し、stderr に id だけの跡を残す', async () => {
    const stores = await writeRawInboxFile();
    let ids: string[] = [];
    const stderr = (
      await captureStderr(async () => {
        ids = (await stores.inbox.peekPending()).entries.map((pending) => pending.event.id);
      })
    ).join('');
    expect(ids).toEqual(['evt-good']);
    expect(stderr).toContain('evt-bad');
    expect(stderr, '壊れた行の本文そのものは跡に出さない').not.toContain('壊れた合図の本文');
  });

  it('peekPending() は読めない行を unreadable に id・受信時刻・不正な欄名だけで返す（本文は載せない）', async () => {
    const stores = await writeRawInboxFile();
    let peek: Awaited<ReturnType<typeof stores.inbox.peekPending>> | undefined;
    await captureStderr(async () => {
      peek = await stores.inbox.peekPending();
    });
    expect(peek?.unreadable).toEqual([
      { id: 'evt-bad', at: '2026-09-27T00:00:00.000Z', reason: '不正な欄: event.type' },
    ]);
    expect(JSON.stringify(peek), '壊れた行の本文そのものは載せない').not.toContain(
      '壊れた合図の本文',
    );
    const count = (await stores.inbox.pending()).count;
    expect((peek?.entries.length ?? 0) + (peek?.unreadable.length ?? 0)).toBe(count);
  });

  it('壊れた行しか無い受信箱でも、peekPending() は entries が空・unreadable が1件になる（空とは言わない）', async () => {
    const stores = createFsStores(root);
    await stores.inbox.put(GOOD_EVENT, '2026-09-28T00:00:00.000Z');
    await stores.inbox.remove('evt-good');
    const raw = JSON.parse(await readFile(inboxPath, 'utf8')) as { events: unknown[] };
    raw.events.push(BAD_ROW_RAW);
    await writeFile(inboxPath, `${JSON.stringify(raw, null, 2)}\n`);
    let peek: Awaited<ReturnType<typeof stores.inbox.peekPending>> | undefined;
    await captureStderr(async () => {
      peek = await stores.inbox.peekPending();
    });
    expect(peek?.entries).toEqual([]);
    expect(peek?.unreadable).toHaveLength(1);
  });

  it('claimPending() も正しい行だけを配り、壊れた行はファイルに生の形のまま残る', async () => {
    const stores = await writeRawInboxFile();
    let ids: string[] = [];
    await captureStderr(async () => {
      ids = (await stores.inbox.claimPending()).map((pending) => pending.event.id);
    });
    expect(ids).toEqual(['evt-good']);
    expect(await rawEventIds()).toEqual(expect.arrayContaining(['evt-good', 'evt-bad']));
  });

  it('put() / remove() も落ちず、壊れた行は書き戻しで残る', async () => {
    const stores = await writeRawInboxFile();
    await captureStderr(async () => {
      await stores.inbox.put(
        { ...GOOD_EVENT, id: 'evt-new' } as unknown as InboxEvent,
        '2026-09-28T01:00:00.000Z',
      );
      await stores.inbox.remove('evt-good');
    });
    expect((await rawEventIds()).sort()).toEqual(['evt-bad', 'evt-new']);
  });

  it('removeMany() は id で名指しされた読めない行も消し、戻り値に入れる（pg と同じ）', async () => {
    const stores = await writeRawInboxFile();
    let removed: string[] = [];
    await captureStderr(async () => {
      removed = await stores.inbox.removeMany(['evt-bad']);
    });
    expect(removed).toEqual(['evt-bad']);
    expect(await rawEventIds()).toEqual(['evt-good']);
    expect((await stores.inbox.pending()).count).toBe(1);
  });

  it('remove() も id で名指しされた読めない行を消し、名指しされない行は残す', async () => {
    const stores = await writeRawInboxFile();
    await captureStderr(async () => {
      await stores.inbox.remove('evt-bad');
    });
    expect(await rawEventIds()).toEqual(['evt-good']);
  });

  it('removeMany() は読めた行と読めない行を1回で消し、無い id は戻り値に入れない', async () => {
    const stores = await writeRawInboxFile();
    let removed: string[] = [];
    await captureStderr(async () => {
      removed = await stores.inbox.removeMany(['evt-bad', 'evt-good', 'evt-none', 'evt-bad']);
    });
    expect(removed.sort()).toEqual(['evt-bad', 'evt-good']);
    expect(await rawEventIds()).toEqual([]);
  });

  it('pending() は壊れた行も件数に数える（pg の count(*) と同じ）', async () => {
    const stores = await writeRawInboxFile();
    let count = -1;
    await captureStderr(async () => {
      count = (await stores.inbox.pending()).count;
    });
    expect(count).toBe(2);
  });

  it('clear() は壊れた行も消して件数に数える（pg の DELETE … RETURNING と同じ）', async () => {
    const stores = await writeRawInboxFile();
    let removed = -1;
    await captureStderr(async () => {
      removed = await stores.inbox.clear();
    });
    expect(removed).toBe(2);
    expect(await rawEventIds()).toEqual([]);
  });

  it('対照: 壊れた行が無ければ今までどおり読み、跡も出さない', async () => {
    const stores = createFsStores(root);
    await stores.inbox.put(GOOD_EVENT, '2026-09-28T00:00:00.000Z');
    let ids: string[] = [];
    const stderr = (
      await captureStderr(async () => {
        ids = (await stores.inbox.peekPending()).entries.map((pending) => pending.event.id);
      })
    ).join('');
    expect(ids).toEqual(['evt-good']);
    expect(stderr).toBe('');
  });

  it('対照: 壊れた行が無ければ unreadable は空（0件の値を作らないのは上の層の仕事）', async () => {
    const stores = createFsStores(root);
    await stores.inbox.put(GOOD_EVENT, '2026-09-28T00:00:00.000Z');
    expect((await stores.inbox.peekPending()).unreadable).toEqual([]);
  });
});
