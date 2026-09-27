import { describe, expect, it } from 'vitest';

import { inspectBashCommand } from './bash-wait-guard.js';

/**
 * 横断レビュー15回目——PR #1776（issue #1764）の
 * `GH_PR_MERGE_DELETE_BRANCH_RE` に見つけた「開いたまま」の穴（issue #1788）。
 *
 * `GH_PR_MERGE_DELETE_BRANCH_RE` は
 *
 * ```
 * (?<=^|[;&|\n])[ \t]*gh\s+pr\s+merge\b...
 * ```
 * という形で、`gh` の直前が「行頭・`;`・`&`・`|`・改行」のどれかで、かつ
 * その間に**空白（`[ \t]*`）以外の文字が無い**ことを要求する。
 *
 * ところが同じコミットの `stripLeadingTimeout`（`TIMEOUT_PREFIX_RE`）は
 * `^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*timeout\s+...` という形で、
 * **`FOO=bar timeout 30 ...` のような環境変数の前置きを明示的に読み飛ばして
 * いる**——つまり実装者は「シェルの env-var 前置きは現実にありうる形」だと
 * 認識していた。しかし `GH_PR_MERGE_DELETE_BRANCH_RE` 自身にはこの読み飛ばしが
 * 無い。結果、`GH_TOKEN=xxx gh pr merge 123 --delete-branch` のように、
 * ***まさにこの PR が弾こうとしている形そのもの***へ、ただの環境変数の
 * 前置き（`gh` の認証トークンを都度指定する・`NO_COLOR=1` を付ける等、日常的
 * な使い方）を1つ足すだけで、検出をすり抜けられる。
 *
 * これは issue #1764 の「確かめていないこと」（alias / xargs / bash -c）にも
 * `bash-wait-guard.ts` 自身の「弾けないと分かっている形」の doc
 * （bash -c の中・`--delete-branch=false`・`-sd` の束ね書き・`timeout -k`）
 * にも載っていない——つまり「わかっていて塞がなかった」のではなく、
 * 見落とされている。
 */
describe('gh-pr-merge-delete-branch: 環境変数の前置きが検出をすり抜ける（横報告レビュー15・issue #1788）', () => {
  it('前置きが無ければ弾く（対照）', () => {
    expect(inspectBashCommand('gh pr merge 123 --delete-branch').blocked).toBe(true);
  });

  it('GH_TOKEN=... のような1個の env-var 前置きがあると弾く', () => {
    const v = inspectBashCommand('GH_TOKEN=xxx gh pr merge 123 --delete-branch');
    expect(v.blocked).toBe(true);
  });

  it('複数の env-var 前置きでも弾く', () => {
    const v = inspectBashCommand('FOO=1 BAR=2 gh pr merge 123 --delete-branch');
    expect(v.blocked).toBe(true);
  });

  it('`env` コマンド経由の前置きでも弾く', () => {
    const v = inspectBashCommand('env gh pr merge 123 --delete-branch');
    expect(v.blocked).toBe(true);
  });

  it('`env` に env-var 代入を伴っても弾く', () => {
    expect(inspectBashCommand('env GH_TOKEN=xxx gh pr merge 123 --delete-branch').blocked).toBe(
      true,
    );
  });

  it('`env -u NAME` のような単純なオプション付きでも弾く', () => {
    expect(inspectBashCommand('env -u GH_TOKEN gh pr merge 123 --delete-branch').blocked).toBe(
      true,
    );
  });

  it('コマンドの位置（&& の直後）に env-var 前置き付きで在っても弾く', () => {
    expect(
      inspectBashCommand('cd /tmp && GH_TOKEN=xxx gh pr merge 123 --delete-branch').blocked,
    ).toBe(true);
  });

  it('弾いたときの形は引き続き gh-pr-merge-delete-branch（日誌の note 文言 形=gh-pr-merge-delete-branch がそのまま出る）', () => {
    const v = inspectBashCommand('GH_TOKEN=xxx gh pr merge 123 --delete-branch');
    expect(v).toMatchObject({ blocked: true, form: 'gh-pr-merge-delete-branch' });
  });

  it('-d（短縮形）でも env-var 前置き付きで弾く', () => {
    expect(inspectBashCommand('GH_TOKEN=xxx gh pr merge 123 -d').blocked).toBe(true);
  });
});

/**
 * 偽陽性にならないこと——env-var 前置きを読み飛ばす形を足しても、既存の
 * 「通す形」（引用符の中・ヒアドキュメントの本文・他のコマンドの引数）が
 * 巻き込まれて弾かれるようになっていないかを確かめる。
 */
describe('gh-pr-merge-delete-branch: env-var 前置きを足しても偽陽性にならない', () => {
  it('引用符の中に在る env-var 前置き付きの gh pr merge --delete-branch は通す', () => {
    expect(
      inspectBashCommand('echo "GH_TOKEN=x gh pr merge 1 --delete-branch は使わない"').blocked,
    ).toBe(false);
  });

  it('ヒアドキュメントの本文の中に在る env-var 前置き付きの gh pr merge --delete-branch は通す', () => {
    const command =
      "cat > body.md <<'EOF'\nGH_TOKEN=xxx gh pr merge 1 --delete-branch を使った\nEOF";
    expect(inspectBashCommand(command).blocked).toBe(false);
  });

  it('echo の引数としての env-var 前置き（gh が実行されない）は弾かれない', () => {
    // `echo` が先頭コマンドなので `GH_TOKEN=x` はただの引数であり、
    // `gh pr merge` は実行されず単に表示されるだけ——env-var 前置きの
    // 読み飛ばしを足す前から通っていた形で、退行していないことを確かめる。
    expect(inspectBashCommand('echo GH_TOKEN=x gh pr merge 1 --delete-branch').blocked).toBe(false);
  });
});
