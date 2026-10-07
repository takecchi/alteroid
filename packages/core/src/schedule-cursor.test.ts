import { describe, expect, it } from 'vitest';

import {
  decodeScheduleCursor,
  encodeScheduleCursor,
  resolveScheduleCursor,
} from './schedule-cursor.js';
import type { ScheduledRequest } from './schema.js';

function plan(kind: string): ScheduledRequest {
  return {
    kind,
    spec: { type: 'every', minutes: 60 },
    request: `${kind} の依頼`,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('encodeScheduleCursor / decodeScheduleCursor（部品）', () => {
  it('符号化・復号の往復で中身が保たれる', () => {
    const cursor = { kind: 'watch-001' };
    const decoded = decodeScheduleCursor(encodeScheduleCursor(cursor));
    expect(decoded).toEqual({ ok: true, cursor });
  });

  it('B2: base64 として読めない cursor は malformed', () => {
    expect(decodeScheduleCursor('這' /* base64url に無い文字 */)).toEqual({ ok: false });
  });

  it('B3: schema に合わない cursor は malformed（kind が空文字）', () => {
    const raw = Buffer.from(JSON.stringify({ kind: '' }), 'utf8').toString('base64url');
    expect(decodeScheduleCursor(raw)).toEqual({ ok: false });
  });

  it('B3: schema に合わない cursor は malformed（kind の欄が無い）', () => {
    const raw = Buffer.from(JSON.stringify({}), 'utf8').toString('base64url');
    expect(decodeScheduleCursor(raw)).toEqual({ ok: false });
  });
});

describe('resolveScheduleCursor（分岐）', () => {
  it('B1: cursor 未指定は先頭から（絞らない）', () => {
    const entries = [plan('a'), plan('b'), plan('c')];
    expect(resolveScheduleCursor(entries, undefined)).toEqual({ kind: 'ok', view: entries });
  });

  it('B2/B3を統合: 壊れた cursor は malformed', () => {
    const entries = [plan('a')];
    expect(resolveScheduleCursor(entries, 'not-a-real-cursor-at-all')).toEqual({
      kind: 'malformed',
    });
  });

  it('B4: 錨が実在すれば位置の探索でそれより後ろだけを残す', () => {
    const entries = [plan('a'), plan('b'), plan('c'), plan('d')];
    const cursor = encodeScheduleCursor({ kind: 'b' });

    expect(resolveScheduleCursor(entries, cursor)).toEqual({
      kind: 'ok',
      view: [plan('c'), plan('d')],
    });
  });

  it('B5: 錨が消えていても比較（第二の手段）で続きが決まる', () => {
    const entries = [plan('a'), plan('c'), plan('d')];
    const cursor = encodeScheduleCursor({ kind: 'b' });

    expect(resolveScheduleCursor(entries, cursor)).toEqual({
      kind: 'ok',
      view: [plan('c'), plan('d')],
    });
  });

  it('B6: cursor が最後の行を指していれば view は空（最後の頁）', () => {
    const entries = [plan('a'), plan('b')];
    const cursor = encodeScheduleCursor({ kind: 'b' });

    expect(resolveScheduleCursor(entries, cursor)).toEqual({ kind: 'ok', view: [] });
  });

  it('B7: 第二の手段は kind の昇順（比較）で残す——錨より前の kind は含めない', () => {
    const entries = [plan('a'), plan('z')];
    const cursor = encodeScheduleCursor({ kind: 'm' });

    expect(resolveScheduleCursor(entries, cursor)).toEqual({ kind: 'ok', view: [plan('z')] });
  });
});
