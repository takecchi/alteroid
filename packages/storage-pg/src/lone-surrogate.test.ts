import type { InboxEvent } from '@alteroid/core';
import { beforeEach, describe, expect, it } from 'vitest';

import { stripNulls, type Db } from './db.js';
import { createPgStoresFromDb, type PgStores } from './index.js';
import { createMigratedTestDb } from './test-db.test-support.js';

/**
 * issue #3055。孤立サロゲート（例 `'abc\ud83d'`）は `JSON.parse('"\\ud83d"')` などで
 * JS の文字列として普通に入る。jsonb は `JSON.stringify` のエスケープ `\ud83d` を
 * `22P02` で拒むので、`stripNulls`（pg の全ストア共通の入口）が U+FFFD へ置き換えて残す。
 */
const lone = 'abc\ud83d';

describe('stripNulls — 孤立サロゲート', () => {
  it('孤立サロゲートは U+FFFD になる（上位・下位とも）', () => {
    expect(stripNulls('abc\ud83d')).toBe('abc�');
    expect(stripNulls('\ude00xyz')).toBe('�xyz');
  });
  it('正しいサロゲート対はそのまま', () => {
    expect(stripNulls('a😀b')).toBe('a😀b');
  });
  it('キーと入れ子の値も置き換える', () => {
    expect(stripNulls({ ['k\ud83d']: ['v\ud83d', { n: 1 }] })).toEqual({
      ['k�']: ['v�', { n: 1 }],
    });
  });
  it('NUL は従来どおり落とす', () => {
    expect(stripNulls('a\u0000b\ud83d')).toBe('ab�');
  });
});

describe('孤立サロゲートを含む本文（pg は jsonb が拒む。fs は通る）', () => {
  let db: Db;
  let stores: PgStores;
  beforeEach(async () => {
    ({ db } = await createMigratedTestDb());
    stores = createPgStoresFromDb(db);
  });

  it('inbox.put が落ちず、U+FFFD に置き換えて残る', async () => {
    const event: InboxEvent = {
      type: 'human_message',
      id: 'e1',
      at: '2026-01-01T00:00:00.000Z',
      conversationId: 'c',
      text: lone,
    };
    await expect(stores.inbox.put(event, event.at)).resolves.toBeUndefined();
  });
  it('commitments.open が落ちず、U+FFFD に置き換えて残る', async () => {
    const opened = await stores.commitments.open({
      id: 'c1',
      at: '2026-01-01T00:00:00.000Z',
      origin: 'human',
      source: 'c',
      body: lone,
    });
    expect(opened).toBeDefined();
    const found = (await stores.commitments.list()).entries.find((c) => c.id === 'c1');
    expect(found?.body).toBe('abc�');
  });
});
