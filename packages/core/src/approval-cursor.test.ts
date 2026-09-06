import { describe, expect, it } from 'vitest';

import {
  compareApprovalPagingKey,
  compareApprovalPagingKeyAsc,
  decodeApprovalCursor,
  encodeApprovalCursor,
  resolveApprovalCursor,
} from './approval-cursor.js';
import type { PendingApproval } from './schema.js';

/**
 * `resolveApprovalCursor`（`approvals_list` 一覧モードの継続点）の分岐対応表。
 *
 * **形は `commitment-cursor.test.ts` に揃えた**（そちらの基準は PR #638 の
 * `decideRunnerSwapNotice` — 判定を I/O 無しの純関数へ切り出し、分岐を数え
 * 上げてそれぞれに歯を1本ずつ通す）。
 *
 * | 分岐 | 内容 | 歯 |
 * | --- | --- | --- |
 * | B1 | `cursorRaw === undefined` → 絞らない（先頭から） | `B1: cursor 未指定は先頭から（絞らない）` |
 * | B2 | base64 として読めない | `B2: base64 として読めない cursor は malformed` |
 * | B3 | base64/JSON としては読めるが schema に合わない | `B3: schema に合わない cursor は malformed` |
 * | B4 | 余分な欄を持つ（HTTP `/approvals` の `order` 付きカーソル） | `B4: order を持つ HTTP のカーソルは malformed（黙って受け取らない）` |
 * | B5 | 有効な cursor | `B5: 有効な cursor はそれより後ろだけを残す` |
 * | B6 | cursor が指す件が現在の一覧に実在しない（人間が答えた） | `B6: cursor の件が消えていても位置の比較だけで続きが決まる` |
 * | B7 | cursor が一覧の末尾を指す | `B7: cursor が最後の件を指していれば view は空（最後の頁）` |
 * | B8 | 同じ `createdAt` の同着 | `B8: 同じ createdAt の同着は id の昇順で割る` |
 * | B9 | ストアの生の並びが昇順でない | `B9: 生の並びが昇順でなくても (createdAt, id) 昇順へ並べ直してから絞る` |
 *
 * `compareApprovalPagingKeyAsc` / `compareApprovalPagingKey` /
 * `encodeApprovalCursor` / `decodeApprovalCursor` は、上の分岐を組み立てる
 * ための部品として個別にも直接触る（「部品が正しい」と「組み合わせが正しい」は
 * 別の観測なので、どちらも歯を持つ）。
 */

function approval(id: string, createdAt: string, overrides: Partial<PendingApproval> = {}) {
  return {
    id,
    createdAt,
    question: `${id} の質問`,
    ...overrides,
  } satisfies PendingApproval;
}

const a1 = approval('a-1', '2026-01-01T00:00:00.000Z');
const a2 = approval('a-2', '2026-01-02T00:00:00.000Z');
const a3 = approval('a-3', '2026-01-03T00:00:00.000Z');

function ids(entries: readonly PendingApproval[]): string[] {
  return entries.map((entry) => entry.id);
}

describe('compareApprovalPagingKeyAsc / compareApprovalPagingKey（部品）', () => {
  it('createdAt が違えば createdAt の昇順で決まる', () => {
    expect(compareApprovalPagingKeyAsc(a1, a2)).toBeLessThan(0);
    expect(compareApprovalPagingKeyAsc(a2, a1)).toBeGreaterThan(0);
  });

  it('createdAt が同着なら id の昇順で決まる（id を見ないと 0 になる）', () => {
    const same = '2026-01-01T00:00:00.000Z';
    expect(compareApprovalPagingKeyAsc(approval('a-1', same), approval('a-2', same))).toBeLessThan(
      0,
    );
    expect(
      compareApprovalPagingKeyAsc(approval('a-2', same), approval('a-1', same)),
    ).toBeGreaterThan(0);
  });

  it('createdAt も id も同じなら 0', () => {
    expect(compareApprovalPagingKeyAsc(a1, { ...a1 })).toBe(0);
  });

  it("compareApprovalPagingKey('desc') は昇順比較を反転したものである", () => {
    const desc = compareApprovalPagingKey('desc');
    expect(desc(a1, a2)).toBe(-compareApprovalPagingKeyAsc(a1, a2));
    expect(desc(a2, a1)).toBe(-compareApprovalPagingKeyAsc(a2, a1));
    expect(desc(a1, { ...a1 })).toBe(0);
  });

  it("compareApprovalPagingKey('asc') は昇順比較そのものである", () => {
    const asc = compareApprovalPagingKey('asc');
    expect(asc(a1, a2)).toBe(compareApprovalPagingKeyAsc(a1, a2));
  });
});

describe('encodeApprovalCursor / decodeApprovalCursor（部品）', () => {
  it('encode したものは decode で元へ戻る（往復）', () => {
    const cursor = { id: 'a-1', createdAt: '2026-01-01T00:00:00.000Z' };
    const decoded = decodeApprovalCursor(encodeApprovalCursor(cursor));
    expect(decoded).toEqual({ ok: true, cursor });
  });

  it('不透明である（呼び手が読める形で id を露出しない）', () => {
    const encoded = encodeApprovalCursor({ id: 'a-1', createdAt: '2026-01-01T00:00:00.000Z' });
    expect(encoded).not.toContain('a-1');
    // base64url なので、道具の出力にそのまま埋めても壊れない文字だけで構成される。
    expect(encoded).toMatch(/^[A-Za-z0-9\-_]+$/);
  });
});

