import { describe, expect, it } from 'vitest';

import {
  extractClosingKeywordReferences,
  // @ts-expect-error -- 素の .mjs（型宣言を持たない build 用スクリプト）を読む
} from './check-pr-closing-keywords-core.mjs';

describe('extractClosingKeywordReferences', () => {
  it('Closes #10 を拾う', () => {
    expect(extractClosingKeywordReferences('Closes #10')).toEqual([10]);
  });

  it('コロンを挟む Closes: #10 も拾う', () => {
    expect(extractClosingKeywordReferences('Closes: #10')).toEqual([10]);
  });

  it('大文字小文字を区別しない', () => {
    expect(extractClosingKeywordReferences('FIXES #3')).toEqual([3]);
  });

  it.each([
    'close',
    'closes',
    'closed',
    'fix',
    'fixes',
    'fixed',
    'resolve',
    'resolves',
    'resolved',
  ])('キーワード %s を拾う', (keyword) => {
    expect(extractClosingKeywordReferences(`${keyword} #42`)).toEqual([42]);
  });

  it('GH-123 を拾う', () => {
    expect(extractClosingKeywordReferences('Closes GH-123')).toEqual([123]);
  });

  it('owner/repo#5 を拾う', () => {
    expect(extractClosingKeywordReferences('Fixes owner/repo#5')).toEqual([5]);
  });

  it('issue の URL を拾う', () => {
    expect(extractClosingKeywordReferences('Resolves https://github.com/o/r/issues/7')).toEqual([
      7,
    ]);
  });

  it('重複は1つにまとめ、昇順で返す', () => {
    expect(extractClosingKeywordReferences('Closes #9\nFixes #2\nResolves #9\nCloses #5')).toEqual([
      2, 5, 9,
    ]);
  });

  it('行末のキーワードと次の行頭の #n はつながらない', () => {
    expect(extractClosingKeywordReferences('this closes\n#5')).toEqual([]);
  });

  it('バッククォートの中でも拾う', () => {
    expect(extractClosingKeywordReferences('`Closes #11`')).toEqual([11]);
  });

  it('キーワードの無い #5 は拾わない', () => {
    expect(extractClosingKeywordReferences('see #5')).toEqual([]);
  });

  it.each(['', null, undefined, 123])('空文字・文字列でない値は []（%s）', (value) => {
    expect(extractClosingKeywordReferences(value)).toEqual([]);
  });
});
