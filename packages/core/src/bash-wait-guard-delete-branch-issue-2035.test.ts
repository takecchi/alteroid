import { describe, expect, it } from 'vitest';

import { inspectBashCommand } from './bash-wait-guard.js';
import { expectNotSuperlinear } from './time-growth.test-support.js';

/**
 * issue #2035 —— `GH_PR_MERGE_DELETE_BRANCH_RE` の外側の lookbehind
 * （`(?<=^|[;&|\n])`）は、行頭・`;`・`&`・`|`・改行の**直後**しかコマンドの
 * 位置と認めていなかった。bash の予約語（`if`/`then`/`elif`/`else`/
 * `while`/`until`/`do`/`coproc`/`time`/`!`）やグルーピング（`(`・`)`・
 * バッククォート）の直後にもコマンドは来るが、この直後はどの区切り文字
 * でもないため、検出をすり抜けていた。
 *
 * 依頼者が main 9b3915c の写しで実測した結果（`inspectBashCommand(cmd)
 * .blocked`）は、Issue 本文に書かれた6形と、作業中に見つけた9形の合計15形
 * すべてが `false`（すり抜け）だった。直し方は `bash-wait-guard.ts` の
 * `SHELL_KEYWORD_PREFIX_SRC`・`COMMAND_POSITION_LOOKBEHIND_SRC` の doc 参照。
 */
describe('gh-pr-merge-delete-branch: 予約語・グルーピングの直後で検出をすり抜ける（issue #2035）', () => {
  const knownGaps: ReadonlyArray<[string, string]> = [
    ['if 〜 then（Issue 本文）', 'if true; then gh pr merge 1 --delete-branch; fi'],
    ['if 〜 else（Issue 本文）', 'if false; then true; else gh pr merge 1 --delete-branch; fi'],
    ['for 〜 do（Issue 本文）', 'for i in 1; do gh pr merge $i --delete-branch; done'],
    ['{ グルーピング（Issue 本文）', '{ gh pr merge 1 --delete-branch; }'],
    ['( サブシェル（Issue 本文）', '(gh pr merge 1 --delete-branch)'],
    ['! 否定（Issue 本文）', '! gh pr merge 1 --delete-branch'],
    ['if の条件節そのもの', 'if gh pr merge 1 --delete-branch; then :; fi'],
    ['while の条件節そのもの（-d）', 'while gh pr merge 1 -d; do :; done'],
    ['until の条件節そのもの（-d）', 'until gh pr merge 1 -d; do :; done'],
    ['time 前置き', 'time gh pr merge 1 --delete-branch'],
    ['$(...) コマンド置換', 'echo $(gh pr merge 1 --delete-branch)'],
    ['バッククォートのコマンド置換', 'echo `gh pr merge 1 --delete-branch`'],
    ['case 〜 esac', 'case x in *) gh pr merge 1 --delete-branch;; esac'],
    ['coproc', 'coproc gh pr merge 1 --delete-branch'],
    ['関数定義の本体（-d）', 'f() { gh pr merge 1 -d; }'],
  ];

  for (const [label, command] of knownGaps) {
    it(`${label}: 弾く`, () => {
      const verdict = inspectBashCommand(command);
      expect(verdict.blocked).toBe(true);
      if (!verdict.blocked) throw new Error('unreachable');
      expect(verdict.form).toBe('gh-pr-merge-delete-branch');
    });
  }

  it('組み合わせ（if/!/{/time/env/timeout の前置きが全部重なっても弾く）', () => {
    const command = 'if a; then ! { time -p GH_TOKEN=x timeout 5 gh pr merge 1 -d; }; fi';
    const verdict = inspectBashCommand(command);
    expect(verdict.blocked).toBe(true);
    if (!verdict.blocked) throw new Error('unreachable');
    expect(verdict.form).toBe('gh-pr-merge-delete-branch');
  });
});

/**
 * 偽陽性にならないこと —— 予約語・グルーピングを前置きとして読み飛ばす形を
 * 足しても、既存の「通す形」が巻き込まれて弾かれるようになっていないか。
 */
describe('gh-pr-merge-delete-branch: 予約語・グルーピングの前置きを足しても偽陽性にならない', () => {
  it('then がコマンドの位置に無ければ通す（echo の引数としての then）', () => {
    expect(inspectBashCommand('echo then gh pr merge 1 --delete-branch').blocked).toBe(false);
  });

  it('--delete-branch を付けていない if 〜 then は通す', () => {
    expect(inspectBashCommand('if true; then gh pr merge 1 --squash; fi').blocked).toBe(false);
  });

  it('引用符の中の env 前置き付き gh pr merge --delete-branch は通す（既存の対照と同種）', () => {
    expect(inspectBashCommand('echo "GH_TOKEN=x gh pr merge 1 --delete-branch"').blocked).toBe(
      false,
    );
  });

  it('--subject の値の中に { gh pr merge -d } という字面が在っても通す', () => {
    expect(
      inspectBashCommand('gh pr merge 1 --subject "fix(guard): { gh pr merge -d }" --squash')
        .blocked,
    ).toBe(false);
  });

  // ⚠️ この直しは「弾く」側を広げる変更なので、誤検知が増える向きは受け入れる
  // （`SHELL_KEYWORD_PREFIX_SRC` の doc「誤検知の向きは受け入れる」参照）。
  // 引用符の中の `(` の直後という、この直しが新しく拾う位置がまさにこれ——
  // 以前から在る「引用符の中の演算子の直後」の誤検知（`echo "; gh pr merge
  // 1 -d"` 等、既存のテストが対照している）と同じ族なので、新しい歯としては
  // 「弾く」ことを歯にする（弱体化を防ぐため、期待どおりの向きを明記する）。
  it('⚠️ 受け入れる誤検知: 引用符の中の "(gh pr merge 1 -d)" は、この直しで弾くようになる', () => {
    expect(inspectBashCommand('echo "(gh pr merge 1 -d)"').blocked).toBe(true);
  });
});

