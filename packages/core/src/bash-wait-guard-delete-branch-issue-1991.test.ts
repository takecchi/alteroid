import { describe, expect, it } from 'vitest';

import { inspectBashCommand } from './bash-wait-guard.js';

/**
 * issue #1991 —— `gh pr merge 1 "-d"` / `gh pr merge 1 '-d'` のように、
 * 引用符で囲んだ短縮フラグ `-d` が弾かれない（`-d` の手前の lookbehind が
 * 空白しか認めないため）。bash は引用符を外して `-d` を gh へ渡すので、
 * 本物のフラグである。
 *
 * 既存の `bash-wait-guard-delete-branch-quoted-values.test.ts` に、基本形
 * （`"-d"` / `'-d'`）を固定した2本のテストが在る（元は `it.fails`——issue
 * #1991 が直った時点でトリップワイヤーが発火し、`it` に戻した）。この節は
 * その**追加の形**——`&&` の後ろ・timeout/env 前置きとの組み合わせ・他の
 * フラグの後ろ——を測る。
 *
 * `bash-wait-guard.ts` の `SHORT_DELETE_BRANCH_FLAG_SRC` で直した
 * ——`-d` の手前の lookbehind に「コマンド位置に在る引用符
 * （`"`/`'`）」も加えた。
 */
describe('gh-pr-merge-delete-branch: 引用符で囲んだ短縮フラグ -d（issue #1991、追加の形）', () => {
  it('`&&` の後ろの gh pr merge でも、二重引用符の -d を弾く', () => {
    expect(inspectBashCommand('true && gh pr merge 1 "-d"').blocked).toBe(true);
  });

  it('`&&` の後ろの gh pr merge でも、単一引用符の -d を弾く', () => {
    expect(inspectBashCommand("true && gh pr merge 1 '-d'").blocked).toBe(true);
  });

  it('env 前置きと組み合わさっても、二重引用符の -d を弾く', () => {
    expect(inspectBashCommand('GH_TOKEN=xxx gh pr merge 1 "-d"').blocked).toBe(true);
  });

  it('timeout 前置きと組み合わさっても、単一引用符の -d を弾く', () => {
    expect(inspectBashCommand("timeout 20 gh pr merge 1 '-d'").blocked).toBe(true);
  });

  it('timeout と env の両方の前置きと組み合わさっても、二重引用符の -d を弾く', () => {
    expect(inspectBashCommand('GH_TOKEN=xxx timeout 20 gh pr merge 1 "-d"').blocked).toBe(true);
  });

  it('他のフラグの後ろに続く二重引用符の -d でも弾く', () => {
    expect(inspectBashCommand('gh pr merge 1 --squash "-d"').blocked).toBe(true);
  });

  // ⚠️ 偽陽性にならないことも確認する（直す側で誤検知を増やさない根拠）。
  // `-d` の後ろは従来どおり `\b`（単語境界）——直後が単語構成文字だと
  // 成立しないので、`-dfoo`/`-dev` はこの直しの前後で変わらず通る。
  it('対照: 引用符で囲んだ -dfoo（本物の短縮フラグではない）は通す', () => {
    expect(inspectBashCommand('gh pr merge 1 "-dfoo"').blocked).toBe(false);
  });

  it('対照: 引用符で囲んだ -dev は通す', () => {
    expect(inspectBashCommand('gh pr merge 1 "-dev"').blocked).toBe(false);
  });

  // ⚠️ この main 正規表現が評価される時点で、--subject/-t/--body/-b の
  // 値の引用符の中身は `stripGhPrMergeQuotedSubjectBodyValues` が既に
  // 空白へ潰した後である。この直しがその潰された区間に新しく誤爆しない
  // ことを確認する（潰された区間には `-d` という文字自体が残らない）。
  it('対照: --subject の値の中の空白混じりの -d（引用符ごと潰される）は引き続き通す', () => {
    expect(inspectBashCommand('gh pr merge 1 --subject "note -d flag"').blocked).toBe(false);
  });

  it('対照: -t の値の中の -d（単一引用符、引用符ごと潰される）は引き続き通す', () => {
    expect(inspectBashCommand("gh pr merge 1 -t 'note -d flag'").blocked).toBe(false);
  });
});

