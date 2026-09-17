import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// @ts-expect-error -- 素の .mjs（型宣言を持たない build 用スクリプト）を読む
import {
  evaluateIssueDoneTrailer,
  extractIssueDoneTrailerLines,
  formatEvaluation,
  TRAILER_NAME,
} from './issue-done-trailer-core.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/**
 * `issue-done-trailer` の歯（Issue #1134。#1109 の裏返し）。
 *
 * 本物の `gh` は叩かない —— 合成した PR 本文で判定だけを確かめる
 * （`check-pr-closing-keywords.test.ts` / `check-no-attribution-trailers.test.ts`
 * と同じ理由。ネットワークを持つ層は `issue-done-trailer.mjs` で、そちらは
 * `gh` を叩くので本物の Issue を閉じるリスクがあり、unit test の対象にしない
 * ——動作確認は dry-run の手動実行で行う）。
 *
 * ⚠️ **本番の Issue を実際に閉じる実験はしない。** ここは純粋関数だけを検査する。
 */

describe('evaluateIssueDoneTrailer — 番号を閉じる形', () => {
  it('番号1つ', () => {
    const result = evaluateIssueDoneTrailer('Alteroid-Issue-Done: 1072');
    expect(result.verdict).toBe('close');
    expect(result.issues).toEqual([{ number: 1072, sourceLine: 'Alteroid-Issue-Done: 1072' }]);
  });

  it('番号複数（カンマ区切り）', () => {
    const result = evaluateIssueDoneTrailer('Alteroid-Issue-Done: 1072, 1085');
    expect(result.verdict).toBe('close');
    expect(result.issues.map((i) => i.number)).toEqual([1072, 1085]);
  });

  it('番号複数（空白区切り）', () => {
    const result = evaluateIssueDoneTrailer('Alteroid-Issue-Done: 1072 1085');
    expect(result.verdict).toBe('close');
    expect(result.issues.map((i) => i.number)).toEqual([1072, 1085]);
  });

  it('# 付きの番号も受ける', () => {
    const result = evaluateIssueDoneTrailer('Alteroid-Issue-Done: #1072');
    expect(result.verdict).toBe('close');
    expect(result.issues).toEqual([{ number: 1072, sourceLine: 'Alteroid-Issue-Done: #1072' }]);
  });

  it('# 付きと無しが混在してもよい', () => {
    const result = evaluateIssueDoneTrailer('Alteroid-Issue-Done: #1072, 1085');
    expect(result.verdict).toBe('close');
    expect(result.issues.map((i) => i.number)).toEqual([1072, 1085]);
  });

  it('重複する番号は1つに畳む（最初に述べた行を sourceLine に残す）', () => {
    const body = ['Alteroid-Issue-Done: 1072', 'Alteroid-Issue-Done: 1072, 1085'].join('\n');
    const result = evaluateIssueDoneTrailer(body);
    expect(result.verdict).toBe('close');
    expect(result.issues).toEqual([
      { number: 1072, sourceLine: 'Alteroid-Issue-Done: 1072' },
      { number: 1085, sourceLine: 'Alteroid-Issue-Done: 1072, 1085' },
    ]);
  });
});

describe('evaluateIssueDoneTrailer — 降りる口1: none が全体で勝つ', () => {
  it('none 単独 → 何も閉じない', () => {
    const result = evaluateIssueDoneTrailer('Alteroid-Issue-Done: none');
    expect(result.verdict).toBe('none');
    expect(result.issues).toEqual([]);
    expect(result.contradicts).toBe(false);
  });

  it('none は大小文字を区別しない', () => {
    expect(evaluateIssueDoneTrailer('Alteroid-Issue-Done: NONE').verdict).toBe('none');
    expect(evaluateIssueDoneTrailer('Alteroid-Issue-Done: None').verdict).toBe('none');
  });

  it('⭐ none が同じ本文の番号付き行より勝つ（矛盾は contradicts で残す）', () => {
    const body = ['Alteroid-Issue-Done: 1072', 'Alteroid-Issue-Done: none'].join('\n');
    const result = evaluateIssueDoneTrailer(body);
    expect(result.verdict).toBe('none');
    expect(result.issues).toEqual([]);
    expect(result.contradicts).toBe(true);
  });

  it('none が後の行でも先の行でも同じく勝つ', () => {
    const body = ['Alteroid-Issue-Done: none', 'Alteroid-Issue-Done: 1072'].join('\n');
    const result = evaluateIssueDoneTrailer(body);
    expect(result.verdict).toBe('none');
    expect(result.contradicts).toBe(true);
  });
});

