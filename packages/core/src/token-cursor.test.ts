import { describe, expect, it } from 'vitest';

import { decodeTokenCursor, encodeTokenCursor, resolveTokenCursor } from './token-cursor.js';
import type { AgentToken } from './token-pool.js';

/**
 * `resolveTokenCursor`（`token_list` の継続点）の分岐対応表。
 *
 * `schedule-cursor.test.ts` と同じ形。
 *
 * | 分岐 | 内容 | 歯 |
 * | --- | --- | --- |
 * | B1 | `cursorRaw === undefined` → 絞らない | `B1: cursor 未指定は先頭から（絞らない）` |
 * | B2 | base64 として読めない | `B2: base64 として読めない cursor は malformed` |
 * | B3 | schema に合わない | `B3: schema に合わない cursor は malformed` |
 * | B4 | 錨が実在する（位置の探索。鍵は id） | `B4: 錨が実在すれば位置の探索でそれより後ろだけを残す` |
 * | B5 | 錨が消えている（比較。鍵は order） | `B5: 錨が消えていても比較（第二の手段）で続きが決まる` |
 * | B6 | cursor が末尾を指す | `B6: cursor が最後の行を指していれば view は空（最後の頁）` |
 * | B7 | 🔴 `order` の同値を飛ばさない | `B7: 錨が消えていて order が同値の行が在っても、1行も飛ばさない` |
 */
function token(id: string, order: number): AgentToken {
  return { id, label: id, value: 'sk-ant-oat01-FAKE-NOT-A-REAL-TOKEN', order } as AgentToken;
}

describe('encodeTokenCursor / decodeTokenCursor（部品）', () => {
  it('符号化・復号の往復で中身が保たれる', () => {
    const cursor = { id: 'tok-a', order: 3 };
    expect(decodeTokenCursor(encodeTokenCursor(cursor))).toEqual({ ok: true, cursor });
  });

  it('B2: base64 として読めない cursor は malformed', () => {
    expect(decodeTokenCursor('!!! not base64 !!!')).toEqual({ ok: false });
  });

  it('B3: schema に合わない cursor は malformed（order の欄が無い）', () => {
    const raw = Buffer.from(JSON.stringify({ id: 'tok-a' }), 'utf8').toString('base64url');
    expect(decodeTokenCursor(raw)).toEqual({ ok: false });
  });

  it('⛔ 値（value）は cursor に入らない（錨は id と order だけ）', () => {
    const raw = encodeTokenCursor({ id: 'tok-a', order: 0 });
    // カーソルは応答に平文で出る。**復号して値が出てはならない。**
    expect(Buffer.from(raw, 'base64url').toString('utf8')).not.toContain('sk-ant');
  });
});

describe('resolveTokenCursor（分岐）', () => {
  const entries = [token('tok-a', 0), token('tok-b', 1), token('tok-c', 2)];

  it('B1: cursor 未指定は先頭から（絞らない）', () => {
    expect(resolveTokenCursor(entries, undefined)).toEqual({ kind: 'ok', view: entries });
  });

  it('B2/B3を統合: 壊れた cursor は malformed（黙って先頭へ倒さない）', () => {
    expect(resolveTokenCursor(entries, '!!!')).toEqual({ kind: 'malformed' });
  });

  it('B4: 錨が実在すれば位置の探索でそれより後ろだけを残す', () => {
    const result = resolveTokenCursor(entries, encodeTokenCursor({ id: 'tok-a', order: 0 }));
    expect(result.kind === 'ok' && result.view.map((e) => e.id)).toEqual(['tok-b', 'tok-c']);
  });

  it('B5: 錨が消えていても比較（第二の手段）で続きが決まる', () => {
    const result = resolveTokenCursor(entries, encodeTokenCursor({ id: 'tok-gone', order: 1 }));
    expect(result.kind === 'ok' && result.view.map((e) => e.id)).toEqual(['tok-b', 'tok-c']);
  });

  it('B6: cursor が最後の行を指していれば view は空（最後の頁）', () => {
    const result = resolveTokenCursor(entries, encodeTokenCursor({ id: 'tok-c', order: 2 }));
    expect(result).toEqual({ kind: 'ok', view: [] });
  });

  it('B7: 錨が消えていて order が同値の行が在っても、1行も飛ばさない', () => {
    // **`order` は一意ではない**（同値は入力順で安定させる、という契約まで）。
    // 錨（order 1）が消えたとき、`>` で残すと同じ order の tok-b2 が静かに飛ぶ。
    const tied = [token('tok-a', 0), token('tok-b1', 1), token('tok-b2', 1), token('tok-c', 2)];
    const result = resolveTokenCursor(tied, encodeTokenCursor({ id: 'tok-gone', order: 1 }));
    expect(result.kind === 'ok' && result.view.map((e) => e.id)).toEqual([
      'tok-b1',
      'tok-b2',
      'tok-c',
    ]);
  });
});
