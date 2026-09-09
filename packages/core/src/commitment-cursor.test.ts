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

/**
 * `resolveCommitmentCursor`（`commitment_list` 一覧モードの継続点）の分岐対応表。
 *
 * **基準は PR #638（`apps/daemon/src/runner-swap-notice.ts` /
 * `decideRunnerSwapNotice`）。** 判定を I/O 無しの純関数へ切り出し、分岐を
 * B1〜B10 と数え上げてそれぞれに歯を1本ずつ通す、という形をここでも踏む。
 *
 * | 分岐 | 内容 | 歯 |
 * | --- | --- | --- |
 * | B1 | `cursorRaw === undefined` → 絞らない（先頭から） | `B1: cursor 未指定は先頭から（絞らない）` |
 * | B2 | base64 として読めない | `B2: base64 として読めない cursor は malformed` |
 * | B3 | base64/JSON としては読めるが schema に合わない | `B3: schema に合わない cursor は malformed` |
 * | B4 | `includeClosed` が食い違う | `B4: includeClosed が食い違う cursor は明示のエラー` |
 * | B5 | 有効な cursor（open 段） | `B5: open 段の cursor はそれより後ろの open だけを残す` |
 * | B6 | 有効な cursor（closed 段） | `B6: closed 段の cursor はそれより後ろの closed だけを残す` |
 * | B7 | cursor が指す行が現在の一覧に実在しない（閉じた／削除された） | `B7: cursor の行が消えていても位置の比較だけで続きが決まる` |
 * | B8 | cursor が一覧の末尾を指す | `B8: cursor が最後の行を指していれば view は空（最後の頁）` |
 * | B9 | 同じ key（`at`/`closedAt`）を持つ行が複数在る（同着） | `B9: 同じ key の同着は id の昇順で割る` |
 * | B10 | cursor が open 段の最後を指し、closed 段を含む一覧を読む | `B10: open 段の最後を指す cursor は closed 段の先頭から続く（段を跨ぐ）` |
 * | B11 | `order: 'newest'` の有効な cursor | `B11: order が newest の cursor はそれより古い側だけを残す（entries は呼び出し側で反転済みの前提）` |
 * | B12 | `order` が食い違う | `B12: order が食い違う cursor は明示のエラー` |
 * | B13 | `order` の欄を持たない（足す前に発行された）cursor | `B13: order の欄を持たない古い cursor は malformed にならず oldest として読める` |
 *
 * `commitmentPosition` / `compareCommitmentPosition` / `encodeCommitmentCursor` /
 * `decodeCommitmentCursor` は、上の分岐を組み立てるための部品として個別にも
 * 直接触る（「部品が正しい」と「組み合わせが正しい」は別の観測なので、
 * どちらも歯を持つ）。
 */

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
    // b（新しい closedAt）のほうが先——open の昇順とは逆。
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

  it(
    '`order` の欄を持たない（`order` を足す前に発行された）cursor は malformed にならず、' +
      '`order: "oldest"` として読める',
    () => {
      // **`order` を足す前の世界を模す。** `commitmentCursorSchema` へ
      // `order` を足す前に発行されたカーソルは、JSON に `order` の欄その
      // ものを持たない。`z.enum(['oldest', 'newest']).default('oldest')`
      // にした理由はこれ——default 無しの `z.enum` なら、この JSON は
      // schema に合わず `decodeCommitmentCursor` が `{ ok: false }`
      // （malformed）を返し、まだ使われていただけの既発行カーソルが
      // この変更のせいで一斉に「壊れている」へ化ける。
      const raw = Buffer.from(
        JSON.stringify({
          segment: 'open',
          key: '2026-01-01T00:00:00.000Z',
          id: 'c-1',
          includeClosed: false,
          // `order` を意図的に書かない。
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
    // decode は JSON.parse(Buffer.from(raw, 'base64url')) を試みる。
    // 制御文字混じりでも Buffer.from 自体は例外を投げない場合があるため、
    // 「JSON として壊れている」ことを保証する形（波括弧の対応が壊れた
    // base64url をあえて作る）で確かめる。
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
    // closed は closedAt 降順で並んでいる前提（呼び出し側の contract）。
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
    // c1 を指す cursor を作った後、c1 自身は「もう一覧に無い」状態
    // （閉じられて別の絞り込みから落ちた／削除された、を模す）にして渡す。
    const c1 = open({ id: 'c-1', at: '2026-01-01T00:00:00.000Z' });
    const c2 = open({ id: 'c-2', at: '2026-01-02T00:00:00.000Z' });
    const c3 = open({ id: 'c-3', at: '2026-01-03T00:00:00.000Z' });
    const cursor = encodeCommitmentCursor({
      ...commitmentPosition(c1),
      includeClosed: false,
      order: 'oldest',
    });
    // entries には c1 を含めない——それでも c1 の「位置」より後ろの c2/c3 は
    // 正しく残る（id の実在ではなく key の比較で決まるため）。
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
    // a（id 昇順で先）の後ろは b だけ。
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
    // CommitmentStore.list の契約どおり open → closed の順に連結された状態。
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
      // **`tools.ts` の契約: `order: 'newest'` のとき、呼び出し側が
      // `entries` を反転させてから渡す。** ここではその前提どおり、
      // 「新しい順（at 降順）」に並んだ配列をそのまま渡す——この関数自身は
      // 並べ替えない（`CommitmentStore.list` の契約を変えないという設計、
      // `resolveCommitmentCursor` の doc）。
      const c1 = open({ id: 'c-1', at: '2026-01-03T00:00:00.000Z' }); // 最新
      const c2 = open({ id: 'c-2', at: '2026-01-02T00:00:00.000Z' });
      const c3 = open({ id: 'c-3', at: '2026-01-01T00:00:00.000Z' }); // 最古
      const entries = [c1, c2, c3]; // 新しい順。
      const cursor = encodeCommitmentCursor({
        ...commitmentPosition(c1),
        includeClosed: false,
        order: 'newest',
      });
      const result = resolveCommitmentCursor(entries, false, cursor, 'newest');
      // c1（最新）の次（＝より古い側）は c2, c3。
      expect(result).toEqual({ kind: 'ok', view: [c2, c3] });
    },
  );

  it('order が newest のとき、oldest 方向には絞らない（向きを間違えない対照）', () => {
    // **B11 と対になる対照。** 同じ cursor・同じ entries で `order` の
    // 引数だけを変えると、残る側が入れ替わることを確かめる——「件数が
    // 変わらないだけ」の歯（既定でも通ってしまう）にしないため。
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
    // 同じ pivot（c1）でも order が oldest なら、c1 より後ろ（より新しい
    // 側）を残す——c1 が最新なので、残るものは無い。
    expect(resolveCommitmentCursor(oldestFirst, false, oldestCursor, 'oldest')).toEqual({
      kind: 'ok',
      view: [],
    });
  });

  it('B12: order が食い違う cursor は明示のエラー', () => {
    const c1 = open({ id: 'c-1', at: '2026-01-01T00:00:00.000Z' });
    const entries = [c1];
    // oldest で発行された cursor を、newest の呼びへ渡す。
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
      // `order` を足す前に発行された（＝ JSON に `order` の欄が無い）cursor
      // を模し、`resolveCommitmentCursor` を `order` 未指定（既定 oldest）
      // で呼ぶと、malformed にならず通常の B5 と同じ結果になることを確かめる。
      const c1 = open({ id: 'c-1', at: '2026-01-01T00:00:00.000Z' });
      const c2 = open({ id: 'c-2', at: '2026-01-02T00:00:00.000Z' });
      const entries = [c1, c2];
      const legacyCursorRaw = Buffer.from(
        JSON.stringify({
          ...commitmentPosition(c1),
          includeClosed: false,
          // `order` を意図的に書かない（足す前に発行されたカーソルを模す）。
        }),
        'utf8',
      ).toString('base64url');
      const result = resolveCommitmentCursor(entries, false, legacyCursorRaw);
      expect(result).toEqual({ kind: 'ok', view: [c2] });
    },
  );
});
