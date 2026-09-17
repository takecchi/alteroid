import { describe, expect, it } from 'vitest';

import {
  CLOSING_KEYWORDS,
  evaluatePrClosingKeywords,
  findClosingKeywordOccurrences,
  formatVerdict,
  // @ts-expect-error -- 素の .mjs（型宣言を持たない build 用スクリプト）を読む
} from './check-pr-closing-keywords-core.mjs';

/**
 * `check-pr-closing-keywords` の歯（Issue #1109）。
 *
 * 本物の `gh pr view` は叩かない —— 合成したタイトル・本文・コミットメッセージで
 * 判定だけを確かめる（`check-no-attribution-trailers.test.ts` /
 * `check-pr-title-type.test.ts` と同じ理由）。
 *
 * **この歯は fixture として閉じるキーワードの逐語を持つ。** それ自体が対象に
 * なってはいけない——この門は repo のファイルも git の履歴も一切走査しない
 * （`check-pr-closing-keywords-core.mjs` の doc、#785 の族）ので、この歯の中身が
 * この門自身に引っかかることは無い。
 */

describe('findClosingKeywordOccurrences — 通す形', () => {
  it('Closes #123 単独行は通る（findings 0件）', () => {
    expect(findClosingKeywordOccurrences('Closes #123')).toEqual([]);
  });

  it('fixes #123. も通る（末尾の period 1つは許す）', () => {
    expect(findClosingKeywordOccurrences('fixes #123.')).toEqual([]);
  });

  it('closes #1、fixes #2 も通る（全角読点区切りの複数対。公式 doc の複数例と同型）', () => {
    expect(findClosingKeywordOccurrences('closes #1、fixes #2')).toEqual([]);
  });

  it('公式 doc の複数例そのもの（Resolves #10, resolves #123, resolves octo-org/octo-repo#100）が通る', () => {
    expect(
      findClosingKeywordOccurrences('Resolves #10, resolves #123, resolves octo-org/octo-repo#100'),
    ).toEqual([]);
  });

  it('番号だけ（キーワードが無い）は通る——閉じないので問題にならない', () => {
    expect(findClosingKeywordOccurrences('#993 の段2を直す')).toEqual([]);
  });

  it('参照がキーワードより前（#123 を fix する）は通る——GitHub もこの順序では閉じない', () => {
    expect(findClosingKeywordOccurrences('#123 を fix する')).toEqual([]);
  });

  it('強調（**）で対の並び全体を囲んだ形も通る（実測: PR #915 の Closes #913、マージの1秒後に閉じた）', () => {
    expect(findClosingKeywordOccurrences('**Closes #913**')).toEqual([]);
  });

  it.each(['**', '*', '__', '_'])('強調記号 %s で囲んだ形も通る（4種すべて）', (mark) => {
    expect(findClosingKeywordOccurrences(`${mark}Closes #123${mark}`)).toEqual([]);
  });

  it('コロンを挟む形も通る（公式 doc: Closes: #10, CLOSES #10, CLOSES: #10 はすべて有効）', () => {
    expect(findClosingKeywordOccurrences('Closes: #10')).toEqual([]);
    expect(findClosingKeywordOccurrences('CLOSES #10')).toEqual([]);
    expect(findClosingKeywordOccurrences('CLOSES: #10')).toEqual([]);
  });
});

