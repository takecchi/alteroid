import { describe, expect, it } from 'vitest';

import { inspectBashCommand } from './bash-wait-guard';

/**
 * 領域D 4周目点検・確かめ用（コミットしない）。
 * `gh pr merge --delete-branch` 検出器の「コマンド位置」lookbehind
 * （`(?<=^|[;&|\n])`）が、シェルのキーワード（`then`/`else`/`do`）や
 * グルーピング（`{ }` / `( )`）・否定（`!`）の直後を「コマンド位置」と
 * 認めていない疑いを、`inspectBashCommand` へ偽の入力を渡して確かめる。
 *
 * **期待は `blocked: true`（弾かれるべき）。テストが赤くなった行が、
 * 実際に弾けていない＝疑いが確かめられた形である。** 緑になった行は
 * 疑いが外れた（既存のガードが実際には拾えている）ことを示す。
 */
describe('round4-probe: gh-pr-merge-delete-branch のコマンド位置の抜け（疑い）', () => {
  it('if/then の直後（同じ行、空白区切り）', () => {
    const cmd = 'if true; then gh pr merge 1 --delete-branch; fi';
    expect(inspectBashCommand(cmd).blocked).toBe(true);
  });

  it('if/else の直後（同じ行、空白区切り）', () => {
    const cmd = 'if false; then true; else gh pr merge 1 --delete-branch; fi';
    expect(inspectBashCommand(cmd).blocked).toBe(true);
  });

  it('for/do の直後（同じ行、空白区切り）', () => {
    const cmd = 'for i in 1; do gh pr merge $i --delete-branch; done';
    expect(inspectBashCommand(cmd).blocked).toBe(true);
  });

  it('波括弧グルーピング { ... } の直後（同じ行、空白区切り）', () => {
    const cmd = '{ gh pr merge 1 --delete-branch; }';
    expect(inspectBashCommand(cmd).blocked).toBe(true);
  });

  it('サブシェル ( ... ) の直後（同じ行、空白区切り）', () => {
    const cmd = '(gh pr merge 1 --delete-branch)';
    expect(inspectBashCommand(cmd).blocked).toBe(true);
  });

  it('! による否定の直後（同じ行、空白区切り）', () => {
    const cmd = '! gh pr merge 1 --delete-branch';
    expect(inspectBashCommand(cmd).blocked).toBe(true);
  });

  // 対照: 既存の lookbehind が拾うはずの形（; の直後）。緑になるはず。
  it('対照: ; の直後（既存の形。blocked:true になるはず）', () => {
    const cmd = 'echo hi; gh pr merge 1 --delete-branch';
    expect(inspectBashCommand(cmd).blocked).toBe(true);
  });

  // 対照: 改行区切りなら then/do 自体も新しいコマンド位置に見えるはず。緑になるはず。
  it('対照: 改行区切りの then（比較用。blocked:true になるはず）', () => {
    const cmd = 'if true\nthen\ngh pr merge 1 --delete-branch\nfi';
    expect(inspectBashCommand(cmd).blocked).toBe(true);
  });
});
