import { describe, expect, it } from 'vitest';

import {
  decodeUsageCursor,
  encodeUsageCursor,
  findUsageCursorTies,
  resolveUsageCursor,
  type UsageCursorEntry,
} from './usage-cursor.js';

function entry(label: string, cost: number, updatedAt: string): UsageCursorEntry {
  return { label, cost, updatedAt };
}

describe('encodeUsageCursor / decodeUsageCursor（部品）', () => {
  it('符号化・復号の往復で中身が保たれる', () => {
    const cursor = { axis: 'manager', label: 'mgr-14', cost: 1, asOf: '2026-08-14T10:00:00.000Z' };
    expect(decodeUsageCursor(encodeUsageCursor(cursor))).toEqual({ ok: true, cursor });
  });

  it('B2: base64 として読めない cursor は malformed', () => {
    expect(decodeUsageCursor('!!! not base64 !!!')).toEqual({ ok: false });
  });

  it('B3: schema に合わない cursor は malformed（label の欄が無い）', () => {
    const raw = Buffer.from(JSON.stringify({ axis: 'manager', cost: 1 }), 'utf8').toString(
      'base64url',
    );
    expect(decodeUsageCursor(raw)).toEqual({ ok: false });
  });

  it('asOf を省いても schema に合う（後方互換）', () => {
    const raw = Buffer.from(
      JSON.stringify({ axis: 'manager', label: 'mgr-1', cost: 1 }),
      'utf8',
    ).toString('base64url');
    expect(decodeUsageCursor(raw)).toEqual({
      ok: true,
      cursor: { axis: 'manager', label: 'mgr-1', cost: 1 },
    });
  });
});