describe('evaluateIssueDoneTrailer — 降りる口2 相当: 範囲限定付きは閉じない', () => {
  it('⭐ #1109 で事故になった形（範囲限定の注記）は閉じない——GitHub のパーサと逆へ倒す', () => {
    const result = evaluateIssueDoneTrailer('Alteroid-Issue-Done: 993 (段1 のみ)');
    expect(result.verdict).toBe('none');
    expect(result.issues).toEqual([]);
    // GitHub のパーサとは違い、番号までを拾って閉じたりはしない。
  });

  it('日本語の説明が混ざった値も閉じない', () => {
    const result = evaluateIssueDoneTrailer('Alteroid-Issue-Done: 1072 を閉じる');
    expect(result.verdict).toBe('none');
  });

  it('値が空でも閉じない', () => {
    const result = evaluateIssueDoneTrailer('Alteroid-Issue-Done:');
    expect(result.verdict).toBe('none');
  });
});

describe('evaluateIssueDoneTrailer — trailer 無し', () => {
  it('trailer 行が1つも無い本文は absent（none とは区別する）', () => {
    const result = evaluateIssueDoneTrailer('これは普通の PR 本文である。#1072 に関連する。');
    expect(result.verdict).toBe('absent');
    expect(result.issues).toEqual([]);
  });

  it('空文字・null・undefined も absent', () => {
    expect(evaluateIssueDoneTrailer('').verdict).toBe('absent');
    expect(evaluateIssueDoneTrailer(null).verdict).toBe('absent');
    expect(evaluateIssueDoneTrailer(undefined).verdict).toBe('absent');
  });
});

describe('extractIssueDoneTrailerLines — 降りる口2: フェンス・引用の中は見ない', () => {
  it('``` で囲んだコードフェンスの中の trailer 行は見ない（例を書くための形として無害）', () => {
    const body = ['本文の説明。例えばこう書ける:', '```', 'Alteroid-Issue-Done: 1072', '```'].join(
      '\n',
    );
    expect(extractIssueDoneTrailerLines(body)).toEqual([]);
    expect(evaluateIssueDoneTrailer(body).verdict).toBe('absent');
  });

  it('`>` で始まる引用行の中の trailer 行は見ない', () => {
    const body = '> Alteroid-Issue-Done: 1072';
    expect(extractIssueDoneTrailerLines(body)).toEqual([]);
    expect(evaluateIssueDoneTrailer(body).verdict).toBe('absent');
  });

  it('フェンスの外に在る実際の trailer 行は、フェンスの中の例と共存しても正しく読む', () => {
    const body = [
      '書式の例:',
      '```',
      'Alteroid-Issue-Done: 999',
      '```',
      '',
      'Alteroid-Issue-Done: 1072',
    ].join('\n');
    const result = evaluateIssueDoneTrailer(body);
    expect(result.verdict).toBe('close');
    expect(result.issues.map((i) => i.number)).toEqual([1072]);
  });

  it('閉じられていないフェンスは fail-closed で末尾までコードとして扱う', () => {
    const body = ['```', 'Alteroid-Issue-Done: 1072'].join('\n');
    expect(extractIssueDoneTrailerLines(body)).toEqual([]);
  });

  it('引用行の前の空白は許す（`  > Alteroid-Issue-Done: 1072`）', () => {
    const body = '  > Alteroid-Issue-Done: 1072';
    expect(extractIssueDoneTrailerLines(body)).toEqual([]);
  });
});

