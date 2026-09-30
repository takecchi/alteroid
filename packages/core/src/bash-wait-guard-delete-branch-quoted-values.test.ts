import { describe, expect, it } from 'vitest';

import { inspectBashCommand } from './bash-wait-guard-delete-branch.test-support.js';

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
    expect(inspectBashCommand("gh pr merge 1 -t 'note: -d flag guard behavior'").blocked).toBe(
      false,
    );
  });

  it('-b（--body の短縮形）の単一引用符の値の中の --delete-branch は通す', () => {
    expect(inspectBashCommand("gh pr merge 1 -b 'mentions --delete-branch in prose'").blocked).toBe(
      false,
    );
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
    expect(inspectBashCommand('gh pr merge 1 --subject "x" --delete-branch').blocked).toBe(true);
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
    expect(inspectBashCommand('gh pr merge 1 --subject "a \\" --delete-branch"').blocked).toBe(
      true,
    );
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
      inspectBashCommand(
        'gh pr merge 1887 --squash --subject "no mention" --body-file f --delete-branch',
      ).blocked,
    ).toBe(true);
  });

  it('弾いたときの form は引き続き gh-pr-merge-delete-branch', () => {
    const v = inspectBashCommand('gh pr merge 1 --subject "x" --delete-branch');
    expect(v).toMatchObject({ blocked: true, form: 'gh-pr-merge-delete-branch' });
  });

  /**
   * ⚠️ 既知の別の穴（この Issue の範囲外。作業中に発見、issue #1991 で
   * 報告済み）—— `gh pr merge 1 "-d"` / `gh pr merge 1 '-d'` のように、
   * **`--subject`/`--body` の値ではなく、素で引用符に囲まれた短縮フラグ
   * `-d`** は、この PR の変更を入れる前から弾けていない。
   *
   * `GH_PR_MERGE_DELETE_BRANCH_RE` の `-d` の検出は `(?<=[\s])-d\b`
   * （PR #1990 のレビューで `\b` に直した——直後がバッククォート等でも
   * 弾けるようにするため。`bash-wait-guard.ts` の「二重引用符の値の中の
   * コマンド置換は『読めない』として潰さない」参照）—— だが**手前
   * （lookbehind）**は直前が**空白**であることを要求したまま変えていない。
   * `"-d"` は直前が引用符 `"` であって空白ではないので、この lookbehind に
   * 当たらない。**シェルは引用符を剥がすので、`gh` に実際に渡る引数は
   * リテラルの `-d`（本物のフラグ）である** —— つまりこれは実害のある
   * false negative（すり抜け）だが、値の引用符を潰す・潰さないや `-d` の
   * 後ろ側の直し（PR #1990）とは無関係に最初から存在していた別の穴である
   * （`--delete-branch`（長い形）は lookbehind を持たないため、同じ形でも
   * 引き続き弾く——下のテストで対照している）。
   *
   * この Issue（#1910）は**誤検知（false positive）**の直し方を扱っており、
   * この節が扱う**すり抜け（false negative）**とは症状が逆で、この PR の
   * 変更が作ったものでもない。この PR では直さず、issue #1991 を切って
   * 報告した（AGENTS.md「範囲外でも気づいたことは上げる」）。
   *
   * ⚠️ **PR #1990 のレビュー指摘（マネージャー mgr-81affbde）—— `blocked:
   * false` を期待値にすると、すり抜けを「正しい動作」として固定してしまう
   * （#1887 の本文が同じ形を「穴の形を変えただけ」と戻した経緯と同根）。**
   * ⟹ 望む挙動（`blocked: true`）を期待値に書いたうえで `it.fails(...)` に
   * する。いまは実装が追いついていないのでこの `it.fails` は「期待どおり
   * 失敗する」ことで緑になる。issue #1991 が直ったら、この assertion が
   * 実際に通るようになり `it.fails` 自体が失敗する（＝直ったことに気づく
   * トリップワイヤーになる）——そうなったら `it.fails` を `it` に戻す。
   *
   * ⟹ **issue #1991 で直った（同じマネージャー mgr-81affbde からの依頼）。**
   * `GH_PR_MERGE_DELETE_BRANCH_RE` の `-d` の lookbehind を、空白1文字だけ
   * でなく「コマンド位置に在る引用符（`"`/`'`）」も認めるように広げた
   * （`bash-wait-guard.ts` の `SHORT_DELETE_BRANCH_FLAG_SRC` の doc 参照）。
   * 上の `it.fails` は実際に「期待どおり失敗しなかった」ことでトリップワイヤー
   * が発火した（`Error: Expect test to fail`）ので、ここで `it` に戻す
   * ——期待値（`blocked: true`）は変えていない。
   */
  it('[issue #1991 で直った] 二重引用符で囲まれた素の `-d`（`"-d"`）も弾く', () => {
    expect(inspectBashCommand('gh pr merge 1 "-d"').blocked).toBe(true);
  });

  it("[issue #1991 で直った] 単一引用符で囲まれた素の `-d`（`'-d'`）も弾く", () => {
    expect(inspectBashCommand("gh pr merge 1 '-d'").blocked).toBe(true);
  });

  it('対照: 引用符で囲まれた長いフラグ `--delete-branch` は lookbehind が無いので引き続き弾く', () => {
    expect(inspectBashCommand('gh pr merge 1 "--delete-branch"').blocked).toBe(true);
  });
});

