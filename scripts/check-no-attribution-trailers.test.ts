import { describe, expect, it } from 'vitest';

import {
  ATTRIBUTION_MARKERS,
  commitFullMessage,
  evaluateNoAttributionTrailers,
  findAttributionMarkers,
  formatVerdict,
  // @ts-expect-error -- 素の .mjs（型宣言を持たない build 用スクリプト）を読む
} from './check-no-attribution-trailers-core.mjs';

/**
 * `check-no-attribution-trailers` の歯（Issue #1020）。
 *
 * 本物の `gh pr view` は叩かない —— 合成した本文・コミットメッセージで判定
 * だけを確かめる（`check-pr-green.test.ts` / `check-required-status-checks.test.ts`
 * と同じ理由）。
 *
 * **この歯は fixture として `Co-Authored-By:` / `🤖 Generated with` の逐語を
 * 持つ。** それ自体が対象になってはいけない——この門は repo のファイルを
 * 一切走査しない（`check-no-attribution-trailers-core.mjs` の doc、#785 の族）
 * ので、この歯の中身がこの門自身に引っかかることは無い。
 */

describe('findAttributionMarkers', () => {
  it('Co-Authored-By: を当てる（規約どおりの表記）', () => {
    expect(findAttributionMarkers('本文\n\nCo-Authored-By: Claude <noreply@example.com>')).toEqual([
      'Co-Authored-By:',
    ]);
  });

  it('Co-authored-by: も当てる（実測 2026-09-15、6a74c9d に同居していた表記ゆれ）', () => {
    expect(
      findAttributionMarkers('本文\n\nCo-authored-by: Claude Opus 5 <noreply@example.com>'),
    ).toEqual(['Co-Authored-By:']);
  });

  it('🤖 Generated with を当てる', () => {
    expect(
      findAttributionMarkers('🤖 Generated with [Claude Code](https://claude.com/claude-code)'),
    ).toEqual(['🤖 Generated with']);
  });

  it('両方が同じテキストに在れば両方を返す', () => {
    const text = [
      '本文の末尾。',
      '',
      '🤖 Generated with [Claude Code](https://claude.com/claude-code)',
      '',
      'Co-Authored-By: Claude <noreply@example.com>',
    ].join('\n');
    expect(findAttributionMarkers(text)).toEqual(['Co-Authored-By:', '🤖 Generated with']);
  });

  it('どちらも無ければ空配列', () => {
    expect(findAttributionMarkers('ふつうの PR 本文。トレーラは無い。')).toEqual([]);
  });

  it('空文字・null・undefined は空配列（例外にしない）', () => {
    expect(findAttributionMarkers('')).toEqual([]);
    expect(findAttributionMarkers(null)).toEqual([]);
    expect(findAttributionMarkers(undefined)).toEqual([]);
  });

  it('🤖 だけ、Generated with だけでは当たらない（両方揃って初めて印になる）', () => {
    expect(findAttributionMarkers('🤖 で始まる、関係ない一文。')).toEqual([]);
    expect(findAttributionMarkers('Generated with love, by a human.')).toEqual([]);
  });

  it('ATTRIBUTION_MARKERS は2件（co-authored-by / generated-with）', () => {
    expect(ATTRIBUTION_MARKERS.map((m: { id: string }) => m.id)).toEqual([
      'co-authored-by',
      'generated-with',
    ]);
  });

  it('文中で言及しているだけなら当たらない（#1349。行頭だけを見る）', () => {
    expect(
      findAttributionMarkers('本文で `Co-Authored-By:` トレーラは付けていない、と書く。'),
    ).toEqual([]);
    expect(
      findAttributionMarkers(
        'この PR の本文には 🤖 Generated with という文字列を書いていない、と説明する。',
      ),
    ).toEqual([]);
  });

  it('行頭の逐語は当たる（2行目以降でも。m フラグが要る）', () => {
    expect(
      findAttributionMarkers('本文の1行目。\nCo-Authored-By: Claude <noreply@example.com>'),
    ).toEqual(['Co-Authored-By:']);
    expect(
      findAttributionMarkers(
        '本文の1行目。\n🤖 Generated with [Claude Code](https://claude.com/claude-code)',
      ),
    ).toEqual(['🤖 Generated with']);
  });

  it('コードブロック内でも行頭なら当たる（囲みは除外にならない）', () => {
    const text = [
      '```',
      'Co-authored-by: github-actions[bot] <41898282+github-actions[bot]@users.noreply.github.com>',
      '```',
    ].join('\n');
    expect(findAttributionMarkers(text)).toEqual(['Co-Authored-By:']);
  });

  it('大小文字違いでも当たる（co-AUTHORED-by: のような表記ゆれ）', () => {
    expect(findAttributionMarkers('co-AUTHORED-by: Claude <noreply@example.com>')).toEqual([
      'Co-Authored-By:',
    ]);
  });

  it('行頭に空白があっても当たる（^\\s* の分）', () => {
    expect(findAttributionMarkers('   Co-Authored-By: Claude <noreply@example.com>')).toEqual([
      'Co-Authored-By:',
    ]);
    expect(
      findAttributionMarkers('\t🤖 Generated with [Claude Code](https://claude.com/claude-code)'),
    ).toEqual(['🤖 Generated with']);
  });
});