describe('extractIssueDoneTrailerLines — 大小文字・前後空白', () => {
  it('trailer 名は大小文字を区別しない', () => {
    expect(evaluateIssueDoneTrailer('alteroid-issue-done: 1072').verdict).toBe('close');
    expect(evaluateIssueDoneTrailer('ALTEROID-ISSUE-DONE: 1072').verdict).toBe('close');
  });

  it('行頭・行末の空白は許す', () => {
    const result = evaluateIssueDoneTrailer('   Alteroid-Issue-Done: 1072   ');
    expect(result.verdict).toBe('close');
    expect(result.issues[0].number).toBe(1072);
  });

  it('コロンの前後の空白の有無を問わない', () => {
    expect(evaluateIssueDoneTrailer('Alteroid-Issue-Done:1072').verdict).toBe('close');
    expect(evaluateIssueDoneTrailer('Alteroid-Issue-Done :  1072').verdict).toBe('close');
  });

  it('TRAILER_NAME の値そのもの', () => {
    expect(TRAILER_NAME).toBe('Alteroid-Issue-Done');
  });
});

describe('formatEvaluation', () => {
  it('absent は「trailer 無し」を名乗る', () => {
    expect(formatEvaluation({ verdict: 'absent', issues: [], lines: [] })).toContain(
      'trailer 無し',
    );
  });

  it('none は理由と矛盾の有無を出す', () => {
    const text = formatEvaluation({
      verdict: 'none',
      issues: [],
      lines: [{ raw: 'Alteroid-Issue-Done: none', value: 'none', kind: 'none', numbers: [] }],
      contradicts: true,
    });
    expect(text).toContain('none');
    expect(text).toContain('none と番号の並びが同じ本文に同居');
  });

  it('close は件数と逐語の対応を出す', () => {
    const text = formatEvaluation({
      verdict: 'close',
      issues: [{ number: 1072, sourceLine: 'Alteroid-Issue-Done: 1072' }],
      lines: [],
    });
    expect(text).toContain('#1072');
    expect(text).toContain('Alteroid-Issue-Done: 1072');
  });
});

describe('配線の歯: .github/workflows/issue-done-trailer.yml', () => {
  const workflowText = readFileSync(
    path.join(ROOT, '.github/workflows/issue-done-trailer.yml'),
    'utf8',
  );

  /**
   * `check-scripts-wired.test.ts` と同じ発想——実装が在ることと配線されている
   * ことは別の事実なので、yml を実際に読んで確かめる。apply 相当の env を
   * 渡し忘れて「動いているように見えて何も閉じない」形を捕まえるのが目的。
   */
  it('pnpm issue-done-trailer を呼んでいる', () => {
    expect(workflowText).toMatch(/run:\s*pnpm issue-done-trailer/);
  });

  it('apply 相当の環境変数（ISSUE_DONE_TRAILER_APPLY）を渡している', () => {
    expect(workflowText).toMatch(/ISSUE_DONE_TRAILER_APPLY:\s*'1'/);
  });

  it('issues: write 権限を持つ', () => {
    expect(workflowText).toMatch(/issues:\s*write/);
  });

  it('merged == true の条件を持つ（マージされていない close を弾く）', () => {
    expect(workflowText).toContain('github.event.pull_request.merged == true');
  });

  it('base が default branch のときだけ走る条件を持つ', () => {
    expect(workflowText).toContain(
      'github.event.pull_request.base.ref == github.event.repository.default_branch',
    );
  });

  it('trigger は pull_request の closed だけである', () => {
    expect(workflowText).toMatch(/types:\s*\[closed\]/);
  });
});
