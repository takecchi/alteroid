import { describe, expect, it } from 'vitest';

import { inspectBashCommand } from './bash-wait-guard.js';

/**
 * issue #1886（#1788 の続き）——`GH_PR_MERGE_DELETE_BRANCH_RE` が
 * **コマンド位置に来た `timeout` 前置き**を読み飛ばさない穴。
 *
 * `stripLeadingTimeout`（`TIMEOUT_PREFIX_RE`）が読み飛ばすのは
 * **コマンド文字列全体の先頭**の `timeout` だけだった。`&&` / `;` / `|` /
 * 改行の**後ろ**のコマンド位置に来た `timeout` は、#1788 で足した
 * 環境変数・`env` 前置きの読み飛ばしとは別の穴として残っていた。
 *
 * 本番の runner（release/prod = `0e0e842`）で実測（2026-09-27T23:03Z、
 * Issue #1886 本文）: 存在しない PR 番号（`999999`）で打ち、ガードが効かな
 * ければ `gh` が not found で落ちるだけの形で確かめた——
 *
 * - `cd <tree> && date -u … && timeout 20 gh pr merge 999999 --squash --delete-branch`
 *   → **通った**（ガードに弾かれず `gh` まで届いた）
 * - `cd <tree> && date -u … && GH_PAGER=cat timeout 20 gh pr merge 999999 --squash --delete-branch`
 *   → **通った**（同上）
 *
 * この repo の手順（AGENTS.md「自分が走っている器」の `timeout <秒> …` に
 * 寿命を委ねる形、`.claude/skills/pr-green/SKILL.md` が繰り返し勧める
 * 「上限付きのポーリング」）はまさに `cd … && timeout … <コマンド>` という
 * 形を勧めているので、この穴は「稀な書き方」ではなく「推奨されている書き方
 * そのもの」がすり抜けていたことになる。
 */
describe('gh-pr-merge-delete-branch: コマンド位置の timeout 前置きが検出をすり抜ける（issue #1886）', () => {
  it('Issue #1886 の実例1: `cd … && timeout 20 gh pr merge … --delete-branch` を弾く', () => {
    const v = inspectBashCommand('cd /tmp && timeout 20 gh pr merge 1 --squash --delete-branch');
    expect(v.blocked).toBe(true);
  });

  it('Issue #1886 の実例2: env 前置き（GH_PAGER=cat）+ timeout でも弾く', () => {
    const v = inspectBashCommand(
      'cd /tmp && GH_PAGER=cat timeout 20 gh pr merge 1 --delete-branch',
    );
    expect(v.blocked).toBe(true);
  });

  it('先頭がそのまま timeout（`&&` を挟まない）でも引き続き弾く（既存の対照）', () => {
    expect(inspectBashCommand('timeout 20 gh pr merge 1 --delete-branch').blocked).toBe(true);
  });

  it('`;` の後ろの timeout 前置きでも弾く', () => {
    expect(inspectBashCommand('cd /tmp; timeout 20 gh pr merge 1 --delete-branch').blocked).toBe(
      true,
    );
  });

  it('`|` の後ろの timeout 前置きでも弾く', () => {
    expect(
      inspectBashCommand('echo start | timeout 20 gh pr merge 1 --delete-branch').blocked,
    ).toBe(true);
  });

  it('改行の後ろの timeout 前置きでも弾く', () => {
    expect(inspectBashCommand('cd /tmp\ntimeout 20 gh pr merge 1 --delete-branch').blocked).toBe(
      true,
    );
  });

  it('-d（短縮形）+ コマンド位置の timeout 前置きでも弾く', () => {
    expect(inspectBashCommand('cd /tmp && timeout 20 gh pr merge 1 -d').blocked).toBe(true);
  });

  it('弾いたときの形は引き続き gh-pr-merge-delete-branch', () => {
    const v = inspectBashCommand('cd /tmp && timeout 20 gh pr merge 1 --delete-branch');
    expect(v).toMatchObject({ blocked: true, form: 'gh-pr-merge-delete-branch' });
  });
});