describe('commitFullMessage', () => {
  it('見出しと本文を1行空けて連結する', () => {
    expect(
      commitFullMessage('fix: 何かを直す', 'Co-Authored-By: Claude <noreply@example.com>'),
    ).toBe('fix: 何かを直す\n\nCo-Authored-By: Claude <noreply@example.com>');
  });

  it('本文が空なら見出しだけを返す（末尾に空行を作らない）', () => {
    expect(commitFullMessage('fix: 何かを直す', '')).toBe('fix: 何かを直す');
    expect(commitFullMessage('fix: 何かを直す', undefined)).toBe('fix: 何かを直す');
  });

  it('見出しが無ければ本文だけを返す', () => {
    expect(commitFullMessage(undefined, 'Co-Authored-By: Claude <noreply@example.com>')).toBe(
      '\n\nCo-Authored-By: Claude <noreply@example.com>',
    );
  });
});

describe('evaluateNoAttributionTrailers', () => {
  it('本文にもコミットにも印が無ければ clean', () => {
    const result = evaluateNoAttributionTrailers({
      body: 'ふつうの PR 本文。',
      commits: [
        {
          oid: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          headline: 'fix: 何か',
          message: 'fix: 何か',
        },
      ],
    });
    expect(result.verdict).toBe('clean');
    expect(result.findings).toEqual([]);
  });

  it('本文だけに印が在れば found（squash マージが本文をコミットメッセージへ写す経路。今日の実害 63a33dd）', () => {
    const result = evaluateNoAttributionTrailers({
      body: '## 結論\n\n変更点。\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)',
      commits: [
        {
          oid: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          headline: 'fix: 何か',
          message: 'fix: 何か',
        },
      ],
    });
    expect(result.verdict).toBe('found');
    expect(result.findings).toEqual([{ source: 'PR 本文', markers: ['🤖 Generated with'] }]);
  });

  it('コミットメッセージだけに印が在れば found', () => {
    const result = evaluateNoAttributionTrailers({
      body: 'ふつうの PR 本文。',
      commits: [
        {
          oid: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
          headline: 'fix: 何か',
          message: 'fix: 何か\n\nCo-Authored-By: Claude <noreply@example.com>',
        },
      ],
    });
    expect(result.verdict).toBe('found');
    expect(result.findings).toEqual([
      { source: 'commit bbbbbbb "fix: 何か"', markers: ['Co-Authored-By:'] },
    ]);
  });

  it('本文と複数コミットのどちらにも在れば、全件を findings に集める（握り潰さない）', () => {
    const result = evaluateNoAttributionTrailers({
      body: '🤖 Generated with [Claude Code](https://claude.com/claude-code)',
      commits: [
        {
          oid: 'cccccccccccccccccccccccccccccccccccccccc',
          headline: 'feat: 何か',
          message: 'feat: 何か\n\nCo-Authored-By: Claude <noreply@example.com>',
        },
        {
          oid: 'dddddddddddddddddddddddddddddddddddddddd',
          headline: 'fix: 別の何か',
          message: 'fix: 別の何か',
        },
      ],
    });
    expect(result.verdict).toBe('found');
    expect(result.findings).toEqual([
      { source: 'PR 本文', markers: ['🤖 Generated with'] },
      { source: 'commit ccccccc "feat: 何か"', markers: ['Co-Authored-By:'] },
    ]);
  });

  it('本文が読めなければ unreadable（fail-closed。「見つからなかった」にしない）', () => {
    const result = evaluateNoAttributionTrailers({
      body: null,
      commits: [{ oid: 'a', headline: 'x', message: 'x' }],
    });
    expect(result.verdict).toBe('unreadable');
    expect(result.findings).toEqual([]);
  });

  it('コミット一覧が読めなければ unreadable（本文が clean でも赤へ倒す）', () => {
    const result = evaluateNoAttributionTrailers({
      body: 'ふつうの PR 本文。',
      commits: null,
    });
    expect(result.verdict).toBe('unreadable');
  });

  it('本文もコミットも読めなければ unreadable', () => {
    const result = evaluateNoAttributionTrailers({ body: null, commits: null });
    expect(result.verdict).toBe('unreadable');
  });

  it('本文が空文字・コミット0件は「読めた」結果であり unreadable にしない', () => {
    const result = evaluateNoAttributionTrailers({ body: '', commits: [] });
    expect(result.verdict).toBe('clean');
  });

  it('sha・headline が欠けても例外を投げず、分かる形で source を作る', () => {
    const result = evaluateNoAttributionTrailers({
      body: '',
      commits: [
        { oid: null, headline: '', message: 'Co-Authored-By: Claude <noreply@example.com>' },
      ],
    });
    expect(result.verdict).toBe('found');
    expect(result.findings).toEqual([{ source: 'commit (sha不明)', markers: ['Co-Authored-By:'] }]);
  });
});

describe('formatVerdict', () => {
  it('clean は OK を名乗る', () => {
    const text = formatVerdict('1234', { verdict: 'clean', findings: [] });
    expect(text).toContain('check-no-attribution-trailers(#1234):');
    expect(text).toContain('OK');
  });

  it('found は NG と、各 finding の source・markers を名乗る', () => {
    const text = formatVerdict('1234', {
      verdict: 'found',
      findings: [{ source: 'PR 本文', markers: ['🤖 Generated with'] }],
    });
    expect(text).toContain('NG');
    expect(text).toContain('PR 本文');
    expect(text).toContain('🤖 Generated with');
  });

  it('unreadable は「判定できなかった」と fail-closed であることを名乗る', () => {
    const text = formatVerdict('1234', { verdict: 'unreadable', findings: [] });
    expect(text).toContain('判定できなかった');
    expect(text).toContain('fail-closed');
  });
});
