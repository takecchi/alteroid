import { describe, expect, it } from 'vitest';

import {
  commitmentPosition,
  compareCommitmentPosition,
  decodeCommitmentCursor,
  encodeCommitmentCursor,
  resolveCommitmentCursor,
  type CommitmentCursor,
} from './commitment-cursor.js';
import type { Commitment } from './schema.js';

function open(overrides: Partial<Commitment> & Pick<Commitment, 'id' | 'at'>): Commitment {
  return {
    origin: 'self',
    body: `${overrides.id} の本文`,
    ...overrides,
  };
}

function closed(
  overrides: Partial<Commitment> & Pick<Commitment, 'id' | 'at' | 'closedAt'>,
): Commitment {
  return {
    origin: 'self',
    body: `${overrides.id} の本文`,
    closedReason: '対応済み',
    closedBy: 'clone',
    ...overrides,
  };
}

describe('commitmentPosition / compareCommitmentPosition（部品）', () => {
  it('未了（closedAt 無し）は segment: open、key は at', () => {
    const entry = open({ id: 'c-1', at: '2026-01-01T00:00:00.000Z' });
    expect(commitmentPosition(entry)).toEqual({
      segment: 'open',
      key: '2026-01-01T00:00:00.000Z',
      id: 'c-1',
    });
  });

  it('片付いた（closedAt 有り）は segment: closed、key は closedAt（at ではない）', () => {
    const entry = closed({
      id: 'c-2',
      at: '2026-01-01T00:00:00.000Z',
      closedAt: '2026-01-02T00:00:00.000Z',
    });
    expect(commitmentPosition(entry)).toEqual({
      segment: 'closed',
      key: '2026-01-02T00:00:00.000Z',
      id: 'c-2',
    });
  });

  it('open は closed より必ず前（段そのものの比較）', () => {
    const a = { segment: 'open' as const, key: '9999-12-31T23:59:59.999Z', id: 'z' };
    const b = { segment: 'closed' as const, key: '0001-01-01T00:00:00.000Z', id: 'a' };
    expect(compareCommitmentPosition(a, b)).toBeLessThan(0);
    expect(compareCommitmentPosition(b, a)).toBeGreaterThan(0);
  });

  it('open 段の中は key（at）昇順', () => {
    const a = { segment: 'open' as const, key: '2026-01-01T00:00:00.000Z', id: 'x' };
    const b = { segment: 'open' as const, key: '2026-01-02T00:00:00.000Z', id: 'y' };
    expect(compareCommitmentPosition(a, b)).toBeLessThan(0);
  });

  it('closed 段の中は key（closedAt）降順（open とは逆向き）', () => {
    const a = { segment: 'closed' as const, key: '2026-01-01T00:00:00.000Z', id: 'x' };
    const b = { segment: 'closed' as const, key: '2026-01-02T00:00:00.000Z', id: 'y' };
    expect(compareCommitmentPosition(a, b)).toBeGreaterThan(0);
    expect(compareCommitmentPosition(b, a)).toBeLessThan(0);
  });

  it('同じ segment・同じ key なら id の昇順で割る', () => {
    const a = { segment: 'open' as const, key: '2026-01-01T00:00:00.000Z', id: 'a' };
    const b = { segment: 'open' as const, key: '2026-01-01T00:00:00.000Z', id: 'b' };
    expect(compareCommitmentPosition(a, b)).toBeLessThan(0);
  });

  it('完全一致なら 0', () => {
    const a = { segment: 'open' as const, key: '2026-01-01T00:00:00.000Z', id: 'a' };
    expect(compareCommitmentPosition(a, { ...a })).toBe(0);
  });
});