/**
 * 偽陽性にならないこと——コマンド位置の `timeout` 前置きを読み飛ばす形を
 * 足しても、既存の「通す形」（引用符の中・ヒアドキュメントの本文・他の
 * コマンドの引数）が巻き込まれて弾かれるようになっていないかを確かめる。
 */
describe('gh-pr-merge-delete-branch: timeout 前置きを足しても偽陽性にならない', () => {
  it('引用符の中に在る timeout 前置き付きの gh pr merge --delete-branch は通す', () => {
    // ⚠️ 引用符の中の文字列には `&&` 等の演算子文字を混ぜないこと——
    // この検出器は引用符を追跡しないので、引用符の中に `&&` を書くと
    // その直後がコマンド位置に見えてしまう（既存の一般的な限界。doc
    // 「この検出器が弾けないと分かっている形」の `bash -c '…'` の項と
    // 同じ族）。ここで確かめたいのは「引用符の中の timeout 前置き」
    // そのものなので、演算子を含めない安全な形にする
    // （`bash-wait-guard-delete-branch-env-prefix.test.ts` の同種のテストと
    // 同じ避け方）。
    expect(
      inspectBashCommand('echo "timeout 20 gh pr merge 1 --delete-branch は使わない"').blocked,
    ).toBe(false);
  });

  it('ヒアドキュメントの本文の中に在る timeout 前置き付きの gh pr merge --delete-branch は通す', () => {
    const command =
      "cat > body.md <<'EOF'\ncd /tmp && timeout 20 gh pr merge 1 --delete-branch を使った\nEOF";
    expect(inspectBashCommand(command).blocked).toBe(false);
  });

  it('echo の引数としての timeout 前置き（gh が実行されない）は弾かれない', () => {
    // `echo` が先頭コマンドなので `timeout 20` はただの引数であり、
    // `gh pr merge` は実行されず単に表示されるだけ——退行していないことを
    // 確かめる。
    expect(inspectBashCommand('echo timeout 20 gh pr merge 1 --delete-branch').blocked).toBe(false);
  });

  it('timeout に包まれた無関係なコマンドは引き続き通す', () => {
    expect(inspectBashCommand('cd /tmp && timeout 20 pnpm test').blocked).toBe(false);
  });
});

/**
 * 前置きの並び順を問わず弾く（#1886）。`LEADING_ENV_PREFIX_SRC` は環境変数の
 * 代入・`timeout <数字><単位?>`・`env` コマンドを、どの順でも何回でも読み飛ばす。
 * 並びを1つに絞ると、残りの並びが同じ穴（前置きを挟むとすり抜ける）として残る。
 */
describe('gh-pr-merge-delete-branch: 前置きの並び順を問わず弾く', () => {
  it('timeout の後ろに env-var 前置きが来る順序でも弾く', () => {
    expect(
      inspectBashCommand('cd /tmp && timeout 20 GH_TOKEN=xxx gh pr merge 1 --delete-branch')
        .blocked,
    ).toBe(true);
  });

  it('`env` コマンドの後ろに timeout が来る順序でも弾く', () => {
    expect(
      inspectBashCommand('cd /tmp && env FOO=1 timeout 20 gh pr merge 1 --delete-branch').blocked,
    ).toBe(true);
  });

  it('timeout の後ろに `env` コマンドと env-var 前置きが続く順序でも弾く', () => {
    expect(
      inspectBashCommand('timeout 20 env FOO=1 GH_PAGER=cat gh pr merge 1 --delete-branch')
        .blocked,
    ).toBe(true);
  });

  it('前置きの並びを変えても、無関係なコマンドは引き続き通す', () => {
    expect(inspectBashCommand('cd /tmp && env FOO=1 timeout 20 pnpm test').blocked).toBe(false);
    expect(inspectBashCommand('timeout 20 GH_PAGER=cat gh pr view 1').blocked).toBe(false);
  });
});