/**
 * CRLF の確かめ（Issue の「⚠️ 確かめていないこと」の1つ目）——依頼者が
 * 実測済み: これらはこの PR で直す前（main 9b3915c）から既に弾けている
 * （`\n` を含む文字列自体は改行として lookbehind に拾われるため。CRLF は
 * `\r\n` だが、`\n` の直前に `\r` が在っても lookbehind の一致には影響しない
 * ——`\r` は「行頭・`;`・`&`・`|`・改行」のどれでもないので、`\n` そのものが
 * 区切りとして機能する）。回帰していないことを歯として固定する。
 */
describe('gh-pr-merge-delete-branch: CRLF（直す前から弾けている歯、回帰確認）', () => {
  it('if 〜 then の本体が CRLF で改行されていても弾く', () => {
    expect(inspectBashCommand('if true; then\r\ngh pr merge 1 -d\r\nfi').blocked).toBe(true);
  });

  it('単純な2行の CRLF でも弾く', () => {
    expect(inspectBashCommand('echo hi\r\ngh pr merge 1 -d').blocked).toBe(true);
  });

  it('ヒアドキュメントの終端行が CRLF でも、終端後の gh pr merge -d は弾く', () => {
    expect(inspectBashCommand('cat <<EOF\r\nx\r\nEOF\r\ngh pr merge 1 -d').blocked).toBe(true);
  });
});

/**
 * 時間の歯 —— 既存の `bash-wait-guard-delete-branch-timeout-prefix.test.ts`
 * の「前置きの繰り返しが長くても後戻りで爆発しない」と同じ形。
 *
 * `!`/`{` を lookbehind の文字集合へ足さなかった判断（`SHELL_KEYWORD_
 * PREFIX_SRC` の doc）と、予約語の直後の空白を `\s+` ではなく `[ \t]+` に
 * 絞った判断（同 doc）の両方が、実際に2乗の後戻りを生まないことを測る。
 *
 * issue #2187 —— 壁時計の絶対値（`TIME_BUDGET_MS = 200`）から伸びの比へ
 * 替えた。`n * factor`（既定 factor=4）を、直す前にテストしていた繰り返し
 * 回数（3000 / 10000 / 8000）に揃えてある（依頼者の実測では `!`/`{` を
 * lookbehind に足した誤った版は 546ms、正しい版は 5.9ms）。
 */
describe('gh-pr-merge-delete-branch: 予約語・グルーピングの繰り返しが長くても後戻りで爆発しない（issue #2035）', () => {
  it('予約語の繰り返し（gh pr merge を含まない）が線形に終わる', () => {
    const makeInput = (n: number) => `${'if then do time ! { '.repeat(n)}x`;
    expect(inspectBashCommand(makeInput(750 * 4)).blocked).toBe(false);
    expectNotSuperlinear(inspectBashCommand, makeInput, { n: 750 });
  });

  // `[ \t]+` の判断を測る歯。予約語の後ろを `\s+` にした試作では 589.9ms、
  // この版では 3.4ms（2026-09-28T23:29Z 実測）。
  it('改行で区切った予約語の繰り返し（gh pr merge を含まない）が線形に終わる', () => {
    const makeInput = (n: number) => `${'then\n'.repeat(n)}x`;
    expect(inspectBashCommand(makeInput(2500 * 4)).blocked).toBe(false);
    expectNotSuperlinear(inspectBashCommand, makeInput, { n: 2500 });
  });

  it('( の繰り返し（gh pr merge を含まない）が線形に終わる', () => {
    const makeInput = (n: number) => `${'( then '.repeat(n)}x`;
    expect(inspectBashCommand(makeInput(2000 * 4)).blocked).toBe(false);
    expectNotSuperlinear(inspectBashCommand, makeInput, { n: 2000 });
  });

  it('予約語の繰り返しの末尾に gh pr merge --delete-branch が来ても弾き、かつ後戻りが爆発しない', () => {
    const makeInput = (n: number) =>
      `${'if then do time ! { '.repeat(n)}gh pr merge 1 --delete-branch`;
    expect(inspectBashCommand(makeInput(750 * 4)).blocked).toBe(true);
    expectNotSuperlinear(inspectBashCommand, makeInput, { n: 750 });
  });
});
