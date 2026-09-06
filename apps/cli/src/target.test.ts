import { describe, expect, it } from 'vitest';

import { forbiddenKindOf } from './target.js';

/**
 * `forbiddenKindOf` — 403 の本文から、どちらの理由で拒否されたかを判別する。
 *
 * **この2つの逐語は `apps/daemon/src/app.ts` の複製である。import はしない**
 * （`target.ts` の `NOT_OPERATOR_ERROR` / `NOT_GRANTED_ERROR` の doc と同じ理由）。
 * ここでも import せずに直接書く——`forbiddenKindOf` が内部で使っている定数と
 * 同じ変数を歯の側でも参照すると、デーモンの文言が変わったときに歯まで一緒に
 * 変わって自己整合し、ずれを検出できなくなる。
 */
const NOT_OPERATOR_BODY = { error: '実行環境の持ち主だけが操作できる' };
const NOT_GRANTED_BODY = { error: 'このアカウントには alteroid を使う許可が無い' };

describe('forbiddenKindOf', () => {
  it('持ち主用の本文を not_operator と判別する', () => {
    expect(forbiddenKindOf(NOT_OPERATOR_BODY)).toBe('not_operator');
  });

  it('未 grant 用の本文を not_granted と判別する', () => {
    expect(forbiddenKindOf(NOT_GRANTED_BODY)).toBe('not_granted');
  });

  // **⭐ ここが設計の芯——3行目の歯である。** 判別できない本文で当てずっぽうに
  // どちらかへ倒すと、必ず嘘の案内を出す状況が生まれる。`unknown` を返すこと
  // そのものが守るべき性質なので、必ず測る。
  it('どちらとも判別できない本文を unknown とする（空オブジェクト）', () => {
    expect(forbiddenKindOf({})).toBe('unknown');
  });

  it('どちらとも判別できない本文を unknown とする（別の理由の error）', () => {
    expect(forbiddenKindOf({ error: 'なにか別の理由' })).toBe('unknown');
  });

  it('本文が無い・オブジェクトでないときも unknown', () => {
    expect(forbiddenKindOf(undefined)).toBe('unknown');
    expect(forbiddenKindOf(null)).toBe('unknown');
    expect(forbiddenKindOf('forbidden')).toBe('unknown');
  });
});
