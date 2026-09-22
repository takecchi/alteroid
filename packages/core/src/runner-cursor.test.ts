import { describe, expect, it } from 'vitest';

import type { RunnerOverview } from './manager.js';
import { decodeRunnerCursor, encodeRunnerCursor, resolveRunnerCursor } from './runner-cursor.js';

/**
 * `resolveRunnerCursor`（`runner_list` の継続点）の分岐対応表。
 *
 * `token-cursor.test.ts` / `schedule-cursor.test.ts` と同じ形。
 *
 * | 分岐 | 内容 | 歯 |
 * | --- | --- | --- |
 * | B1 | `cursorRaw === undefined` → 絞らない | `B1: cursor 未指定は先頭から（絞らない）` |
 * | B2 | base64 として読めない | `B2: base64 として読めない cursor は malformed` |
 * | B3 | schema に合わない | `B3: schema に合わない cursor は malformed` |
 * | B4 | 錨が実在する（位置の探索。鍵は label） | `B4: 錨が実在すればその次から残す` |
 * | B5 | 錨が消えている → 先頭から出し直す | `B5: 錨が消えていたら先頭から出し直し、restarted を立てる` |
 * | B6 | cursor が末尾を指す | `B6: cursor が最後の器を指していれば view は空（最後の頁）` |
 * | B7 | 🔴 描く順と錨の順が同一 ＝ 重複も欠落もしない | `B7: 頁を繋ぐと過不足なく全件を1度ずつ辿れる` |
 */
function runner(label: string): RunnerOverview {
  return {
    label,
    state: 'connected',
    since: '2026-01-01T00:00:00.000Z',
    revision: { status: 'unheard' },
    managers: [],
  };
}

describe('encodeRunnerCursor / decodeRunnerCursor（部品）', () => {
  it('符号化・復号の往復で中身が保たれる', () => {
    const cursor = { label: 'runner-a' };
    expect(decodeRunnerCursor(encodeRunnerCursor(cursor))).toEqual({ ok: true, cursor });
  });

  it('B2: base64 として読めない cursor は malformed', () => {
    expect(decodeRunnerCursor('!!! not base64 !!!')).toEqual({ ok: false });
  });

  it('B3: schema に合わない cursor は malformed（label の欄が無い）', () => {
    const raw = Buffer.from(JSON.stringify({ runnerId: 'r-a' }), 'utf8').toString('base64url');
    expect(decodeRunnerCursor(raw)).toEqual({ ok: false });
  });

  it('B3: 空文字の label は malformed（`min(1)`）', () => {
    const raw = Buffer.from(JSON.stringify({ label: '' }), 'utf8').toString('base64url');
    expect(decodeRunnerCursor(raw)).toEqual({ ok: false });
  });

  it('不透明である（中身の構造を呼び手が読まなくてよい形に符号化されている）', () => {
    // 生の label がそのまま見えていないこと＝呼び手が自分で組み立てる誘惑を断つ。
    expect(encodeRunnerCursor({ label: 'runner-a' })).not.toContain('runner-a');
  });
});

describe('resolveRunnerCursor（runner_list の継続点）', () => {
  const entries = [runner('a'), runner('b'), runner('c')];

  it('B1: cursor 未指定は先頭から（絞らない）', () => {
    const resolved = resolveRunnerCursor(entries, undefined);
    expect(resolved).toEqual({ kind: 'ok', view: entries, restarted: false });
  });

  it('B1: 渡された配列を書き換えない（複製を返す）', () => {
    const resolved = resolveRunnerCursor(entries, undefined);
    expect(resolved.kind === 'ok' && resolved.view).not.toBe(entries);
  });

  it('B2/B3: 壊れた cursor は malformed（⛔ 黙って先頭からへ倒さない）', () => {
    expect(resolveRunnerCursor(entries, '!!! not base64 !!!')).toEqual({ kind: 'malformed' });
  });

  it('B4: 錨が実在すればその次から残す', () => {
    const resolved = resolveRunnerCursor(entries, encodeRunnerCursor({ label: 'a' }));
    expect(resolved).toEqual({ kind: 'ok', view: [entries[1], entries[2]], restarted: false });
  });

  it('B6: cursor が最後の器を指していれば view は空（最後の頁）', () => {
    const resolved = resolveRunnerCursor(entries, encodeRunnerCursor({ label: 'c' }));
    expect(resolved).toEqual({ kind: 'ok', view: [], restarted: false });
  });

  /**
   * 🔴 **錨が消えたら先頭から出し直す。**
   *
   * 並びは `Map` の挿入順（登録順）で、`token_list` の `order` に当たる
   * **比較可能な鍵が無い**（`runner-cursor.ts` の doc）。⟹ 位置を割り出せない
   * 以上、1台も落とさないと言い切れる出し方はこれしか無い。
   */
  it('B5: 錨が消えていたら先頭から出し直し、restarted を立てる', () => {
    const resolved = resolveRunnerCursor(entries, encodeRunnerCursor({ label: 'いない' }));
    expect(resolved).toEqual({ kind: 'ok', view: entries, restarted: true });
  });

  it('B5: 出し直しでも1台も欠けない（欠落より重複の側へ倒してある）', () => {
    const resolved = resolveRunnerCursor(entries, encodeRunnerCursor({ label: 'いない' }));
    expect(resolved.kind === 'ok' && resolved.view.map((r) => r.label)).toEqual(['a', 'b', 'c']);
  });

  /**
   * 🔴 **この一覧に `memory_list` の「重複を許す」契約は要らない。**
   *
   * `tools.ts` は `overview.runners` を並べ替えず1台1ブロックで積むので、
   * **描く順と錨の順が同一**である。⟹ 頁を繋ぐと各器がちょうど1度ずつ出る。
   * `memory-cursor.ts` が木の順と `slug` 順の食い違いのために重複を契約に
   * したのとは、前提が違う。
   */
  it('B7: 頁を繋ぐと過不足なく全件を1度ずつ辿れる（重複も欠落もしない）', () => {
    const fleet = Array.from({ length: 25 }, (_, i) => runner(`r-${String(i).padStart(2, '0')}`));
    const seen: string[] = [];
    let cursor: string | undefined;
    // 1頁2台ずつ辿る（予算の代わりに件数で切って、繋ぎ目だけを測る）。
    for (let page = 0; page < 40; page += 1) {
      const resolved = resolveRunnerCursor(fleet, cursor);
      if (resolved.kind !== 'ok') throw new Error('malformed');
      if (resolved.view.length === 0) break;
      const shown = resolved.view.slice(0, 2);
      seen.push(...shown.map((r) => r.label));
      cursor = encodeRunnerCursor({ label: shown[shown.length - 1]!.label });
    }
    expect(seen).toEqual(fleet.map((r) => r.label));
    expect(new Set(seen).size).toBe(fleet.length);
  });

  it('0台の名簿でも落ちない（cursor 付きなら空の view ＝ 最後の頁）', () => {
    expect(resolveRunnerCursor([], encodeRunnerCursor({ label: 'a' }))).toEqual({
      kind: 'ok',
      view: [],
      restarted: true,
    });
  });
});
