import { describe, expect, it } from 'vitest';

import {
  evaluateMainCommitTrailers,
  evaluatePushRange,
  formatMainCommitVerdict,
  // @ts-expect-error -- 素の .mjs（型宣言を持たない build 用スクリプト）を読む
} from './check-main-commit-trailers-core.mjs';

/**
 * `check-main-commit-trailers` の歯（Issue #1314）。
 *
 * 本物の git は叩かない —— 合成したコミットで判定だけを確かめる
 * （`check-no-attribution-trailers.test.ts` と同じ理由）。
 *
 * **この歯は fixture として `Co-authored-by:` の逐語を持つ。** それ自体が対象に
 * なってはいけない——この門が読むのは**渡されたコミットメッセージだけ**で、repo の
 * ファイルを一切走査しない（core の doc、#785 の族）。
 *
 * 🔴 **この門が在る理由（core の doc の要旨）**: `no-attribution-trailers` は
 * `pull_request` でしか走らず、**squash コミットはマージした瞬間に初めて存在する**
 * ので、あの門は `main` に載る物を原理的に見られない。
 */

describe('evaluateMainCommitTrailers', () => {
  it('印の無いコミットだけなら clean', () => {
    const result = evaluateMainCommitTrailers({
      commits: [
        { oid: 'a'.repeat(40), headline: 'fix: 何かを直す', message: 'fix: 何かを直す\n\n本文' },
      ],
    });
    expect(result.verdict).toBe('clean');
    expect(result.findings).toEqual([]);
  });

  it('コミットが0本なら clean（tag だけの push 等。異常ではない）', () => {
    expect(evaluateMainCommitTrailers({ commits: [] }).verdict).toBe('clean');
  });

  it('🔴 GitHub が squash で足す Co-authored-by を当てる（#1305 で実際に入った形）', () => {
    const result = evaluateMainCommitTrailers({
      commits: [
        {
          oid: '150a84701c5de9e4d88c4f07195ef48f80678119',
          headline: 'chore: SDK を上げる (#1305)',
          message:
            'chore: SDK を上げる (#1305)\n\n本文\n\nCo-authored-by: github-actions[bot] <41898282+github-actions[bot]@users.noreply.github.com>',
        },
      ],
    });
    expect(result.verdict).toBe('found');
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].source).toContain('150a847');
  });

  it('複数のコミットのうち印を持つものだけを挙げる', () => {
    const result = evaluateMainCommitTrailers({
      commits: [
        { oid: 'b'.repeat(40), headline: 'ok', message: 'ok\n\n本文' },
        { oid: 'c'.repeat(40), headline: 'ng', message: 'ng\n\nCo-authored-by: someone <a@b.c>' },
        { oid: 'd'.repeat(40), headline: 'ok2', message: 'ok2' },
      ],
    });
    expect(result.verdict).toBe('found');
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].source).toContain('ccccccc');
  });

  it('⚠ commits が null なら unreadable（「0本だった」へ倒さない）', () => {
    expect(evaluateMainCommitTrailers({ commits: null }).verdict).toBe('unreadable');
  });

  it('⚠ message を持たない要素が混ざったら unreadable（読めた分だけで緑にしない）', () => {
    const result = evaluateMainCommitTrailers({
      commits: [{ oid: 'e'.repeat(40), headline: 'ok', message: 'ok' }, { oid: 'f'.repeat(40) }],
    });
    expect(result.verdict).toBe('unreadable');
  });

  it('sha が無い要素でも落ちず、(sha不明) と名乗る', () => {
    const result = evaluateMainCommitTrailers({
      commits: [{ message: 'x\n\nCo-authored-by: y <y@z>' }],
    });
    expect(result.verdict).toBe('found');
    expect(result.findings[0].source).toContain('sha不明');
  });
});

describe('evaluatePushRange', () => {
  it('両端が在れば使える', () => {
    expect(evaluatePushRange({ before: 'a'.repeat(40), after: 'b'.repeat(40) })).toEqual({
      usable: true,
      reason: null,
    });
  });

  it('🔴 before が全ゼロなら使えない（枝の作成。範囲を出せない）', () => {
    const r = evaluatePushRange({ before: '0'.repeat(40), after: 'b'.repeat(40) });
    expect(r.usable).toBe(false);
    expect(r.reason).toContain('全ゼロ');
  });

  it('🔴 after が全ゼロなら使えない（枝の削除）', () => {
    expect(evaluatePushRange({ before: 'a'.repeat(40), after: '0'.repeat(40) }).usable).toBe(false);
  });

  it('⚠ before が渡っていなければ使えない（「変更なし」へ倒さない）', () => {
    expect(evaluatePushRange({ after: 'b'.repeat(40) }).usable).toBe(false);
    expect(evaluatePushRange({ before: '', after: 'b'.repeat(40) }).usable).toBe(false);
  });

  it('⚠ after が渡っていなければ使えない', () => {
    expect(evaluatePushRange({ before: 'a'.repeat(40) }).usable).toBe(false);
  });
});

describe('formatMainCommitVerdict', () => {
  it('clean は OK と言う', () => {
    expect(formatMainCommitVerdict({ verdict: 'clean', findings: [] })).toContain('OK');
  });

  it('unreadable は「判定できない」と言う', () => {
    expect(formatMainCommitVerdict({ verdict: 'unreadable', findings: [] })).toContain(
      '判定できない',
    );
  });

  it('⛔ found のときは「履歴を書き換えて直さない」を一緒に出す', () => {
    const text = formatMainCommitVerdict({
      verdict: 'found',
      findings: [{ source: 'commit abc1234', markers: ['Co-Authored-By:'] }],
    });
    expect(text).toContain('abc1234');
    expect(text).toContain('履歴を書き換えて直さないこと');
  });
});