describe('findClosingKeywordOccurrences — 落とす形', () => {
  it('形1の再現: Closes #993 の段1。 は trailing-text（PR #1095 の実際の逐語）', () => {
    const result = findClosingKeywordOccurrences('Closes #993 の段1。');
    expect(result).toHaveLength(1);
    expect(result[0].category).toBe('trailing-text');
    expect(result[0].line).toBe('Closes #993 の段1。');
  });

  it('強調で囲んでも中に対以外の文字が在れば trailing-text のまま落ちる（**Closes #993 の段1。**）', () => {
    const result = findClosingKeywordOccurrences('**Closes #993 の段1。**');
    expect(result).toHaveLength(1);
    expect(result[0].category).toBe('trailing-text');
  });

  it('形2の再現: バッククォートで囲んだキーワードだけの本文でも、裸のキーワードが1つも無いのに found/in-code になる', () => {
    const result = findClosingKeywordOccurrences(
      'この PR では閉じるキーワードを書いていない。例えば `Closes #123` のような形である。',
    );
    expect(result).toHaveLength(1);
    expect(result[0].category).toBe('in-code');
  });

  it('leading-text: 誤って closes #993 のように手前に文字が在り、後ろには続かない', () => {
    const result = findClosingKeywordOccurrences('誤って closes #993');
    expect(result).toHaveLength(1);
    expect(result[0].category).toBe('leading-text');
  });

  it('フェンスの中（```）は in-code', () => {
    const text = ['```', 'Closes #123', '```'].join('\n');
    const result = findClosingKeywordOccurrences(text);
    expect(result).toHaveLength(1);
    expect(result[0].category).toBe('in-code');
    expect(result[0].line).toBe('Closes #123');
  });

  it('引用行（>）は in-quote', () => {
    const result = findClosingKeywordOccurrences('> Closes #123');
    expect(result).toHaveLength(1);
    expect(result[0].category).toBe('in-quote');
  });

  it('HTML コメントの中は in-html-comment（1行）', () => {
    const result = findClosingKeywordOccurrences('<!-- Closes #123 -->');
    expect(result).toHaveLength(1);
    expect(result[0].category).toBe('in-html-comment');
  });

  it('HTML コメントの中は in-html-comment（複数行に跨るコメント）', () => {
    const text = ['<!--', 'Closes #123', '-->'].join('\n');
    const result = findClosingKeywordOccurrences(text);
    expect(result).toHaveLength(1);
    expect(result[0].category).toBe('in-html-comment');
  });

  it('優先順位: コードスパンの中でかつ後ろに文字が続く場合は in-code を名乗る（trailing-text ではない）', () => {
    const result = findClosingKeywordOccurrences('`Closes #123` の続き');
    expect(result).toHaveLength(1);
    expect(result[0].category).toBe('in-code');
  });

  it('優先順位: 引用行の中のインラインコードは in-code を名乗る（in-quote ではない。より内側を優先）', () => {
    const result = findClosingKeywordOccurrences('> `Closes #123`');
    expect(result).toHaveLength(1);
    expect(result[0].category).toBe('in-code');
  });

  it('PR #1070 の実際の逐語（Closes #888 の反映）も trailing-text になる（実害の有無は別だが、規則上は落ちる）', () => {
    const result = findClosingKeywordOccurrences('Closes #888 の反映（Issue 自体は既に closed）');
    expect(result.length).toBeGreaterThan(0);
    expect(result[0].category).toBe('trailing-text');
  });

  it('この repo のタイトル規約が踏む形: fix: #123 の続き は trailing-text（型のつもりが閉じる指示に読める）', () => {
    const result = findClosingKeywordOccurrences('fix: #123 の続き');
    expect(result).toHaveLength(1);
    expect(result[0].category).toBe('trailing-text');
  });

  it('対照: fix: 台帳の重複の畳み込みを open() の1操作へ畳む（#1041） はキーワードと参照が隣接しないので通る（PR #1112 の実際のタイトル）', () => {
    expect(
      findClosingKeywordOccurrences('fix: 台帳の重複の畳み込みを open() の1操作へ畳む（#1041）'),
    ).toEqual([]);
  });
});

describe('findClosingKeywordOccurrences — 偽陽性の側（単語境界）', () => {
  it('fixture はキーワードの部分文字列を含むだけなので当たらない', () => {
    expect(findClosingKeywordOccurrences('fixture のテストを直す')).toEqual([]);
  });

  it('prefix はキーワードの部分文字列を含むだけなので当たらない', () => {
    expect(findClosingKeywordOccurrences('prefix #1 を付ける')).toEqual([]);
  });

  it('suffixes #1 は当たらない（"fixes" を部分文字列として含むが単語境界が無い）', () => {
    expect(findClosingKeywordOccurrences('suffixes #1 のテスト')).toEqual([]);
  });

  it('closedown #1 のような複合語も当たらない', () => {
    expect(findClosingKeywordOccurrences('closedown #1')).toEqual([]);
  });
});

describe('findClosingKeywordOccurrences — 参照の別表記', () => {
  it('GH-123 を拾う', () => {
    const result = findClosingKeywordOccurrences('誤って closes GH-123');
    expect(result).toHaveLength(1);
    expect(result[0].category).toBe('leading-text');
  });

  it('owner/repo#123 を拾う', () => {
    const result = findClosingKeywordOccurrences('closes octo-org/octo-repo#100 の続き');
    expect(result).toHaveLength(1);
    expect(result[0].category).toBe('trailing-text');
  });

  it('issue の URL を拾う', () => {
    const result = findClosingKeywordOccurrences(
      'closes https://github.com/takecchi/alteroid/issues/123 の続き',
    );
    expect(result).toHaveLength(1);
    expect(result[0].category).toBe('trailing-text');
  });

  it('GH-123 / owner/repo#123 / URL の単独行は通る', () => {
    expect(findClosingKeywordOccurrences('Closes GH-123')).toEqual([]);
    expect(findClosingKeywordOccurrences('Closes octo-org/octo-repo#100')).toEqual([]);
    expect(
      findClosingKeywordOccurrences('Closes https://github.com/takecchi/alteroid/issues/123'),
    ).toEqual([]);
  });
});

