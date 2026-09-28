import { describe, expect, it } from 'vitest';

import { inspectBashCommand } from './bash-wait-guard.js';

/**
 * issue #1910 —— `gh pr merge` の `--subject` / `-t` / `--body` / `-b`
 * （`--subject=…` / `--body=…` の形も）に**値として渡した引用符の中**に
 * `--delete-branch` / `-d` の字面が在ると、実際にはフラグが付いていなくても
 * `GH_PR_MERGE_DELETE_BRANCH_RE` が誤検知する。
 *
 * 実測（2026-09-28T00:32Z、Issue #1910 本文）: PR #1887 をマージしようとして
 * 次の形が拒否された——
 *
 * ```
 * gh pr merge 1887 --squash --subject "fix: gh pr merge --delete-branch ガードが…" --body-file <file>
 * ```
 *
 * 件名から `--delete-branch` の字面を外すと通った（`15ca1a1`）。
 *
 * ## この節が確かめること
 *
 * (A) 通すべき形（誤検知）—— `--subject` / `-t` / `--body` / `-b` の**値の
 * 中だけ**に `--delete-branch` / `-d` の字面が在り、実際のフラグではない形。
 */
describe('gh-pr-merge-delete-branch: 件名・本文の値の引用符の中の字面は誤検知しない（issue #1910）', () => {
  it('Issue #1910 の実例（件名に --delete-branch という字面を含む）を通す', () => {
    const v = inspectBashCommand(
      'gh pr merge 1887 --squash --subject "fix: gh pr merge --delete-branch ガードが && 後の timeout 前置きを弾かない (#1887)" --body-file f',
    );
    expect(v.blocked).toBe(false);
  });

  it('--body の二重引用符の値の中の --delete-branch は通す', () => {
    expect(
      inspectBashCommand('gh pr merge 1 --body "この変更で --delete-branch の誤検知を直した"')
        .blocked,
    ).toBe(false);
  });

  it('-t（--subject の短縮形）の単一引用符の値の中の -d は通す', () => {
    expect(
      inspectBashCommand("gh pr merge 1 -t 'note: -d flag guard behavior'").blocked,
    ).toBe(false);
  });

  it('-b（--body の短縮形）の単一引用符の値の中の --delete-branch は通す', () => {
    expect(
      inspectBashCommand("gh pr merge 1 -b 'mentions --delete-branch in prose'").blocked,
    ).toBe(false);
  });

  it('--subject=値 の形（= 区切り、二重引用符）の中の --delete-branch は通す', () => {
    expect(
      inspectBashCommand('gh pr merge 1 --subject="uses --delete-branch in text"').blocked,
    ).toBe(false);
  });

  it('--body=値 の形（= 区切り、単一引用符）の中の -d は通す', () => {
    expect(inspectBashCommand("gh pr merge 1 --body='mentions -d flag'").blocked).toBe(false);
  });

  it('--subject と --body の両方に字面が在っても、どちらも値の中なら通す', () => {
    expect(
      inspectBashCommand(
        'gh pr merge 1 --subject "fix: --delete-branch guard" --body "also mentions -d here"',
      ).blocked,
    ).toBe(false);
  });

  it('env・timeout 前置きと組み合わさっても、値の中の字面は通す', () => {
    expect(
      inspectBashCommand(
        'GH_TOKEN=xxx timeout 20 gh pr merge 1 --subject "note about --delete-branch"',
      ).blocked,
    ).toBe(false);
  });

  it('`&&` の後ろの gh pr merge でも、値の中の字面は通す', () => {
    expect(
      inspectBashCommand('cd /tmp && gh pr merge 1 --subject "mentions --delete-branch"').blocked,
    ).toBe(false);
  });

  it('弾かれない場合の verdict は blocked:false のみ（form は無い）', () => {
    const v = inspectBashCommand(
      'gh pr merge 1 --subject "fix: gh pr merge --delete-branch ガードの誤検知"',
    );
    expect(v).toEqual({ blocked: false });
  });
});

/**
 * (B) 弾き続けるべき形 —— すり抜けの候補。値の引用符の中だけを潰す形にしても、
 * 実際に `gh` へ渡る `--delete-branch` / `-d` はどれも引き続き弾かれることを
 * 確かめる。**この節が1本でも緑から赤に変われば、それはすり抜けである。**
 */