describe('encodeCommitmentCursor / decodeCommitmentCursor（部品）', () => {
  it('encode したものを decode すると同じ値が戻る（往復）', () => {
    const cursor: CommitmentCursor = {
      segment: 'open',
      key: '2026-01-01T00:00:00.000Z',
      id: 'c-1',
      includeClosed: false,
      order: 'oldest',
    };
    const raw = encodeCommitmentCursor(cursor);
    const decoded = decodeCommitmentCursor(raw);
    expect(decoded).toEqual({ ok: true, cursor });
  });

  it('encode したものを decode すると同じ値が戻る（往復。origin / q を指定した場合）', () => {
    const cursor: CommitmentCursor = {
      segment: 'closed',
      key: '2026-01-01T00:00:00.000Z',
      id: 'c-1',
      includeClosed: true,
      order: 'newest',
      origin: ['human', 'manager'],
      q: 'foo',
    };
    const raw = encodeCommitmentCursor(cursor);
    const decoded = decodeCommitmentCursor(raw);
    expect(decoded).toEqual({ ok: true, cursor });
  });

  it(
    '`order` の欄を持たない（`order` を足す前に発行された）cursor は malformed にならず、' +
      '`order: "oldest"` として読める',
    () => {
      const raw = Buffer.from(
        JSON.stringify({
          segment: 'open',
          key: '2026-01-01T00:00:00.000Z',
          id: 'c-1',
          includeClosed: false,
        }),
        'utf8',
      ).toString('base64url');
      expect(decodeCommitmentCursor(raw)).toEqual({
        ok: true,
        cursor: {
          segment: 'open',
          key: '2026-01-01T00:00:00.000Z',
          id: 'c-1',
          includeClosed: false,
          order: 'oldest',
        },
      });
    },
  );

  it(
    '`origin`/`q` の欄を持たない（この変更より前に発行された）cursor は malformed にならず、' +
      '`origin: undefined` / `q: undefined`（どちらも「絞っていない」）として読める',
    () => {
      const raw = Buffer.from(
        JSON.stringify({
          segment: 'open',
          key: '2026-01-01T00:00:00.000Z',
          id: 'c-1',
          includeClosed: false,
          order: 'oldest',
        }),
        'utf8',
      ).toString('base64url');
      expect(decodeCommitmentCursor(raw)).toEqual({
        ok: true,
        cursor: {
          segment: 'open',
          key: '2026-01-01T00:00:00.000Z',
          id: 'c-1',
          includeClosed: false,
          order: 'oldest',
        },
      });
    },
  );

  it('base64url として読めない文字列は ok: false', () => {
    const brokenJson = '{not valid json';
    const raw = Buffer.from(brokenJson, 'utf8').toString('base64url');
    expect(decodeCommitmentCursor(raw)).toEqual({ ok: false });
  });

  it('JSON としては読めるが schema に合わない（id が空文字）は ok: false', () => {
    const raw = Buffer.from(
      JSON.stringify({
        segment: 'open',
        key: '2026-01-01T00:00:00.000Z',
        id: '',
        includeClosed: false,
      }),
      'utf8',
    ).toString('base64url');
    expect(decodeCommitmentCursor(raw)).toEqual({ ok: false });
  });

  it('segment が open/closed 以外は ok: false', () => {
    const raw = Buffer.from(
      JSON.stringify({
        segment: 'archived',
        key: '2026-01-01T00:00:00.000Z',
        id: 'c-1',
        includeClosed: false,
      }),
      'utf8',
    ).toString('base64url');
    expect(decodeCommitmentCursor(raw)).toEqual({ ok: false });
  });
});

