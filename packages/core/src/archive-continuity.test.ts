import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  classifyArchiveContinuity,
  describeArchiveContinuityForJournal,
  fingerprintArchiveBody,
} from './archive-continuity.js';

function md5(text: string): string {
  return createHash('md5').update(text, 'utf8').digest('hex');
}

describe('fingerprintArchiveBody', () => {
  it('bodyChars は UTF-16 コード単位で、bodyMd5 は utf8 の md5', () => {
    const fp = fingerprintArchiveBody('ABCD');
    expect(fp.bodyChars).toBe(4);
    expect(fp.bodyMd5).toBe(md5('ABCD'));
  });

  it('空文字の指紋も取れる（bodyChars=0）', () => {
    const fp = fingerprintArchiveBody('');
    expect(fp).toEqual({ bodyChars: 0, bodyMd5: md5('') });
  });

  /**
   * サロゲートペア（絵文字）を跨ぐ境界。**JS の `length` は UTF-16 コード単位
   * を数える**——コードポイント単位ではない。'😀' は1コードポイントだが
   * `length` は2である。`classifyArchiveContinuity` の `body.slice(0, n)` も
   * 同じ数え方なので、この関数が返す `bodyChars` とずれない。
   */
  it('サロゲートペアはコードポイント1でもbodyCharsは2を数える', () => {
    expect('😀'.length).toBe(2);
    const fp = fingerprintArchiveBody('A😀B');
    expect(fp.bodyChars).toBe(4); // 'A' + high + low + 'B'
  });
});