/**
 * ⚠️ PR #1990 のレビュー指摘（マネージャー mgr-81affbde、必須の差し戻し）——
 * **二重引用符は bash がその場で展開する。** `$(...)`（コマンド置換）と
 * バッククォート（`` ` ``、レガシーのコマンド置換）は、値の中に書いても
 * 「ただの文字列」ではなく、シェルが実際にコマンドとして実行してから
 * その出力へ置き換える。`--subject "$(gh pr merge 2 --delete-branch)"` /
 * `--body "` + "`" + `gh pr merge 2 -d` + "`" + `"` のような形では、
 * **内側の `gh pr merge --delete-branch` / `-d` が本当に実行される** ——
 * バックスラッシュのエスケープと同じ「読めない」の族に、`$` とバッククォート
 * も入れる必要がある。
 *
 * 潰す条件（`DOUBLE_QUOTED_VALUE_SRC` = `"[^"\\]*"`）は `\` だけを除外して
 * おり、`$` とバッククォートは除外していなかった。⟹ 値の中に
 * `$(gh pr merge 2 --delete-branch)` や `` `gh pr merge 2 -d` `` のような
 * **本物の実行コード**が書かれていても「きれいに閉じた引用符」と誤認して
 * 中身ごと空白へ潰し、実際に実行されるはずの `--delete-branch`/`-d` を
 * 検出器の目から消してしまっていた。
 */
describe('gh-pr-merge-delete-branch: 二重引用符の値の中のコマンド置換は「読めない」として潰さない（PR #1990 レビュー指摘）', () => {
  it('`$(...)` コマンド置換の中の実際の `gh pr merge --delete-branch`（--subject 経由）は弾く', () => {
    expect(
      inspectBashCommand('gh pr merge 1 --subject "$(gh pr merge 2 --delete-branch)"').blocked,
    ).toBe(true);
  });

  it('バッククォートのコマンド置換の中の実際の `gh pr merge -d`（--body 経由）は弾く', () => {
    expect(inspectBashCommand('gh pr merge 1 --body "`gh pr merge 2 -d`"').blocked).toBe(true);
  });

  it('`$(...)` コマンド置換の中の実際の `gh pr merge -d`（--subject 経由）は弾く', () => {
    expect(inspectBashCommand('gh pr merge 1 --subject "$(gh pr merge 2 -d)"').blocked).toBe(true);
  });

  it('バッククォートのコマンド置換の中の実際の `gh pr merge --delete-branch`（--body 経由）は弾く', () => {
    expect(
      inspectBashCommand('gh pr merge 1 --body "`gh pr merge 2 --delete-branch`"').blocked,
    ).toBe(true);
  });

  it('偽陽性にならないこと —— `$` を含むが実行コードではない、ただの地の文の値は通す（潰せないので安全側に残るのは許容する）', () => {
    // `$` を含む時点で「読めない」側に倒すので、この値は潰されず、
    // 中に `--delete-branch` の字面等が無ければそのまま通る。
    expect(inspectBashCommand('gh pr merge 1 --subject "price is $5, not a flag"').blocked).toBe(
      false,
    );
  });
});