describe('resolveCommitmentCursor（B1〜B10。上の対応表）', () => {
  it('B1: cursor 未指定は先頭から（絞らない）', () => {
    const entries = [
      open({ id: 'c-1', at: '2026-01-01T00:00:00.000Z' }),
      open({ id: 'c-2', at: '2026-01-02T00:00:00.000Z' }),
    ];
    const result = resolveCommitmentCursor(entries, false, undefined);
    expect(result).toEqual({ kind: 'ok', view: entries });
  });

  it('B2: base64 として読めない cursor は malformed', () => {
    const entries = [open({ id: 'c-1', at: '2026-01-01T00:00:00.000Z' })];
    const raw = Buffer.from('{broken', 'utf8').toString('base64url');
    const result = resolveCommitmentCursor(entries, false, raw);
    expect(result).toEqual({ kind: 'malformed' });
  });

  it('B3: schema に合わない cursor は malformed', () => {
    const entries = [open({ id: 'c-1', at: '2026-01-01T00:00:00.000Z' })];
    const raw = Buffer.from(JSON.stringify({ foo: 'bar' }), 'utf8').toString('base64url');
    const result = resolveCommitmentCursor(entries, false, raw);
    expect(result).toEqual({ kind: 'malformed' });
  });

  it('B4: includeClosed が食い違う cursor は明示のエラー', () => {
    const entries = [open({ id: 'c-1', at: '2026-01-01T00:00:00.000Z' })];
    const cursor = encodeCommitmentCursor({
      segment: 'open',
      key: '2026-01-01T00:00:00.000Z',
      id: 'c-1',
      includeClosed: true,
      order: 'oldest',
    });
    const result = resolveCommitmentCursor(entries, false, cursor);
    expect(result).toEqual({ kind: 'includeClosed-mismatch', cursorIncludeClosed: true });
  });

  it('B5: open 段の cursor はそれより後ろの open だけを残す', () => {
    const c1 = open({ id: 'c-1', at: '2026-01-01T00:00:00.000Z' });
    const c2 = open({ id: 'c-2', at: '2026-01-02T00:00:00.000Z' });
    const c3 = open({ id: 'c-3', at: '2026-01-03T00:00:00.000Z' });
    const entries = [c1, c2, c3];
    const cursor = encodeCommitmentCursor({
      ...commitmentPosition(c1),
      includeClosed: false,
      order: 'oldest',
    });
    const result = resolveCommitmentCursor(entries, false, cursor);
    expect(result).toEqual({ kind: 'ok', view: [c2, c3] });
  });

  it('B6: closed 段の cursor はそれより後ろの closed だけを残す', () => {
    const c1 = closed({
      id: 'c-1',
      at: '2026-01-01T00:00:00.000Z',
      closedAt: '2026-02-03T00:00:00.000Z',
    });
    const c2 = closed({
      id: 'c-2',
      at: '2026-01-02T00:00:00.000Z',
      closedAt: '2026-02-02T00:00:00.000Z',
    });
    const c3 = closed({
      id: 'c-3',
      at: '2026-01-03T00:00:00.000Z',
      closedAt: '2026-02-01T00:00:00.000Z',
    });
    const entries = [c1, c2, c3];
    const cursor = encodeCommitmentCursor({
      ...commitmentPosition(c1),
      includeClosed: true,
      order: 'oldest',
    });
    const result = resolveCommitmentCursor(entries, true, cursor);
    expect(result).toEqual({ kind: 'ok', view: [c2, c3] });
  });

  it('B7: cursor の行が消えていても位置の比較だけで続きが決まる（実在検査をしない）', () => {
    const c1 = open({ id: 'c-1', at: '2026-01-01T00:00:00.000Z' });
    const c2 = open({ id: 'c-2', at: '2026-01-02T00:00:00.000Z' });
    const c3 = open({ id: 'c-3', at: '2026-01-03T00:00:00.000Z' });
    const cursor = encodeCommitmentCursor({
      ...commitmentPosition(c1),
      includeClosed: false,
      order: 'oldest',
    });
    const result = resolveCommitmentCursor([c2, c3], false, cursor);
    expect(result).toEqual({ kind: 'ok', view: [c2, c3] });
  });

  it('B8: cursor が最後の行を指していれば view は空（最後の頁）', () => {
    const c1 = open({ id: 'c-1', at: '2026-01-01T00:00:00.000Z' });
    const c2 = open({ id: 'c-2', at: '2026-01-02T00:00:00.000Z' });
    const entries = [c1, c2];
    const cursor = encodeCommitmentCursor({
      ...commitmentPosition(c2),
      includeClosed: false,
      order: 'oldest',
    });
    const result = resolveCommitmentCursor(entries, false, cursor);
    expect(result).toEqual({ kind: 'ok', view: [] });
  });

  it('B9: 同じ key（at）の同着は id の昇順で割る', () => {
    const sameAt = '2026-01-01T00:00:00.000Z';
    const a = open({ id: 'a-first', at: sameAt });
    const b = open({ id: 'b-second', at: sameAt });
    const entries = [a, b];
    const cursor = encodeCommitmentCursor({
      ...commitmentPosition(a),
      includeClosed: false,
      order: 'oldest',
    });
    const result = resolveCommitmentCursor(entries, false, cursor);
    expect(result).toEqual({ kind: 'ok', view: [b] });
  });

  it('B10: open 段の最後を指す cursor は closed 段の先頭から続く（段を跨ぐ）', () => {
    const openLast = open({ id: 'c-open', at: '2026-01-01T00:00:00.000Z' });
    const closed1 = closed({
      id: 'c-closed-1',
      at: '2025-01-01T00:00:00.000Z',
      closedAt: '2026-02-02T00:00:00.000Z',
    });
    const closed2 = closed({
      id: 'c-closed-2',
      at: '2025-01-02T00:00:00.000Z',
      closedAt: '2026-02-01T00:00:00.000Z',
    });
    const entries = [openLast, closed1, closed2];
    const cursor = encodeCommitmentCursor({
      ...commitmentPosition(openLast),
      includeClosed: true,
      order: 'oldest',
    });
    const result = resolveCommitmentCursor(entries, true, cursor);
    expect(result).toEqual({ kind: 'ok', view: [closed1, closed2] });
  });

  it(
    'B11: order が newest の cursor はそれより古い側だけを残す' +
      '（entries は呼び出し側で新しい順に反転済みの前提）',
    () => {
      const c1 = open({ id: 'c-1', at: '2026-01-03T00:00:00.000Z' });
      const c2 = open({ id: 'c-2', at: '2026-01-02T00:00:00.000Z' });
      const c3 = open({ id: 'c-3', at: '2026-01-01T00:00:00.000Z' });
      const entries = [c1, c2, c3];
      const cursor = encodeCommitmentCursor({
        ...commitmentPosition(c1),
        includeClosed: false,
        order: 'newest',
      });
      const result = resolveCommitmentCursor(entries, false, cursor, 'newest');
      expect(result).toEqual({ kind: 'ok', view: [c2, c3] });
    },
  );

  it('order が newest のとき、oldest 方向には絞らない（向きを間違えない対照）', () => {
    const c1 = open({ id: 'c-1', at: '2026-01-03T00:00:00.000Z' });
    const c2 = open({ id: 'c-2', at: '2026-01-02T00:00:00.000Z' });
    const c3 = open({ id: 'c-3', at: '2026-01-01T00:00:00.000Z' });
    const newestFirst = [c1, c2, c3];
    const oldestFirst = [c3, c2, c1];
    const newestCursor = encodeCommitmentCursor({
      ...commitmentPosition(c1),
      includeClosed: false,
      order: 'newest',
    });
    const oldestCursor = encodeCommitmentCursor({
      ...commitmentPosition(c1),
      includeClosed: false,
      order: 'oldest',
    });
    expect(resolveCommitmentCursor(newestFirst, false, newestCursor, 'newest')).toEqual({
      kind: 'ok',
      view: [c2, c3],
    });
    expect(resolveCommitmentCursor(oldestFirst, false, oldestCursor, 'oldest')).toEqual({
      kind: 'ok',
      view: [],
    });
  });

  it('B12: order が食い違う cursor は明示のエラー', () => {
    const c1 = open({ id: 'c-1', at: '2026-01-01T00:00:00.000Z' });
    const entries = [c1];
    const cursor = encodeCommitmentCursor({
      ...commitmentPosition(c1),
      includeClosed: false,
      order: 'oldest',
    });
    const result = resolveCommitmentCursor(entries, false, cursor, 'newest');
    expect(result).toEqual({ kind: 'order-mismatch', cursorOrder: 'oldest' });
  });

  it(
    'B13: order の欄を持たない古い cursor は malformed にならず oldest として読める' +
      '（resolveCommitmentCursor を通して）',
    () => {
      const c1 = open({ id: 'c-1', at: '2026-01-01T00:00:00.000Z' });
      const c2 = open({ id: 'c-2', at: '2026-01-02T00:00:00.000Z' });
      const entries = [c1, c2];
      const legacyCursorRaw = Buffer.from(
        JSON.stringify({
          ...commitmentPosition(c1),
          includeClosed: false,
        }),
        'utf8',
      ).toString('base64url');
      const result = resolveCommitmentCursor(entries, false, legacyCursorRaw);
      expect(result).toEqual({ kind: 'ok', view: [c2] });
    },
  );

  it('B14: origin が食い違う cursor は明示のエラー', () => {
    const c1 = open({ id: 'c-1', at: '2026-01-01T00:00:00.000Z' });
    const entries = [c1];
    const cursor = encodeCommitmentCursor({
      ...commitmentPosition(c1),
      includeClosed: false,
      order: 'oldest',
      origin: ['human'],
    });
    const result = resolveCommitmentCursor(entries, false, cursor, 'oldest', ['manager']);
    expect(result).toEqual({ kind: 'origin-mismatch', cursorOrigin: ['human'] });
  });

  it('B15: q が食い違う cursor は明示のエラー', () => {
    const c1 = open({ id: 'c-1', at: '2026-01-01T00:00:00.000Z' });
    const entries = [c1];
    const cursor = encodeCommitmentCursor({
      ...commitmentPosition(c1),
      includeClosed: false,
      order: 'oldest',
      q: 'foo',
    });
    const result = resolveCommitmentCursor(entries, false, cursor, 'oldest', undefined, 'bar');
    expect(result).toEqual({ kind: 'q-mismatch', cursorQ: 'foo' });
  });

  it('B16: origin は順序・重複違いでも同じ集合なら一致（正規化）', () => {
    const c1 = open({ id: 'c-1', at: '2026-01-01T00:00:00.000Z' });
    const c2 = open({ id: 'c-2', at: '2026-01-02T00:00:00.000Z' });
    const entries = [c1, c2];
    const cursor = encodeCommitmentCursor({
      ...commitmentPosition(c1),
      includeClosed: false,
      order: 'oldest',
      origin: ['human', 'manager', 'human'],
    });
    const result = resolveCommitmentCursor(entries, false, cursor, 'oldest', ['manager', 'human']);
    expect(result).toEqual({ kind: 'ok', view: [c2] });
  });

  it('B17: q は未指定と空文字、大文字小文字の違いを同じ絞りとして扱う（正規化）', () => {
    const c1 = open({ id: 'c-1', at: '2026-01-01T00:00:00.000Z' });
    const c2 = open({ id: 'c-2', at: '2026-01-02T00:00:00.000Z' });
    const entries = [c1, c2];
    const cursorUndefinedQ = encodeCommitmentCursor({
      ...commitmentPosition(c1),
      includeClosed: false,
      order: 'oldest',
    });
    expect(
      resolveCommitmentCursor(entries, false, cursorUndefinedQ, 'oldest', undefined, ''),
    ).toEqual({ kind: 'ok', view: [c2] });
    const cursorMixedCaseQ = encodeCommitmentCursor({
      ...commitmentPosition(c1),
      includeClosed: false,
      order: 'oldest',
      q: 'Foo',
    });
    expect(
      resolveCommitmentCursor(entries, false, cursorMixedCaseQ, 'oldest', undefined, 'foo'),
    ).toEqual({ kind: 'ok', view: [c2] });
  });

  it(
    'B18: origin/q の欄を持たない古い cursor は malformed にならず、' +
      '絞っていない呼びでは続きが読める',
    () => {
      const c1 = open({ id: 'c-1', at: '2026-01-01T00:00:00.000Z' });
      const c2 = open({ id: 'c-2', at: '2026-01-02T00:00:00.000Z' });
      const entries = [c1, c2];
      const legacyCursorRaw = Buffer.from(
        JSON.stringify({
          ...commitmentPosition(c1),
          includeClosed: false,
          order: 'oldest',
        }),
        'utf8',
      ).toString('base64url');
      const result = resolveCommitmentCursor(
        entries,
        false,
        legacyCursorRaw,
        'oldest',
        undefined,
        undefined,
      );
      expect(result).toEqual({ kind: 'ok', view: [c2] });
    },
  );
});