describe('classifyArchiveContinuity', () => {
  it('previous が null なら first（comparedTo 無し）', () => {
    expect(classifyArchiveContinuity(null, 'ANYTHING')).toEqual({ continuity: 'first' });
  });

  it('previous が undefined でも first', () => {
    expect(classifyArchiveContinuity(undefined, 'ANYTHING')).toEqual({ continuity: 'first' });
  });

  it('空文字どうし（previous も新しい本文も空）は continues', () => {
    const previous = { id: 'p1', ...fingerprintArchiveBody('') };
    expect(classifyArchiveContinuity(previous, '')).toEqual({
      continuity: 'continues',
      comparedTo: 'p1',
    });
  });

  it('片方が空（previous が空、新しい本文に中身が付いた）は continues（空は何にでも前方一致する）', () => {
    const previous = { id: 'p1', ...fingerprintArchiveBody('') };
    expect(classifyArchiveContinuity(previous, 'NEW-BODY')).toEqual({
      continuity: 'continues',
      comparedTo: 'p1',
    });
  });

  it('片方が空（previous に中身が有り、新しい本文が空）は diverged（縮んだ）', () => {
    const previous = { id: 'p1', ...fingerprintArchiveBody('OLD-BODY') };
    expect(classifyArchiveContinuity(previous, '')).toEqual({
      continuity: 'diverged',
      comparedTo: 'p1',
    });
  });

  it('完全一致（伸びていない）は continues——自分自身は自分の前方一致である', () => {
    const previous = { id: 'p1', ...fingerprintArchiveBody('SAME\n') };
    expect(classifyArchiveContinuity(previous, 'SAME\n')).toEqual({
      continuity: 'continues',
      comparedTo: 'p1',
    });
  });

  it('1文字だけ伸びた本文は continues', () => {
    const previous = { id: 'p1', ...fingerprintArchiveBody('ABCD') };
    expect(classifyArchiveContinuity(previous, 'ABCDE')).toEqual({
      continuity: 'continues',
      comparedTo: 'p1',
    });
  });

  it('先頭1文字だけ違う本文は diverged（同じ長さでも前方一致しない）', () => {
    const previous = { id: 'p1', ...fingerprintArchiveBody('ABCD') };
    expect(classifyArchiveContinuity(previous, 'XBCD')).toEqual({
      continuity: 'diverged',
      comparedTo: 'p1',
    });
  });

  it('末尾だけ違う本文は diverged（先頭からprevious.bodyCharsぶんが一致しない）', () => {
    const previous = { id: 'p1', ...fingerprintArchiveBody('ABCD') };
    expect(classifyArchiveContinuity(previous, 'ABCE')).toEqual({
      continuity: 'diverged',
      comparedTo: 'p1',
    });
  });

  /**
   * 🔴 `previous.bodyChars` が新しい本文より長い（＝縮んだ）⟹ diverged。
   * 本番の「6,900万文字*縮んだ*」行に相当（`archive-contract.ts` 検査15）。
   */
  it('previous.bodyChars が新しい本文より長い（縮んだ）ときは diverged', () => {
    const previous = { id: 'p1', ...fingerprintArchiveBody('0123456789') };
    expect(classifyArchiveContinuity(previous, '01234')).toEqual({
      continuity: 'diverged',
      comparedTo: 'p1',
    });
  });

  /**
   * 🔴 長さは伸びているのに先頭が違う ⟹ diverged。**長さ比較へ退化すると
   * 緑になってしまう歯**（`archive-contract.ts` 検査16 と同じ意図）。
   */
  it('長さは伸びているのに先頭が違う本文は diverged（長さ比較への退化を検出する）', () => {
    const previous = { id: 'p1', ...fingerprintArchiveBody('AAAA') };
    expect(classifyArchiveContinuity(previous, 'ZZZZZZZZZZ')).toEqual({
      continuity: 'diverged',
      comparedTo: 'p1',
    });
  });

  /**
   * 🔴 `bodyChars` だけ在って `bodyMd5` が無い／その逆／両方 null ⟹
   * すべて unknown。
   */
  it('bodyChars だけ在って bodyMd5 が無いときは unknown', () => {
    const previous = { id: 'p1', bodyChars: 4 };
    expect(classifyArchiveContinuity(previous, 'ABCD')).toEqual({
      continuity: 'unknown',
      comparedTo: 'p1',
    });
  });

  it('bodyMd5 だけ在って bodyChars が無いときは unknown', () => {
    const previous = { id: 'p1', bodyMd5: md5('ABCD') };
    expect(classifyArchiveContinuity(previous, 'ABCD')).toEqual({
      continuity: 'unknown',
      comparedTo: 'p1',
    });
  });

  it('bodyChars / bodyMd5 が両方とも undefined のときも unknown', () => {
    const previous = { id: 'p1' };
    expect(classifyArchiveContinuity(previous, 'ABCD')).toEqual({
      continuity: 'unknown',
      comparedTo: 'p1',
    });
  });

  it('bodyChars / bodyMd5 が両方とも null のときも unknown', () => {
    const previous = { id: 'p1', bodyChars: null, bodyMd5: null };
    expect(classifyArchiveContinuity(previous, 'ABCD')).toEqual({
      continuity: 'unknown',
      comparedTo: 'p1',
    });
  });

  /**
   * サロゲートペア（絵文字）を跨ぐ境界で、`fingerprintArchiveBody` と
   * `classifyArchiveContinuity` が同じ数え方をしていること。
   *
   * `previous` の本文がサロゲートペアで終わっており、新しい本文がその続きに
   * さらに別の絵文字を足す——両者とも同じ UTF-16 コード単位で `slice` /
   * `length` を扱っていなければ、境界がずれて誤って diverged になる。
   */
  it('previous の末尾が絵文字（サロゲートペア）でも continues が正しく判定される', () => {
    const previousBody = 'AB😀';
    const previous = { id: 'p1', ...fingerprintArchiveBody(previousBody) };
    expect(previous.bodyChars).toBe(4); // 'A' 'B' + high + low

    const nextBody = previousBody + '😀EFG';
    expect(classifyArchiveContinuity(previous, nextBody)).toEqual({
      continuity: 'continues',
      comparedTo: 'p1',
    });
  });

  it('絵文字を挟んだ本文で先頭が違えば diverged になる（サロゲートペアでも取りこぼさない）', () => {
    const previousBody = 'AB😀CD';
    const previous = { id: 'p1', ...fingerprintArchiveBody(previousBody) };

    const divergedBody = 'XB😀CD' + 'more-and-more-to-make-it-longer';
    expect(classifyArchiveContinuity(previous, divergedBody)).toEqual({
      continuity: 'diverged',
      comparedTo: 'p1',
    });
  });

  /**
   * `previous.bodyChars` がサロゲートペアの真ん中を指す、あり得ない/壊れた
   * 状態でも例外を投げず、`diverged` へ落ちる（`slice` は境界をコード単位で
   * 機械的に切るだけなので、壊れた不変条件を検出はしないが、少なくとも
   * クラッシュせず、`md5` が一致しないぶん自然に `diverged` になる）。
   */
  it('previous.bodyChars がサロゲートペアの内側を指しても例外を投げずdivergedになる', () => {
    const previousBody = 'AB😀CD'; // length=6 (A,B,high,low,C,D)
    const fullFingerprint = fingerprintArchiveBody(previousBody);
    // わざと1文字少ない bodyChars（サロゲートペアの前半だけを含む位置）を渡す。
    const corruptedPrevious = { id: 'p1', bodyChars: 3, bodyMd5: fullFingerprint.bodyMd5 };
    expect(() => classifyArchiveContinuity(corruptedPrevious, previousBody + 'MORE')).not.toThrow();
    expect(classifyArchiveContinuity(corruptedPrevious, previousBody + 'MORE')).toEqual({
      continuity: 'diverged',
      comparedTo: 'p1',
    });
  });
});

