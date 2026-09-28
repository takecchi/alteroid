import { describe, expect, it } from 'vitest';

import { inspectBashCommand } from './bash-wait-guard.js';

/**
 * issue #1991 —— `gh pr merge 1 "-d"` / `gh pr merge 1 '-d'` のように、
 * 引用符で囲んだ短縮フラグ `-d` が弾かれない（`-d` の手前の lookbehind が
 * 空白しか認めないため）。bash は引用符を外して `-d` を gh へ渡すので、
 * 本物のフラグである。
 *
 * 既存の `bash-wait-guard-delete-branch-quoted-values.test.ts` に、基本形
 * （`"-d"` / `'-d'`）を望む挙動で固定した `it.fails` が2本在る。この節は
 * その**追加の形**——`&&` の後ろ・timeout/env 前置きとの組み合わせ・他の
 * フラグの後ろ——を測る。
 *
 * ⚠️ これらは #1991 が直るまで `it.fails` のまま（赤で固定し、直ったら
 * `it` に戻す運用は既存ファイルと同じ）。
 */
describe('gh-pr-merge-delete-branch: 引用符で囲んだ短縮フラグ -d（issue #1991、追加の形）', () => {
  it.fails('`&&` の後ろの gh pr merge でも、二重引用符の -d を弾きたい', () => {
    expect(inspectBashCommand('true && gh pr merge 1 "-d"').blocked).toBe(true);
  });

  it.fails('`&&` の後ろの gh pr merge でも、単一引用符の -d を弾きたい', () => {
    expect(inspectBashCommand("true && gh pr merge 1 '-d'").blocked).toBe(true);
  });

  it.fails('env 前置きと組み合わさっても、二重引用符の -d を弾きたい', () => {
    expect(inspectBashCommand('GH_TOKEN=xxx gh pr merge 1 "-d"').blocked).toBe(true);
  });

  it.fails('timeout 前置きと組み合わさっても、単一引用符の -d を弾きたい', () => {
    expect(inspectBashCommand("timeout 20 gh pr merge 1 '-d'").blocked).toBe(true);
  });

  it.fails('timeout と env の両方の前置きと組み合わさっても、二重引用符の -d を弾きたい', () => {
    expect(inspectBashCommand('GH_TOKEN=xxx timeout 20 gh pr merge 1 "-d"').blocked).toBe(true);
  });

  it.fails('他のフラグの後ろに続く二重引用符の -d でも弾きたい', () => {
    expect(inspectBashCommand('gh pr merge 1 --squash "-d"').blocked).toBe(true);
  });

  // ⚠️ 偽陽性にならないことも確認する（直す側で誤検知を増やさない根拠）。
  it('対照: 引用符で囲んだ -dfoo（本物の短縮フラグではない）は通す', () => {
    expect(inspectBashCommand('gh pr merge 1 "-dfoo"').blocked).toBe(false);
  });

  it('対照: 引用符で囲んだ -dev は通す', () => {
    expect(inspectBashCommand('gh pr merge 1 "-dev"').blocked).toBe(false);
  });

  it('対照: --subject の値の中の空白混じりの -d（引用符ごと潰される）は引き続き通す', () => {
    expect(inspectBashCommand('gh pr merge 1 --subject "note -d flag"').blocked).toBe(false);
  });

  it('対照: -t の値の中の -d（単一引用符、引用符ごと潰される）は引き続き通す', () => {
    expect(inspectBashCommand("gh pr merge 1 -t 'note -d flag'").blocked).toBe(false);
  });
});

/**
 * `$'…'`（ANSI-C クオート）—— PR #1990 の状態機械 `computeOutsideQuoteMask`
 * は `$'…'` を普通の単一引用符として読むが、bash の `$'…'` の中では `\'` が
 * エスケープとして効く（普通の `'…'` には無い規則）。そのため状態がずれ、
 * 引用符の中の字面の `--subject "` をフラグと読み違える形が作れるかを
 * 確認した（`.scratch/argv-dump.sh` で bash の実際の argv 分割を検証、
 * 2026-09-28）。
 *
 * ## 最初に試した形は、実はすり抜けではなかった（対照として残す）
 *
 * ```
 * gh pr merge 1 x$'y --subject "\'' --delete-branch $'"'"'"
 * ```
 * これは `--subject "` の直後にバックスラッシュが来るため、
 * `DOUBLE_QUOTED_VALUE_SRC` が最初の1文字目で不一致になり、そもそも
 * 何も潰されない（マスクの巧拙とは無関係に、地の文の `--delete-branch`
 * がそのまま残って捕まる）。
 *
 * ## 実際にすり抜けを作れた形
 *
 * ```
 * gh pr merge 1 $'z\' --subject "y' --delete-branch '"'
 * ```
 * bash の読み（実測、`fakebin/gh` で argv を dump）: ANSI-C クオート
 * `$'z\' --subject "y'`（中の `\'` がエスケープされた `'` として読まれ、
 * クオートはその次の素の `'` まで続く）が1つの引数に結合され、
 * **本物の、引用符無しの `--delete-branch`** が続く。
 *
 * 直す前の状態機械は `$` を特別扱いせず、`'` を普通の単一引用符として
 * 読むため、`\'` の `\` をただの文字として読み飛ばし、次の `'` を
 * （本当はまだ閉じていないのに）閉じ引用符と誤認して早期に `outside` へ
 * 戻ってしまう。この結果、本物の `--delete-branch` を含む区間が
 * `--subject` の値と誤認されて空白へ潰され、検出から消える。
 */
describe("gh-pr-merge-delete-branch: $'…'（ANSI-C クオート）で computeOutsideQuoteMask を欺けるか（issue #1991 の作業中に発見）", () => {
  it('対照: 最初に試した形（\\ が --subject " の直後に来る）は直す前から弾けていた', () => {
    const command = String.raw`gh pr merge 1 x$'y --subject "\'' --delete-branch $'"'"'"`;
    expect(inspectBashCommand(command).blocked).toBe(true);
  });

  it.fails(
    "$'…\\'…' の中の字面 --subject \" に化かされず、本物の --delete-branch を弾きたい",
    () => {
      const command = String.raw`gh pr merge 1 $'z\' --subject "y' --delete-branch '"'`;
      expect(inspectBashCommand(command).blocked).toBe(true);
    },
  );

  it("偽陽性にならないこと —— $'…' の中に単一引用符を含む普通の値は引き続き通す", () => {
    const command = String.raw`gh pr merge 1 --subject $'it\'s fine, no flag here'`;
    expect(inspectBashCommand(command).blocked).toBe(false);
  });
});
