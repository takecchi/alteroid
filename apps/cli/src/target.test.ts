import { describe, expect, it } from 'vitest';

import { describeAuthFailure, forbiddenKindOf } from './target.js';

/**
 * `forbiddenKindOf` — 403 の本文から、どちらの理由で拒否されたかを判別する。
 *
 * **この3つの逐語は `apps/daemon/src/app.ts` の複製である。import はしない**
 * （`target.ts` の `NOT_OPERATOR_ERROR` / `NOT_GRANTED_ERROR` /
 * `NOT_DECLARED_OWNER_ERROR` の doc と同じ理由）。ここでも import せずに直接
 * 書く——`forbiddenKindOf` が内部で使っている定数と同じ変数を歯の側でも参照
 * すると、デーモンの文言が変わったときに歯まで一緒に変わって自己整合し、
 * ずれを検出できなくなる。
 */
const NOT_OPERATOR_BODY = { error: '実行環境の持ち主だけが操作できる' };
const NOT_GRANTED_BODY = { error: 'このアカウントには alteroid を使う許可が無い' };
const NOT_DECLARED_OWNER_BODY = {
  error: '実行環境の持ち主として宣言されたアカウントだけが操作できる',
};

describe('forbiddenKindOf', () => {
  it('持ち主用の本文を not_operator と判別する', () => {
    expect(forbiddenKindOf(NOT_OPERATOR_BODY)).toBe('not_operator');
  });

  it('未 grant 用の本文を not_granted と判別する', () => {
    expect(forbiddenKindOf(NOT_GRANTED_BODY)).toBe('not_granted');
  });

  it('未宣言 owner 用の本文を not_declared_owner と判別する（issue #1198。requireOwner）', () => {
    expect(forbiddenKindOf(NOT_DECLARED_OWNER_BODY)).toBe('not_declared_owner');
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

describe('describeAuthFailure（403・kind による案内の分岐）', () => {
  const target = { baseUrl: 'http://127.0.0.1:4517', headers: {}, remote: false, note: null };

  it('kind を省略すると（既定 unknown）、従来どおり access grant を案内する', () => {
    const message = describeAuthFailure(403, target);
    expect(message).toContain('alteroid access grant <アカウント id>');
    expect(message).not.toContain('access owner');
  });

  it('not_granted も access grant を案内する（省略時と同じ文言）', () => {
    const message = describeAuthFailure(403, target, 'not_granted');
    expect(message).toContain('alteroid access grant <アカウント id>');
  });

  it('not_declared_owner は access owner を案内する（issue #1198。access grant は勧めない）', () => {
    const message = describeAuthFailure(403, target, 'not_declared_owner');
    expect(message).toContain('alteroid access list');
    expect(message).toContain('alteroid access owner <アカウント id>');
    expect(message).not.toContain('access grant <アカウント id>');
  });
});
