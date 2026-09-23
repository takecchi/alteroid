import { describe, expect, it } from 'vitest';

import { compareApprovalPagingKey, compareApprovalPagingKeyAsc } from './approval-cursor.js';
import type { PendingApproval } from './schema.js';

/**
 * `(createdAt, id)` の keyset の比較（`GET /approvals` の `cursor` が使う）の歯。
 *
 * かつてここには `approvals_list` 一覧モードの継続点（`resolveApprovalCursor` の
 * 分岐 B1〜B9、`encodeApprovalCursor` / `decodeApprovalCursor` の往復）の歯も
 * 在った。関数ごと削ったので、歯も外した（`tools.ts` へ一度も配線されず、本番の
 * 呼び出し元が0件だった——`approval-cursor.ts` の doc、#1392）。
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
