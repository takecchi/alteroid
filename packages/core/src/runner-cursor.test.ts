import { describe, expect, it } from 'vitest';

import type { RunnerOverview } from './manager.js';
import { decodeRunnerCursor, encodeRunnerCursor, resolveRunnerCursor } from './runner-cursor.js';

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

  it('B5: 錨が消えていたら先頭から出し直し、restarted を立てる', () => {
    const resolved = resolveRunnerCursor(entries, encodeRunnerCursor({ label: 'いない' }));
    expect(resolved).toEqual({ kind: 'ok', view: entries, restarted: true });
  });

  it('B5: 出し直しでも1台も欠けない（欠落より重複の側へ倒してある）', () => {
    const resolved = resolveRunnerCursor(entries, encodeRunnerCursor({ label: 'いない' }));
    expect(resolved.kind === 'ok' && resolved.view.map((r) => r.label)).toEqual(['a', 'b', 'c']);
  });

  it('B7: 頁を繋ぐと過不足なく全件を1度ずつ辿れる（重複も欠落もしない）', () => {
    const fleet = Array.from({ length: 25 }, (_, i) => runner(`r-${String(i).padStart(2, '0')}`));
    const seen: string[] = [];
    let cursor: string | undefined;
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