describe('resolveApprovalCursor（分岐 B1〜B9）', () => {
  it('B1: cursor 未指定は先頭から（絞らない）', () => {
    const outcome = resolveApprovalCursor([a1, a2, a3], undefined);
    expect(outcome.kind).toBe('ok');
    expect(outcome.kind === 'ok' && ids(outcome.view)).toEqual(['a-1', 'a-2', 'a-3']);
  });

  it('B2: base64 として読めない cursor は malformed', () => {
    // base64url として復号しても JSON にならないもの。
    expect(resolveApprovalCursor([a1, a2], 'not-a-cursor!!!')).toEqual({ kind: 'malformed' });
  });

  it('B3: schema に合わない cursor は malformed', () => {
    // JSON としては読めるが、欄が足りない（createdAt が無い）。
    const raw = Buffer.from(JSON.stringify({ id: 'a-1' }), 'utf8').toString('base64url');
    expect(resolveApprovalCursor([a1, a2], raw)).toEqual({ kind: 'malformed' });
  });

  it('B3: 欄はあるが空文字の cursor は malformed（min(1)）', () => {
    const raw = Buffer.from(JSON.stringify({ id: '', createdAt: '' }), 'utf8').toString(
      'base64url',
    );
    expect(resolveApprovalCursor([a1, a2], raw)).toEqual({ kind: 'malformed' });
  });

  it('B4: order を持つ HTTP のカーソルは malformed（黙って受け取らない）', () => {
    // `GET /approvals` が返す nextCursor の中身（`apps/daemon/src/app.ts` の
    // `approvalsCursorSchema`）。非 strict なら `order` が黙って捨てられ、
    // `order: 'desc'` の続きを求めた呼び手へ「もう読んだ分」が返る。
    const raw = Buffer.from(
      JSON.stringify({ id: 'a-2', createdAt: '2026-01-02T00:00:00.000Z', order: 'desc' }),
      'utf8',
    ).toString('base64url');
    expect(resolveApprovalCursor([a1, a2, a3], raw)).toEqual({ kind: 'malformed' });
  });

  it('B5: 有効な cursor はそれより後ろだけを残す', () => {
    const raw = encodeApprovalCursor({ id: a1.id, createdAt: a1.createdAt });
    const outcome = resolveApprovalCursor([a1, a2, a3], raw);
    expect(outcome.kind).toBe('ok');
    expect(outcome.kind === 'ok' && ids(outcome.view)).toEqual(['a-2', 'a-3']);
  });

  it('B6: cursor の件が消えていても位置の比較だけで続きが決まる', () => {
    // a-2 は人間が答えたので、回答待ちの一覧（pendingOnly）から消えている。
    const raw = encodeApprovalCursor({ id: a2.id, createdAt: a2.createdAt });
    const outcome = resolveApprovalCursor([a1, a3], raw);
    expect(outcome.kind).toBe('ok');
    expect(outcome.kind === 'ok' && ids(outcome.view)).toEqual(['a-3']);
  });

  it('B7: cursor が最後の件を指していれば view は空（最後の頁）', () => {
    const raw = encodeApprovalCursor({ id: a3.id, createdAt: a3.createdAt });
    const outcome = resolveApprovalCursor([a1, a2, a3], raw);
    expect(outcome).toEqual({ kind: 'ok', view: [] });
  });

  it('B8: 同じ createdAt の同着は id の昇順で割る', () => {
    const same = '2026-01-01T00:00:00.000Z';
    const b = approval('a-b', same);
    const c = approval('a-c', same);
    const d = approval('a-d', same);
    const raw = encodeApprovalCursor({ id: c.id, createdAt: same });
    const outcome = resolveApprovalCursor([b, c, d], raw);
    expect(outcome.kind).toBe('ok');
    // 同着を id で割らなければ b も残る（＝既に出した件をもう一度出す）。
    expect(outcome.kind === 'ok' && ids(outcome.view)).toEqual(['a-d']);
  });

  it('B9: 生の並びが昇順でなくても (createdAt, id) 昇順へ並べ直してから絞る', () => {
    // `JobStore.listApprovals` は並び順を契約していない（`store.ts` の `JobStore`）。
    // 並べ直しを呼び出し側の「cursor が来たときだけ」に置くと、1頁目と2頁目で
    // 並びが変わって頁の境目が壊れる。
    const outcome = resolveApprovalCursor([a3, a1, a2], undefined);
    expect(outcome.kind).toBe('ok');
    expect(outcome.kind === 'ok' && ids(outcome.view)).toEqual(['a-1', 'a-2', 'a-3']);

    const raw = encodeApprovalCursor({ id: a1.id, createdAt: a1.createdAt });
    const paged = resolveApprovalCursor([a3, a1, a2], raw);
    expect(paged.kind).toBe('ok');
    expect(paged.kind === 'ok' && ids(paged.view)).toEqual(['a-2', 'a-3']);
  });

  it('入力の配列を書き換えない（並べ直しは複製の上で行う）', () => {
    const entries = [a3, a1, a2];
    resolveApprovalCursor(entries, undefined);
    expect(ids(entries)).toEqual(['a-3', 'a-1', 'a-2']);
  });
});
