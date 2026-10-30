import { describe, expect, it } from 'vitest';

import { decodeManagerCursor, encodeManagerCursor } from './manager-cursor.js';
import { decodeMemoryCursor, encodeMemoryCursor } from './memory-cursor.js';
import { decodeRunnerCursor, encodeRunnerCursor } from './runner-cursor.js';
import { decodeScheduleCursor, encodeScheduleCursor } from './schedule-cursor.js';
import { decodeTokenCursor, encodeTokenCursor } from './token-cursor.js';
import { decodeUsageCursor, encodeUsageCursor } from './usage-cursor.js';

// 既に出回っているカーソルの文字列の形を固定の値で縛る（codec を寄せても形が変わらないことの証拠）。
const b64 = (value: unknown): string =>
  Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');

describe('カーソルの文字列の形（出回る形の固定値）', () => {
  it('schedule', () => {
    const raw = 'eyJraW5kIjoiZGFpbHkifQ';
    expect(encodeScheduleCursor({ kind: 'daily' })).toBe(raw);
    expect(decodeScheduleCursor(raw)).toEqual({ ok: true, cursor: { kind: 'daily' } });
  });

  it('memory', () => {
    const raw = 'eyJmcm9tIjoibm90ZXMvYSJ9';
    expect(encodeMemoryCursor({ from: 'notes/a' })).toBe(raw);
    expect(decodeMemoryCursor(raw)).toEqual({ ok: true, cursor: { from: 'notes/a' } });
  });

  it('usage（全欄）', () => {
    const cursor = {
      axis: 'cost',
      label: 'proj',
      cost: 1.5,
      asOf: '2026-01-01T00:00:00.000Z',
      tiedAtAsOf: [{ label: 'x', cost: 1.5 }],
    };
    const raw =
      'eyJheGlzIjoiY29zdCIsImxhYmVsIjoicHJvaiIsImNvc3QiOjEuNSwiYXNPZiI6IjIwMjYtMDEtMDFUMDA6MDA6MDAuMDAwWiIsInRpZWRBdEFzT2YiOlt7ImxhYmVsIjoieCIsImNvc3QiOjEuNX1dfQ';
    expect(encodeUsageCursor(cursor)).toBe(raw);
    expect(decodeUsageCursor(raw)).toEqual({ ok: true, cursor });
  });

  it('usage（旧形式: asOf / tiedAtAsOf なし）', () => {
    const raw = 'eyJheGlzIjoiZGF0ZSIsImxhYmVsIjoiMjAyNi0wMS0wMSIsImNvc3QiOjJ9';
    const cursor = { axis: 'date', label: '2026-01-01', cost: 2 };
    expect(encodeUsageCursor(cursor)).toBe(raw);
    expect(decodeUsageCursor(raw)).toEqual({ ok: true, cursor });
  });

  it('manager', () => {
    const raw =
      'eyJyYW5rIjoxLCJqdWRnZW1lbnRSYW5rIjowLCJzdGFydGVkQXQiOiIyMDI2LTAxLTAxVDAwOjAwOjAwLjAwMFoiLCJtYW5hZ2VySWQiOiJtMSIsInN0YXR1cyI6WyJydW5uaW5nIl0sInEiOm51bGx9';
    const cursor = {
      rank: 1 as const,
      judgementRank: 0 as const,
      startedAt: '2026-01-01T00:00:00.000Z',
      managerId: 'm1',
      status: ['running' as const],
      q: null,
    };
    expect(encodeManagerCursor(cursor)).toBe(raw);
    // q を省いても q: null で刷られる（キーは末尾）
    expect(
      encodeManagerCursor({
        rank: cursor.rank,
        judgementRank: cursor.judgementRank,
        startedAt: cursor.startedAt,
        managerId: cursor.managerId,
        status: cursor.status,
      }),
    ).toBe(raw);
    expect(decodeManagerCursor(raw)).toEqual({ ok: true, cursor });
  });

  it('manager（judgementRank・q を足す前に発行された旧い cursor は既定で読める）', () => {
    const old = b64({
      rank: 1,
      startedAt: '2026-01-01T00:00:00.000Z',
      managerId: 'm1',
      status: null,
    });
    expect(decodeManagerCursor(old)).toEqual({
      ok: true,
      cursor: {
        rank: 1,
        judgementRank: 0,
        startedAt: '2026-01-01T00:00:00.000Z',
        managerId: 'm1',
        status: null,
        q: null,
      },
    });
  });

  it('runner', () => {
    const raw = 'eyJsYWJlbCI6InIxIn0';
    expect(encodeRunnerCursor({ label: 'r1' })).toBe(raw);
    expect(decodeRunnerCursor(raw)).toEqual({ ok: true, cursor: { label: 'r1' } });
  });

  it('token', () => {
    const raw = 'eyJpZCI6InQxIiwib3JkZXIiOjN9';
    expect(encodeTokenCursor({ id: 't1', order: 3 })).toBe(raw);
    expect(decodeTokenCursor(raw)).toEqual({ ok: true, cursor: { id: 't1', order: 3 } });
  });
});

describe('読めないカーソルは { ok: false } で断る', () => {
  const decoders: Array<[string, (raw: string) => { ok: boolean }, unknown]> = [
    ['schedule', decodeScheduleCursor, { kind: '' }],
    ['memory', decodeMemoryCursor, { from: '' }],
    ['usage', decodeUsageCursor, { axis: 'cost', label: 'a' }],
    ['manager', decodeManagerCursor, { rank: 3, startedAt: 'a', managerId: 'm', status: null }],
    ['runner', decodeRunnerCursor, { label: '' }],
    ['token', decodeTokenCursor, { id: 't', order: 1.5 }],
  ];
  for (const [name, decode, badShape] of decoders) {
    it(`${name}: 壊れた JSON`, () => {
      expect(decode(Buffer.from('{not json', 'utf8').toString('base64url'))).toEqual({ ok: false });
    });
    it(`${name}: 空文字`, () => {
      expect(decode('')).toEqual({ ok: false });
    });
    it(`${name}: スキーマに合わない`, () => {
      expect(decode(b64(badShape))).toEqual({ ok: false });
    });
    it(`${name}: JSON だがオブジェクトでない`, () => {
      expect(decode(b64('x'))).toEqual({ ok: false });
      expect(decode(b64(null))).toEqual({ ok: false });
    });
  }
});
