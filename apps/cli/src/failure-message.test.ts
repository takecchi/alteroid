import { describe, expect, it } from 'vitest';

import { describeCliFailure } from './failure-message.js';

function fetchFailed(code?: string): TypeError {
  return new TypeError('fetch failed', code === undefined ? undefined : { cause: { code } });
}

describe('describeCliFailure（#2855）', () => {
  it('接続できなかったとき、型名・fetch failed・識別子を出さず、次にやることを言う（手元）', () => {
    const text = describeCliFailure(fetchFailed('ECONNREFUSED'), {});
    expect(text).toContain('手元のデーモンに繋がりませんでした（接続を断られました）');
    expect(text).toContain('alteroid daemon status');
    expect(text).toContain('alteroid daemon start');
    expect(text).not.toMatch(/TypeError|fetch failed|ECONNREFUSED/);
  });

  it('ALTEROID_URL を指しているときは、その origin だけを載せる（userinfo・パス・クエリは出さない）', () => {
    const text = describeCliFailure(fetchFailed('ENOTFOUND'), {
      ALTEROID_URL: 'https://user:pw@alteroid.example.com/base?x=1',
    });
    expect(text).toContain('接続先（https://alteroid.example.com）に繋がりませんでした');
    expect(text).toContain('ホスト名を引けませんでした');
    expect(text).toContain('ALTEROID_URL の値が合っているか');
    expect(text).not.toMatch(/pw|user|base|x=1/);
  });

  it('cause が無くても同じ形で言う', () => {
    expect(describeCliFailure(fetchFailed(), {})).toContain('繋がりませんでした）');
  });

  it('ふつうの Error は message だけ（「Error:」の接頭辞を付けない）', () => {
    expect(describeCliFailure(new Error('そんな記憶はありません: nope'), {})).toBe(
      'そんな記憶はありません: nope',
    );
  });

  it('fetch failed 以外の TypeError は握り替えない（message のまま）', () => {
    expect(describeCliFailure(new TypeError('x is not a function'), {})).toBe(
      'x is not a function',
    );
  });

  it('Error でない値は文字列にして出す', () => {
    expect(describeCliFailure('boom', {})).toBe('boom');
  });
});
