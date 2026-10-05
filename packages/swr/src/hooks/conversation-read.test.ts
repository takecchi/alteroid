import { describe, expect, it } from 'vitest';

import { readTargetOf } from './conversation-read';

const msg = (id: string, at: string, role: 'inbound' | 'outbound', supersededBy?: string) => ({
  id,
  at,
  role,
  text: id,
  ...(supersededBy === undefined ? {} : { supersededBy }),
});

describe('readTargetOf: 既読にする先の発言', () => {
  const T0 = '2026-08-20T00:00:00.000Z';
  const T1 = '2026-08-20T00:01:00.000Z';
  const T2 = '2026-08-20T00:02:00.000Z';

  it('最後の発言が位置より後なら、その id', () => {
    expect(
      readTargetOf({
        messages: [msg('a', T0, 'inbound'), msg('b', T2, 'outbound')],
        readThrough: T1,
        unreadCount: 1,
      }),
    ).toBe('b');
  });

  it('最後の発言が位置と同時刻・前なら送らない', () => {
    const messages = [msg('a', T0, 'inbound'), msg('b', T1, 'outbound')];
    expect(readTargetOf({ messages, readThrough: T1, unreadCount: 0 })).toBeUndefined();
    expect(readTargetOf({ messages, readThrough: T2, unreadCount: 0 })).toBeUndefined();
  });

  it('編集で畳まれた発言は最後に数えない（既定ビューで見える最後）', () => {
    expect(
      readTargetOf({
        messages: [msg('a', T0, 'inbound'), msg('b', T2, 'outbound', 'x')],
        readThrough: T0,
        unreadCount: 0,
      }),
    ).toBeUndefined();
  });

  it('発言が無ければ送らない', () => {
    expect(readTargetOf({ messages: [], readThrough: T0, unreadCount: 3 })).toBeUndefined();
  });

  it('位置が読めない（null）ときは、未読があるときだけ最後の id', () => {
    const messages = [msg('a', T0, 'outbound')];
    expect(readTargetOf({ messages, readThrough: null, unreadCount: 1 })).toBe('a');
    expect(readTargetOf({ messages, readThrough: null, unreadCount: 0 })).toBeUndefined();
  });
});