/**
 * ⚠️ PR #1990 のレビュー指摘・指摘3（マネージャー mgr-81affbde、必須の
 * 差し戻し）—— `SUBJECT_BODY_QUOTED_VALUE_RE` はコマンド文字列全体に対して
 * 引用符の開き閉じを追わずに当たるので、**単一引用符（または二重引用符）の
 * 中に書かれた `--subject "`（または `-t '`）という字面**を、本物のフラグ
 * だと誤読できる。
 *
 * 実例（bash の実際の argv 分割を `argv-dump.sh` で検証済み、2026-09-28）:
 *
 * ```
 * gh pr merge 1 x'y --subject "' --delete-branch '"'
 * ```
 *
 * bash の読み（実測）: `ARG[5]=<xy --subject ">`（`x` + 単一引用符 `'y
 * --subject "'` が1つの引数に結合）・`ARG[6]=<--delete-branch>`（**本物の
 * 引用符無しフラグ**）・`ARG[7]=<">`（単一引用符 `'"'` の中身）。
 *
 * 正規表現の読み（潰す前）: `--subject ` の直後に来た `"` を開き引用符と
 * 誤認し、次の `"`（`'"'` の中の `"`）までを二重引用符の値だと思い込んで
 * `' --delete-branch '` を丸ごと空白へ潰す —— **本物の `--delete-branch` が
 * 検出器の目から消える。**
 *
 * 同じ形は `-t` と引用符の種類を入れ替えても作れる（`argv-dump.sh` で
 * 同様に確認済み）:
 *
 * ```
 * gh pr merge 1 x"y -t '" --delete-branch "'"
 * ```
 *
 * ## 直し方
 *
 * 置換のコールバックに渡ってくる一致位置（`offset`）について、**文字列の
 * 先頭からその位置まで実際に引用符を追った状態**（`computeOutsideQuoteMask`
 * ——単一引用符の中はエスケープ無し、二重引用符の中はバックスラッシュが
 * 直後の1文字を飛ばす、という bash の実際の規則で状態遷移する簡単な状態
 * 機械）を求め、**その位置が「引用符の外」だと確信できるときだけ潰す**。
 * 状態が読めない（末尾がバックスラッシュで終わる等）ときは、それ以降
 * ずっと「外ではない」として扱う（弾く側に倒す）。
 *
 * `--subject`/`-t`/`--body`/`-b` の字面自体には引用符・バックスラッシュを
 * 含まないので、フラグの開始位置で状態を見れば、直後に続く引用符の開始
 * 位置の状態とも一致する——別々に確かめる必要は無い。
 */
describe('gh-pr-merge-delete-branch: 単一引用符/二重引用符の中の字面の `--subject "`/`-t \'` を本物のフラグと誤読しない（PR #1990 レビュー指摘・指摘3）', () => {
  it('単一引用符の中の字面 `--subject "` に化かされず、本物の `--delete-branch` を弾く', () => {
    expect(inspectBashCommand(`gh pr merge 1 x'y --subject "' --delete-branch '"'`).blocked).toBe(
      true,
    );
  });

  it("二重引用符の中の字面 `-t '` に化かされず、本物の `--delete-branch` を弾く（引用符の種類を入れ替えた形）", () => {
    expect(inspectBashCommand(`gh pr merge 1 x"y -t '" --delete-branch "'"`).blocked).toBe(true);
  });

  it('偽陽性にならないこと —— 本物の `--subject` の値の中に単一引用符が在っても通す', () => {
    expect(inspectBashCommand(`gh pr merge 1 --subject "it's fine, no flag here"`).blocked).toBe(
      false,
    );
  });

  it('偽陽性にならないこと —— 本物の `-t` の値の中に二重引用符の断片が在っても通す', () => {
    expect(inspectBashCommand(`gh pr merge 1 -t 'say "hi" not a flag'`).blocked).toBe(false);
  });
});
