import { describe, expect, it } from 'vitest';

import { extractRowId, summarizeInvalidFields } from './invalid-row.js';

describe('summarizeInvalidFields', () => {
  it('欄の頭だけを出す', () => {
    expect(summarizeInvalidFields([{ path: ['a', 'b'] }, { path: ['c', 0] }])).toBe(
      '不正な欄: a,c',
    );
  });

  it('path が空なら (root) を出す', () => {
    expect(summarizeInvalidFields([{ path: [] }])).toBe('不正な欄: (root)');
  });

  it('同じ欄は1回だけ出す', () => {
    expect(summarizeInvalidFields([{ path: ['a', 'x'] }, { path: ['a', 'y'] }])).toBe(
      '不正な欄: a',
    );
  });

  it('欄が無ければ 不正な行 を出す', () => {
    expect(summarizeInvalidFields([])).toBe('不正な行');
  });

  it('issue.message の中身を出力に含めない', () => {
    const issues = [{ path: ['token'], message: 'received "sk-secret-value"' }];
    expect(summarizeInvalidFields(issues)).not.toContain('sk-secret-value');
    expect(summarizeInvalidFields(issues)).toBe('不正な欄: token');
  });
});

describe('extractRowId', () => {
  it('文字列の id を返す', () => {
    expect(extractRowId({ id: 'abc' })).toBe('abc');
  });

  it('id が文字列でない、または行がオブジェクトでなければ undefined', () => {
    expect(extractRowId({ id: 1 })).toBeUndefined();
    expect(extractRowId({})).toBeUndefined();
    expect(extractRowId(null)).toBeUndefined();
    expect(extractRowId('x')).toBeUndefined();
  });
});