describe('gh-pr-merge-delete-branch: 値の引用符だけを潰しても、実際のフラグは引き続き弾く（issue #1910 のすり抜け防止）', () => {
  it('引用符で囲まれた長いフラグそのもの（`--subject` 等の値ではない）は引き続き弾く', () => {
    expect(inspectBashCommand("gh pr merge 1 '--delete-branch'").blocked).toBe(true);
  });

  it('`--subject` の値の後ろに続く実際の `--delete-branch` は引き続き弾く', () => {
    expect(
      inspectBashCommand('gh pr merge 1 --subject "x" --delete-branch').blocked,
    ).toBe(true);
  });

  it('`--subject` の値の後ろに続く実際の `-d` は引き続き弾く', () => {
    expect(inspectBashCommand('gh pr merge 1 --subject "x" -d').blocked).toBe(true);
  });

  it('`--body` の値の後ろに続く実際の `--delete-branch` は引き続き弾く', () => {
    expect(inspectBashCommand('gh pr merge 1 --body "x" --delete-branch').blocked).toBe(true);
  });

  it('エスケープした二重引用符（`\\"`）を含む値は「読めない」として弾く（潰さない）', () => {
    // bash の実際の構文では `\"` は値の中の1文字としてのエスケープされた `"`
    // であって閉じ引用符ではないが、この検出器は shell の構文解析器ではない
    // ので、バックスラッシュを含む区間は「安全に閉じ引用符の位置が分かる」
    // とは言えない。読めないと判断したら潰さず、弾く側へ倒す
    // （依頼の指定どおり）。
    expect(
      inspectBashCommand('gh pr merge 1 --subject "a \\" --delete-branch"').blocked,
    ).toBe(true);
  });

  it('閉じていない引用符を含む値は「読めない」として弾く（潰さない）', () => {
    expect(inspectBashCommand('gh pr merge 1 --subject "a --delete-branch').blocked).toBe(true);
  });

  it('`--subject` の値が引用符なしで、次の語が `--delete-branch` の形は引き続き弾く', () => {
    // 引用符が無いので「値の引用符の区間」に当たらず、素通しの対象にならない
    // ——潰す条件（引用符）が最初から成立しない形である。
    expect(inspectBashCommand('gh pr merge 1 --subject --delete-branch').blocked).toBe(true);
  });

  it('`&&` の後ろ・timeout 前置き・値の中の字面・実フラグが同居しても、実フラグ側で弾く', () => {
    expect(
      inspectBashCommand(
        'true && timeout 20 gh pr merge 1 --subject "note --delete-branch here" -d',
      ).blocked,
    ).toBe(true);
  });

  it('`--body-file`（`--body` ではない）は値の潰しの対象にならず、直後の実際の `--delete-branch` は弾く', () => {
    expect(
      inspectBashCommand('gh pr merge 1887 --squash --subject "no mention" --body-file f --delete-branch')
        .blocked,
    ).toBe(true);
  });

  it('弾いたときの form は引き続き gh-pr-merge-delete-branch', () => {
    const v = inspectBashCommand('gh pr merge 1 --subject "x" --delete-branch');
    expect(v).toMatchObject({ blocked: true, form: 'gh-pr-merge-delete-branch' });
  });

  /**
   * ⚠️ 既知の別の穴（この Issue の範囲外。作業中に発見、Issue 化した）——
   * `gh pr merge 1 "-d"` / `gh pr merge 1 '-d'` のように、**`--subject` /
   * `--body` の値ではなく、素で引用符に囲まれた短縮フラグ `-d`** は、この
   * PR の変更を入れる前から弾けていない。
   *
   * `GH_PR_MERGE_DELETE_BRANCH_RE` の `-d` の検出は
   * `(?<=[\s])-d(?=[\s;&|]|$)` —— 直前が**空白**であることを要求する。だが
   * `"-d"` は直前が引用符 `"` であって空白ではないので、この lookbehind に
   * 当たらない。**シェルは引用符を剥がすので、`gh` に実際に渡る引数は
   * リテラルの `-d`（本物のフラグ）である** —— つまりこれは実害のある
   * false negative（すり抜け）だが、値の引用符を潰す・潰さないとは無関係に
   * 最初から存在していた別の穴である（`--delete-branch`（長い形）は
   * lookbehind を持たないため、同じ形でも引き続き弾く——下のテストで対照
   * している）。
   *
   * この Issue（#1910）は**誤検知（false positive）**の直し方を扱っており、
   * この節が扱う**すり抜け（false negative）**とは症状が逆で、この PR の
   * 変更が作ったものでもない（テスト専用コミットの時点で既に赤い——
   * `git stash` 等をせず、変更前の `main` へ直接このテストを当てて確認
   * 済み）。この PR では直さず、Issue を切って報告する
   * （AGENTS.md「範囲外でも気づいたことは上げる」）。
   */
  it('[既知・範囲外] 二重引用符で囲まれた素の `-d`（`"-d"`）は現状すり抜ける', () => {
    expect(inspectBashCommand('gh pr merge 1 "-d"').blocked).toBe(false);
  });

  it('[既知・範囲外] 単一引用符で囲まれた素の `-d`（`\'-d\'`）は現状すり抜ける', () => {
    expect(inspectBashCommand("gh pr merge 1 '-d'").blocked).toBe(false);
  });

  it('対照: 引用符で囲まれた長いフラグ `--delete-branch` は lookbehind が無いので引き続き弾く', () => {
    expect(inspectBashCommand('gh pr merge 1 "--delete-branch"').blocked).toBe(true);
  });
});