describe('CLOSING_KEYWORDS', () => {
  it('公式 doc の一覧と完全一致する9語', () => {
    expect(CLOSING_KEYWORDS).toEqual([
      'close',
      'closes',
      'closed',
      'fix',
      'fixes',
      'fixed',
      'resolve',
      'resolves',
      'resolved',
    ]);
  });
});

describe('evaluatePrClosingKeywords', () => {
  it('タイトル・本文・コミットのどれにも無ければ ok', () => {
    const result = evaluatePrClosingKeywords({
      title: 'feat: 何かをする',
      body: 'ふつうの PR 本文。',
      commits: [{ oid: 'a'.repeat(40), headline: 'feat: 何か', message: 'feat: 何か' }],
    });
    expect(result.verdict).toBe('ok');
    expect(result.findings).toEqual([]);
  });

  it('タイトル側で見つかる場合 → found（出所が「PR のタイトル」と分かる）', () => {
    const result = evaluatePrClosingKeywords({
      title: 'fix: #123 の続き',
      body: 'ふつうの PR 本文。',
      commits: [],
    });
    expect(result.verdict).toBe('found');
    expect(result.findings).toEqual([
      { source: 'PR のタイトル', category: 'trailing-text', line: 'fix: #123 の続き' },
    ]);
  });

  it('本文だけに在れば found（出所が「PR 本文」）', () => {
    const result = evaluatePrClosingKeywords({
      title: 'fix: 何か',
      body: 'Closes #993 の段1。',
      commits: [{ oid: 'a'.repeat(40), headline: 'fix: 何か', message: 'fix: 何か' }],
    });
    expect(result.verdict).toBe('found');
    expect(result.findings).toEqual([
      { source: 'PR 本文', category: 'trailing-text', line: 'Closes #993 の段1。' },
    ]);
  });

  it('コミットメッセージ側で見つかる場合 → found（出所が commit と、その短縮 sha・見出しが分かる）', () => {
    const result = evaluatePrClosingKeywords({
      title: 'fix: 何か',
      body: 'ふつうの PR 本文。',
      commits: [
        {
          oid: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
          headline: 'fix: 何か',
          message: 'fix: 何か\n\n誤って closes #993',
        },
      ],
    });
    expect(result.verdict).toBe('found');
    expect(result.findings).toEqual([
      {
        source: 'commit bbbbbbb "fix: 何か"',
        category: 'leading-text',
        line: '誤って closes #993',
      },
    ]);
  });

  it('タイトル・本文・コミットの複数箇所で見つかれば全件を集める（握り潰さない）', () => {
    const result = evaluatePrClosingKeywords({
      title: 'fix: #1 の続き',
      body: 'Closes #2 の段1。',
      commits: [{ oid: 'c'.repeat(40), headline: 'x', message: '誤って closes #3' }],
    });
    expect(result.verdict).toBe('found');
    expect(result.findings.map((f: { source: string }) => f.source)).toEqual([
      'PR のタイトル',
      'PR 本文',
      'commit ccccccc "x"',
    ]);
  });

  it('title が null なら unreadable（fail-closed）', () => {
    const result = evaluatePrClosingKeywords({ title: null, body: 'x', commits: [] });
    expect(result.verdict).toBe('unreadable');
  });

  it('body が null なら unreadable', () => {
    const result = evaluatePrClosingKeywords({ title: 'x', body: null, commits: [] });
    expect(result.verdict).toBe('unreadable');
  });

  it('commits が null なら unreadable', () => {
    const result = evaluatePrClosingKeywords({ title: 'x', body: 'x', commits: null });
    expect(result.verdict).toBe('unreadable');
  });

  it('title が空文字・body が空文字・commits が空配列は「読めた」結果であり ok（unreadable にしない）', () => {
    const result = evaluatePrClosingKeywords({ title: '', body: '', commits: [] });
    expect(result.verdict).toBe('ok');
  });
});

describe('formatVerdict', () => {
  it('ok は OK を名乗る', () => {
    const text = formatVerdict('1109', { verdict: 'ok', findings: [] });
    expect(text).toContain('check-pr-closing-keywords(#1109):');
    expect(text).toContain('OK');
  });

  it('found は NG と、各 finding の出所・分類・当たった行を名乗り、バッククォートの警告を出す', () => {
    const text = formatVerdict('1109', {
      verdict: 'found',
      findings: [{ source: 'PR 本文', category: 'in-code', line: '`Closes #123`' }],
    });
    expect(text).toContain('NG');
    expect(text).toContain('PR 本文');
    expect(text).toContain('in-code');
    expect(text).toContain('`Closes #123`');
    expect(text).toContain('バッククォートで囲んでも');
  });

  it('unreadable は「判定できなかった」と fail-closed であることを名乗る', () => {
    const text = formatVerdict('1109', { verdict: 'unreadable', findings: [] });
    expect(text).toContain('判定できなかった');
    expect(text).toContain('fail-closed');
  });
});
