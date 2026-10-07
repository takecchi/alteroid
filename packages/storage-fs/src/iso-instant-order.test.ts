import type { Commitment, InboxEvent, PermissionGrant } from '@alteroid/core';
import { beforeEach, describe, expect, it } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';

import { CLOSED_HISTORY_LIMIT, createFsStores } from './index.js';

const EARLIER_JST = '2026-09-27T09:00:00+09:00';
const LATER_Z = '2026-09-27T01:00:00Z';
const CLOSED_EARLIER_JST = '2026-09-28T09:00:00+09:00';
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

describe('オフセット表記が混ざった時刻の並び（fs 実装、issue #2451）', () => {
  let stores: ReturnType<typeof createFsStores>;

  beforeEach(async () => {
    const root = await makeTempDir('alteroid-test-');
    stores = createFsStores(root);
  });

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
    expect(Date.parse(pending.oldestAt ?? '')).toBe(Date.parse(EARLIER_JST));
    expect((await stores.inbox.claimPending()).map((e) => e.event.id)).toEqual([
      'evt-earlier',
      'evt-later',
    ]);
  });

  it('片付き行の切り詰めは closedAt の実時刻で新しいほうを残す', { timeout: 120_000 }, async () => {
    await stores.commitments.open(commitment('oldest-z', '2026-09-26T00:00:00Z'));
    expect(
      await stores.commitments.close('oldest-z', '2026-09-28T01:00:00Z', '済んだ', 'clone'),
    ).toBe(true);
    for (let i = 0; i < CLOSED_HISTORY_LIMIT; i += 1) {
      const id = `newer-minus5-${i}`;
      await stores.commitments.open(commitment(id, '2026-09-26T00:00:00Z'));
      const minute = String(Math.floor(i / 60)).padStart(2, '0');
      const second = String(i % 60).padStart(2, '0');
      expect(
        await stores.commitments.close(
          id,
          `2026-09-28T00:${minute}:${second}-05:00`,
          '済んだ',
          'clone',
        ),
      ).toBe(true);
    }

    const listed = await stores.commitments.list({ includeClosed: true });
    const ids = listed.entries.map((c) => c.id);
    expect(ids).toHaveLength(CLOSED_HISTORY_LIMIT);
    expect(ids).toContain('newer-minus5-0');
    expect(ids).not.toContain('oldest-z');
    expect(listed.trimmedClosed).toBe(1);
  });
});