describe('describeArchiveContinuityForJournal', () => {
  it('first では null を返す（記録しない）', () => {
    expect(
      describeArchiveContinuityForJournal({
        caller: 'テスト',
        sessionId: 'sess-1',
        continuity: 'first',
        bodyChars: 10,
      }),
    ).toBeNull();
  });

  it('continues では null を返す（記録しない）', () => {
    expect(
      describeArchiveContinuityForJournal({
        caller: 'テスト',
        sessionId: 'sess-1',
        continuity: 'continues',
        comparedTo: 'prev-id',
        bodyChars: 10,
      }),
    ).toBeNull();
  });

  it('diverged では caller / sessionId / continuity / comparedTo / bodyChars を含む文字列を返す', () => {
    const text = describeArchiveContinuityForJournal({
      caller: 'PreCompact の退避',
      sessionId: 'sess-1',
      continuity: 'diverged',
      comparedTo: 'prev-id',
      bodyChars: 12345,
    });
    expect(text).not.toBeNull();
    expect(text).toContain('PreCompact の退避');
    expect(text).toContain('diverged');
    expect(text).toContain('sess-1');
    expect(text).toContain('prev-id');
    expect(text).toContain('12345');
  });

  it('unknown でも文字列を返す', () => {
    const text = describeArchiveContinuityForJournal({
      caller: '文脈窓で畳む前の退避',
      sessionId: 'sess-2',
      continuity: 'unknown',
      comparedTo: 'legacy-id',
      bodyChars: 1,
    });
    expect(text).not.toBeNull();
    expect(text).toContain('unknown');
  });

  it('comparedTo が無くても落ちない（文字列にcomparedTo=は現れない）', () => {
    const text = describeArchiveContinuityForJournal({
      caller: 'マネージャーの生ログの退避',
      sessionId: 'sess-3',
      continuity: 'diverged',
      bodyChars: 7,
    });
    expect(text).not.toBeNull();
    expect(text).not.toContain('comparedTo=');
  });

  it('本文そのもの・断片を載せない（渡していないので含まれようがないことを確認する）', () => {
    const text = describeArchiveContinuityForJournal({
      caller: 'テスト',
      sessionId: 'sess-4',
      continuity: 'diverged',
      comparedTo: 'prev-id',
      bodyChars: 3,
    });
    expect(text).not.toContain('BODY');
  });
});
