import type { Commitment, InboxEvent, PermissionGrant } from '@alteroid/core';
import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createPgStoresFromDb, type PgStores } from './index.js';
import { createMigratedPglite } from './pglite-template.test-support.js';

/**
 * **issue #2451。** 経緯とインメモリ側の対の歯は
 * `packages/core/src/iso-instant-order.test.ts` の冒頭コメントを見よ。
 *
 * ここは pg 実装に対して同じ入力・同じ期待値を当てる（fs は
 * `packages/storage-fs/src/iso-instant-order.test.ts`）。pg は `timestamptz` 列
 * （`asc(grantedAt)` / `asc(at)` / `desc(closedAt)` / `min(at)`）で実時刻を比べる
 * ので、直す前から緑である——**3実装が同じ期待値で緑になることが、並びが揃った
 * ことの確かめである。**
 */

/** 実時刻 2026-09-27T00:00:00Z。文字列では `LATER_Z` より後ろに来る。 */
const EARLIER_JST = '2026-09-27T09:00:00+09:00';
/** 実時刻 2026-09-27T01:00:00Z。 */
const LATER_Z = '2026-09-27T01:00:00Z';
/** 実時刻 2026-09-28T00:00:00Z（片付けた時刻の組）。 */
const CLOSED_EARLIER_JST = '2026-09-28T09:00:00+09:00';
/** 実時刻 2026-09-28T01:00:00Z。 */
const CLOSED_LATER_Z = '2026-09-28T01:00:00Z';

const grant = (id: string, grantedAt: string): PermissionGrant => ({
  id,
  rule: 'Bash(gh release edit:*)',
  allows: ['gh release edit'],
  denies: [],
  approvalId: `ap-${id}`,
  answer: '許可します',
  grantedAt,
  route: { principalKind: 'account', accountId: 'acc-1' },
});

const commitment = (id: string, at: string): Commitment => ({
  id,
  at,
  origin: 'self',
  body: `依頼 ${id}`,
});

const event = (id: string, at: string): InboxEvent => ({
  type: 'human_message',
  id,
  at,
  conversationId: 'c',
  text: id,
});

let client: PGlite;
let stores: PgStores;

beforeEach(async () => {
  const migrated = await createMigratedPglite();
  client = migrated.client;
  stores = createPgStoresFromDb(migrated.db);
});

afterEach(async () => {
  await client.close();
});

describe('オフセット表記が混ざった時刻の並び（pg 実装、issue #2451）', () => {
  it('PermissionGrantStore.list は grantedAt の実時刻順', async () => {
    await stores.permissionGrants.put(grant('grant-later', LATER_Z));
    await stores.permissionGrants.put(grant('grant-earlier', EARLIER_JST));

    expect((await stores.permissionGrants.list()).map((g) => g.id)).toEqual([
      'grant-earlier',
      'grant-later',
    ]);
  });

  it('CommitmentStore.list は未了を at の実時刻の昇順、片付きを closedAt の実時刻の降順で返す', async () => {
    await stores.commitments.open(commitment('open-later', LATER_Z));
    await stores.commitments.open(commitment('open-earlier', EARLIER_JST));
    await stores.commitments.open(commitment('closed-earlier', '2026-09-26T00:00:00Z'));
    await stores.commitments.open(commitment('closed-later', '2026-09-26T00:00:00Z'));
    expect(
      await stores.commitments.close('closed-earlier', CLOSED_EARLIER_JST, '済んだ', 'clone'),
    ).toBe(true);
    expect(await stores.commitments.close('closed-later', CLOSED_LATER_Z, '済んだ', 'clone')).toBe(
      true,
    );

    expect((await stores.commitments.list()).entries.map((c) => c.id)).toEqual([
      'open-earlier',
      'open-later',
    ]);
    expect(
      (await stores.commitments.list({ includeClosed: true })).entries.map((c) => c.id),
    ).toEqual(['open-earlier', 'open-later', 'closed-later', 'closed-earlier']);
  });

  it('InboxStore の peekPending / claimPending は at の実時刻順、pending().oldestAt は実時刻で最古', async () => {
    await stores.inbox.put(event('evt-later', LATER_Z), LATER_Z);
    await stores.inbox.put(event('evt-earlier', EARLIER_JST), EARLIER_JST);

    expect((await stores.inbox.peekPending()).entries.map((e) => e.event.id)).toEqual([
      'evt-earlier',
      'evt-later',
    ]);
    const pending = await stores.inbox.pending();
    expect(pending.count).toBe(2);
    // 表記は実装ごとに違ってよい（pg は `toIso` で `Z` 表記に直す）。比べるのは実時刻
    expect(Date.parse(pending.oldestAt ?? '')).toBe(Date.parse(EARLIER_JST));
    expect((await stores.inbox.claimPending()).map((e) => e.event.id)).toEqual([
      'evt-earlier',
      'evt-later',
    ]);
  });
});
