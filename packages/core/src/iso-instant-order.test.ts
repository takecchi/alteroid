import { describe, expect, it } from 'vitest';

import { compareIsoInstant, earliestIsoInstant } from './iso-instant.js';
import type { Commitment, InboxEvent, PermissionGrant } from './schema.js';
import { createMemoryStores } from './testing.js';

/**
 * **issue #2451。** 許可の記録（`grantedAt`）・台帳（`at` / `closedAt`）・受信箱（`at`）
 * の fs / インメモリ実装は、オフセット付き ISO 時刻を文字列（`localeCompare` / `<`）で
 * 比べて並べていた。pg は `timestamptz` 列で実時刻を比べるので、表記の違う行で
 * 並びが食い違っていた（`AuthStore` で #1676 が塞いだのと同じ穴）。
 *
 * **同じ入力・同じ期待値の歯が3つ在る。1つで測って3つとも測ったことにしない:**
 *
 * - インメモリ — このファイル
 * - fs — `packages/storage-fs/src/iso-instant-order.test.ts`
 * - pg — `packages/storage-pg/src/iso-instant-order.test.ts`
 *
 * 入力の組は「実時刻の順」と「文字列の順」が逆になるように選んである
 * （`+09:00` 表記の 09:00 は実時刻 00:00Z で、`Z` 表記の 01:00 より前）。挿入の順も
 * 期待値と逆にしてあるので、並べ替えをしない実装も赤になる。
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

describe('compareIsoInstant / earliestIsoInstant（issue #2451）', () => {
  it('オフセット表記が違っても実時刻で比べる（文字列の順とは逆になる組）', () => {
    // 前提: 文字列では逆順になる組であること（入力の選び方そのものを確かめる）
    expect(EARLIER_JST.localeCompare(LATER_Z)).toBeGreaterThan(0);

    expect(compareIsoInstant(EARLIER_JST, LATER_Z)).toBeLessThan(0);
    expect(compareIsoInstant(LATER_Z, EARLIER_JST)).toBeGreaterThan(0);
    expect(compareIsoInstant('2026-09-27T09:00:00+09:00', '2026-09-27T00:00:00.000Z')).toBe(0);
    expect([LATER_Z, EARLIER_JST].sort(compareIsoInstant)).toEqual([EARLIER_JST, LATER_Z]);
  });

  it('earliestIsoInstant は実時刻でいちばん古いものを、渡された表記のまま返す', () => {
    expect(earliestIsoInstant([LATER_Z, EARLIER_JST])).toBe(EARLIER_JST);
    expect(earliestIsoInstant([])).toBeUndefined();
  });
});

describe('オフセット表記が混ざった時刻の並び（インメモリ実装、issue #2451）', () => {
  it('PermissionGrantStore.list は grantedAt の実時刻順', async () => {
    const stores = createMemoryStores();
    await stores.permissionGrants.put(grant('grant-later', LATER_Z));
    await stores.permissionGrants.put(grant('grant-earlier', EARLIER_JST));

    expect((await stores.permissionGrants.list()).map((g) => g.id)).toEqual([
      'grant-earlier',
      'grant-later',
    ]);
  });

  it('CommitmentStore.list は未了を at の実時刻の昇順、片付きを closedAt の実時刻の降順で返す', async () => {
    const stores = createMemoryStores();
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
    const stores = createMemoryStores();
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