describe('resolveUsageCursor（分岐）', () => {
  it('B1: cursor 未指定は絞らない。risen も空', () => {
    const entries = [entry('mgr-01', 14, '2026-08-14T00:00:00.000Z')];
    const result = resolveUsageCursor(entries, 'manager', undefined);
    expect(result).toEqual({ kind: 'ok', page: entries, risen: [] });
  });

  it('B2/B3を統合: 壊れた cursor は malformed（黙って先頭へ倒さない）', () => {
    const entries = [entry('mgr-01', 14, '2026-08-14T00:00:00.000Z')];
    expect(resolveUsageCursor(entries, 'manager', '!!!')).toEqual({ kind: 'malformed' });
  });

  it('B4: axis が違う cursor は wrong-axis', () => {
    const entries = [entry('mgr-01', 14, '2026-08-14T00:00:00.000Z')];
    const cursor = encodeUsageCursor({ axis: 'model', label: 'mgr-01', cost: 14 });
    expect(resolveUsageCursor(entries, 'manager', cursor)).toEqual({ kind: 'wrong-axis' });
  });

  it('B4: self_status の ledger 錨（axis="ledger"）は usage_read の軸には使えない', () => {
    const entries = [entry('mgr-01', 14, '2026-08-14T00:00:00.000Z')];
    const cursor = encodeUsageCursor({ axis: 'ledger', label: 'mgr-01', cost: 14 });
    expect(resolveUsageCursor(entries, 'manager', cursor)).toEqual({ kind: 'wrong-axis' });
  });

  it('B5: 費用降順で錨より安い行だけが page（同額はラベル昇順）', () => {
    const entries = [
      entry('mgr-b', 5, '2026-08-14T00:00:00.000Z'),
      entry('mgr-a', 5, '2026-08-14T00:00:00.000Z'),
      entry('mgr-c', 3, '2026-08-14T00:00:00.000Z'),
    ];
    const cursor = encodeUsageCursor({ axis: 'manager', label: 'mgr-a', cost: 5 });
    const result = resolveUsageCursor(entries, 'manager', cursor);
    expect(result.kind === 'ok' && result.page.map((e) => e.label)).toEqual(['mgr-b', 'mgr-c']);
  });

  it('B6: 錨より前に居た行が伸びて追い越しても、page には出ない（重複しない）', () => {
    const asOf = '2026-08-14T10:00:00.000Z';
    const entries = [
      entry('mgr-15', 100, '2026-08-14T11:00:00.000Z'),
      entry('mgr-13', 2, '2026-08-14T09:00:00.000Z'),
      entry('mgr-14', 1, '2026-08-14T09:00:00.000Z'),
    ];
    const cursor = encodeUsageCursor({ axis: 'manager', label: 'mgr-14', cost: 1, asOf });
    const result = resolveUsageCursor(entries, 'manager', cursor);
    expect(result.kind === 'ok' && result.page).toEqual([]);
    expect(result.kind === 'ok' && result.risen.map((e) => e.label)).toEqual(['mgr-15']);
  });

  it('B7: asOf より前に更新された行（錨より上位のまま変わらない）は risen に出ない', () => {
    const asOf = '2026-08-14T10:00:00.000Z';
    const entries = [
      entry('mgr-01', 14, '2026-08-14T09:00:00.000Z'),
      entry('mgr-14', 1, '2026-08-14T09:00:00.000Z'),
    ];
    const cursor = encodeUsageCursor({ axis: 'manager', label: 'mgr-14', cost: 1, asOf });
    const result = resolveUsageCursor(entries, 'manager', cursor);
    expect(result.kind === 'ok' && result.risen).toEqual([]);
  });

  it('B7b: 錨自身が asOf より後に伸びていれば、risen へ「既に見せた行が伸びた」側として出る', () => {
    const asOf = '2026-08-14T10:00:00.000Z';
    const entries = [entry('mgr-14', 50, '2026-08-14T11:00:00.000Z')];
    const cursor = encodeUsageCursor({ axis: 'manager', label: 'mgr-14', cost: 1, asOf });
    const result = resolveUsageCursor(entries, 'manager', cursor);
    expect(result.kind === 'ok' && result.page).toEqual([]);
    expect(result.kind === 'ok' && result.risen.map((e) => e.label)).toEqual(['mgr-14']);
  });

  it('B8: anchor.asOf が無ければ risen は常に空（古い形の cursor でも壊れない）', () => {
    const raw = Buffer.from(
      JSON.stringify({ axis: 'manager', label: 'mgr-14', cost: 1 }),
      'utf8',
    ).toString('base64url');
    const entries = [entry('mgr-15', 100, '2026-08-14T11:00:00.000Z')];
    const result = resolveUsageCursor(entries, 'manager', raw);
    expect(result).toEqual({ kind: 'ok', page: [], risen: [] });
  });

  it('B9: date 軸はラベル（日付）降順で頁を切る。費用は無視する', () => {
    const entries = [
      entry('2026-08-13', 999, '2026-08-14T00:00:00.000Z'),
      entry('2026-08-12', 1, '2026-08-14T00:00:00.000Z'),
    ];
    const cursor = encodeUsageCursor({ axis: 'date', label: '2026-08-13', cost: 0 });
    const result = resolveUsageCursor(entries, 'date', cursor);
    expect(result.kind === 'ok' && result.page.map((e) => e.label)).toEqual(['2026-08-12']);
  });

  it('末尾を指す cursor は page も risen も空（最後の頁）', () => {
    const entries = [entry('mgr-01', 1, '2026-08-14T00:00:00.000Z')];
    const cursor = encodeUsageCursor({ axis: 'manager', label: 'mgr-01', cost: 1 });
    expect(resolveUsageCursor(entries, 'manager', cursor)).toEqual({
      kind: 'ok',
      page: [],
      risen: [],
    });
  });

  it('B10: #1719 の再現——asOf と同着で追い越した行（mgr-15）は risen に出る（取りこぼされない）', () => {
    const asOf = '2026-08-14T10:00:00.000Z';
    const anchorSeed = { label: 'mgr-14', cost: 1 };

    const entriesAtCreation = [
      entry('mgr-15', 0.5, asOf),
      entry('mgr-14', 1, '2026-08-14T09:00:00.000Z'),
      entry('mgr-13', 2, '2026-08-14T08:00:00.000Z'),
    ];
    const cursor = encodeUsageCursor({
      axis: 'manager',
      ...anchorSeed,
      asOf,
      tiedAtAsOf: findUsageCursorTies(entriesAtCreation, 'manager', anchorSeed, asOf),
    });

    const entries = [
      entry('mgr-15', 100, asOf),
      entry('mgr-14', 1, '2026-08-14T09:00:00.000Z'),
      entry('mgr-13', 2, '2026-08-14T08:00:00.000Z'),
    ];

    const result = resolveUsageCursor(entries, 'manager', cursor);
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    const allReturned = [...result.page, ...result.risen].map((e) => e.label);
    expect(allReturned).toContain('mgr-15');
    expect(result.risen.map((e) => e.label)).toEqual(['mgr-15']);
  });

  it('B11: asOf を作った行そのもの（伸びていない）は、呼ぶたびに risen へ載り続けない', () => {
    const asOf = '2026-08-14T10:00:00.000Z';
    const anchorSeed = { label: 'mgr-14', cost: 1 };

    const entriesAtCreation = [
      entry('mgr-14', 1, asOf),
      entry('mgr-13', 2, '2026-08-14T08:00:00.000Z'),
    ];
    const cursor = encodeUsageCursor({
      axis: 'manager',
      ...anchorSeed,
      asOf,
      tiedAtAsOf: findUsageCursorTies(entriesAtCreation, 'manager', anchorSeed, asOf),
    });

    const entries = [entry('mgr-14', 1, asOf), entry('mgr-13', 2, '2026-08-14T08:00:00.000Z')];
    const result = resolveUsageCursor(entries, 'manager', cursor);
    expect(result.kind === 'ok' && result.risen).toEqual([]);
  });

  it('B12: tiedAtAsOf を持たない旧形式の cursor は、同着を risen に含めない（後方互換）', () => {
    const asOf = '2026-08-14T10:00:00.000Z';
    const raw = Buffer.from(
      JSON.stringify({ axis: 'manager', label: 'mgr-14', cost: 1, asOf }),
      'utf8',
    ).toString('base64url');

    const entries = [
      entry('mgr-15', 100, asOf),
      entry('mgr-14', 1, '2026-08-14T09:00:00.000Z'),
    ];
    const result = resolveUsageCursor(entries, 'manager', raw);
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.page).toEqual([]);
    expect(result.risen).toEqual([]);
  });
});

describe('findUsageCursorTies（部品。issue #1719）', () => {
  it('asOf が無ければ、同着そのものが定義できないので空', () => {
    const entries = [entry('mgr-14', 1, '2026-08-14T09:00:00.000Z')];
    expect(
      findUsageCursorTies(entries, 'manager', { label: 'mgr-14', cost: 1 }, undefined),
    ).toEqual([]);
  });

  it('錨の候補集合（isAfterAnchor が偽の側）だけを拾う。まだ見せていない側の同着は含めない', () => {
    const asOf = '2026-08-14T10:00:00.000Z';
    const entries = [
      entry('mgr-15', 0.5, asOf),
      entry('mgr-14', 1, asOf),
      entry('mgr-13', 2, '2026-08-14T08:00:00.000Z'),
    ];
    const ties = findUsageCursorTies(entries, 'manager', { label: 'mgr-14', cost: 1 }, asOf);
    expect(ties).toEqual([{ label: 'mgr-14', cost: 1 }]);
  });
});