/**
 * `$'…'`（ANSI-C クオート）—— PR #1990 の状態機械 `computeOutsideQuoteMask`
 * は `$'…'` を普通の単一引用符として読んでいたが、bash の `$'…'` の中では
 * `\'` がエスケープとして効く（普通の `'…'` には無い規則）。そのため状態が
 * ずれ、引用符の中の字面の `--subject "` をフラグと読み違える形が作れるか
 * を確認した（`.scratch/argv-dump.sh` で bash の実際の argv 分割を検証、
 * 2026-09-28。作業ツリー内の使い捨てスクリプトであり、この PR には含めて
 * いない）。
 *
 * ## 最初に試した形は、実はすり抜けではなかった（対照として残す）
 *
 * ```
 * gh pr merge 1 x$'y --subject "\'' --delete-branch $'"'"'"
 * ```
 * bash の読み（実測）: `ARG[4]=<xy --subject "'>`・
 * `ARG[5]=<--delete-branch>`（本物、引用符無し）・`ARG[6]=<"'>`。
 *
 * これは直す前の実装でも `blocked: true` だった——理由は状態機械が
 * 正しかったからではなく、`--subject "` の直後（`\` の直後の位置）に
 * バックスラッシュが来るため、`DOUBLE_QUOTED_VALUE_SRC`
 * （`"[^"\\$\u0060]*"`）が最初の1文字目で不一致になり、
 * `stripGhPrMergeQuotedSubjectBodyValues` がそもそも何も潰さなかった
 * （＝マスクの巧拙とは無関係に、地の文の `--delete-branch` がそのまま
 * 残って素朴な走査で捕まった）ため。**すり抜けを作れなかった形の実例**
 * として、下のテストで対照している。
 *
 * ## 実際にすり抜けを作れた形
 *
 * ```
 * gh pr merge 1 $'z\' --subject "y' --delete-branch '"'
 * ```
 * bash の読み（実測、`fakebin/gh` で argv を dump）:
 * `ARG[4]=<z' --subject "y>`（ANSI-C クオート `$'z\' --subject "y'`
 * ——中の `\'` がエスケープされた `'` として読まれ、クオートはその次の
 * 素の `'` まで続く——が1つの引数に結合）・
 * `ARG[5]=<--delete-branch>`（**本物の、引用符無しフラグ**）・
 * `ARG[6]=<">`（単一引用符 `'"'` の中身）。
 *
 * 直す前の状態機械の読み: `$` を特別扱いせず、`'` を普通の単一引用符の
 * 開始として読む。`single` 状態は `\` を特別扱いしないので、`\'` の `\` を
 * ただの文字として読み飛ばし、次の `'` を（本当はまだ閉じていないのに）
 * 閉じ引用符と誤認して `outside` へ早期に戻ってしまう。この誤った
 * `outside` の期間の中に書かれた `--subject "` が「本物のフラグ」だと
 * 誤読され（指摘3と同じ形）、続く空白混じりの `y' --delete-branch ` が
 * 「`--subject` の二重引用符の値」として素直な閉じ位置まで見つかって
 * しまい、**本物の `--delete-branch` ごと空白へ潰されて検出から消える**。
 *
 * 直す前は `inspectBashCommand` がこの文字列に対し `{ blocked: false }`
 * を返していた（このテストは直す前は赤だった——`Error: Expect test to
 * fail` ではなく、実際に inner assertion が失敗するという意味の赤）。
 *
 * ## 直し方
 *
 * `computeOutsideQuoteMask` に `$'` を専用の状態 `ansiC` として追加した
 * （`bash-wait-guard.ts` の該当 doc 参照）——`double` と同じく `\` が
 * 直後の1文字を読み飛ばすので、上の実例は正しく閉じ位置まで `ansiC` の
 * まま追えるようになり、`--subject` の開始位置が `outside` ではないと
 * 正しく判定されて潰されなくなる。
 */
describe("gh-pr-merge-delete-branch: $'…'（ANSI-C クオート）で computeOutsideQuoteMask を欺けるか（issue #1991 の作業中に発見）", () => {
  it('対照: 最初に試した形（\\ が --subject " の直後に来る）は直す前から弾けていた', () => {
    const command = String.raw`gh pr merge 1 x$'y --subject "\'' --delete-branch $'"'"'"`;
    expect(inspectBashCommand(command).blocked).toBe(true);
  });

  it("[issue #1991 の作業中に発見・同じ修正で直った] $'…\\'…' の中の字面 --subject \" に化かされず、本物の --delete-branch を弾く", () => {
    const command = String.raw`gh pr merge 1 $'z\' --subject "y' --delete-branch '"'`;
    expect(inspectBashCommand(command).blocked).toBe(true);
  });

  it("偽陽性にならないこと —— $'…' の中に単一引用符を含む普通の値は引き続き通す", () => {
    // ANSI-C クオートの中にエスケープされた単一引用符が在っても、
    // gh pr merge とは無関係な地の文（--delete-branch/-d の字面を含まない）
    // なら通ることを確認する。
    const command = String.raw`gh pr merge 1 --subject $'it\'s fine, no flag here'`;
    expect(inspectBashCommand(command).blocked).toBe(false);
  });
});
