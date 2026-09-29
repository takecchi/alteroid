import { describe, expect, it } from 'vitest';

import { inspectBashCommand } from './bash-wait-guard.js';
import { expectNotSuperlinear } from './time-growth.test-support.js';

/**
 * issue #2104 —— `gh pr merge --delete-branch`/`-d` の検出が、**文字列として
 * 別のシェルへ渡され、コマンドとして実行される形**をすり抜けていた。
 * `bash -c '…'` は #1764 から「弾けないと分かっている形」として doc と
 * `bash-wait-guard.test.ts` の `it.fails` に在ったが、同じ穴が `eval`・
 * `ssh <host> <cmd>`・シェルへのパイプ（`… | bash`）・シェルへのヒア
 * ドキュメント（`bash <<EOF`）にも在った。
 *
 * 依頼者が main 12dd1a83 の写しで実測した結果（`inspectBashCommand(cmd)
 * .blocked`）は、Issue 本文に挙げた12形のうち10形が `false`（すり抜け）
 * だった（残り2形は、対照の `bash -c 'echo hi'` と、既に `true` だった
 * `zsh -c 'cd x && gh pr merge 1 -d'`）。直し方は `bash-wait-guard.ts` の
 * `hasGhPrMergeDeleteBranch`（入口を見つけたら中身を取り出し、自分自身へ
 * もう一度かける再帰）・`SHELL_DASH_C_RE`・`EVAL_RE`・`SSH_RE`・
 * `extractPipeToShellPayloads`・`SHELL_HEREDOC_RE` の doc 参照。
 */
describe('gh-pr-merge-delete-branch: issue #2104 の10形すべてを弾く', () => {
  const knownGaps: ReadonlyArray<[string, string]> = [
    ['1: bash -c（単一引用符、--delete-branch）', "bash -c 'gh pr merge 1 --delete-branch'"],
    ['2: bash -c（二重引用符、-d）', 'bash -c "gh pr merge 1 -d"'],
    ['3: sh -c', "sh -c 'gh pr merge 1 -d'"],
    ['4: bash -lc（束ね）', "bash -lc 'gh pr merge 1 -d'"],
    ['6: timeout 60 bash -c（前置き付き）', "timeout 60 bash -c 'gh pr merge 1 -d'"],
    ['7: ssh host（引用符の中身）', "ssh host 'gh pr merge 1 -d'"],
    ['8: eval', "eval 'gh pr merge 1 -d'"],
    ['9: echo … | bash（シェルへのパイプ）', "echo 'gh pr merge 1 -d' | bash"],
    ['10: bash <<EOF（シェルへのヒアドキュメント）', "bash <<'EOF'\ngh pr merge 1 -d\nEOF"],
    ['11: xargs -I{} sh -c（前置き付き）', "xargs -I{} sh -c 'gh pr merge {} -d'"],
  ];

  for (const [label, command] of knownGaps) {
    it(`${label}: 弾く`, () => {
      const verdict = inspectBashCommand(command);
      expect(verdict.blocked).toBe(true);
      if (!verdict.blocked) throw new Error('unreachable');
      expect(verdict.form).toBe('gh-pr-merge-delete-branch');
    });
  }

  it('10形すべてで knownGaps の件数が10件であること（表と実装のずれを検知する）', () => {
    expect(knownGaps.length).toBe(10);
  });

  // Issue 本文の12形のうち、直す前から既に `true` だった1形（回帰確認として
  // 残す。10形の対象ではない）。`&&` が引用符を追わない既存のガード自身の
  // 弱さにより、たまたま「コマンドの位置」として拾われていただけ——この PR
  // が新しく直したものではない。
  it('5: zsh -c（&& が引用符を追わず、直す前から既に true だった——回帰確認）', () => {
    expect(inspectBashCommand("zsh -c 'cd x && gh pr merge 1 -d'").blocked).toBe(true);
  });
});

/**
 * 偽陽性にならないこと —— 5つの入口を足しても、既存の「通す形」が巻き
 * 込まれて弾かれるようになっていないか。Issue 本文の対照群をそのまま使う。
 */
describe('gh-pr-merge-delete-branch: issue #2104 の直しを足しても偽陽性にならない', () => {
  it("12: bash -c 'echo hi'（対照、-d も --delete-branch も無い）", () => {
    expect(inspectBashCommand("bash -c 'echo hi'").blocked).toBe(false);
  });

  it('bash -c \'echo "gh pr merge 1 -d"\' は通す（取り出した中身の中でも gh が echo の引数——コマンドの位置ではない）', () => {
    expect(inspectBashCommand('bash -c \'echo "gh pr merge 1 -d"\'').blocked).toBe(false);
  });

  it("echo 'gh pr merge 1 -d' は通す（5つの入口のどれにも当たらない）", () => {
    expect(inspectBashCommand("echo 'gh pr merge 1 -d'").blocked).toBe(false);
  });

  it("cat > f <<'EOF' ... は通す（ヒアドキュメントの対象がシェルではない——既存の歯と同じ理由が新しい入口にも及ぶこと）", () => {
    const command = "cat > f <<'EOF'\ngh pr merge 1 -d\nEOF";
    expect(inspectBashCommand(command).blocked).toBe(false);
  });

  it("ssh host 'gh pr merge 1 --squash' は通す（-d も --delete-branch も無い）", () => {
    expect(inspectBashCommand("ssh host 'gh pr merge 1 --squash'").blocked).toBe(false);
  });

  it("bash -c 'gh pr merge 1 --squash' は通す（同上）", () => {
    expect(inspectBashCommand("bash -c 'gh pr merge 1 --squash'").blocked).toBe(false);
  });
});

/**
 * 入れ子（複数のシェルをまたぐ）—— Issue 本文が明示的に挙げた形
 * （`bash -c "sh -c 'gh pr merge 1 -d'"`）と、深さの上限の境界。
 */
describe('gh-pr-merge-delete-branch: 入れ子と深さの上限（issue #2104）', () => {
  it('bash -c "sh -c \'gh pr merge 1 -d\'"（2種類のシェルをまたぐ入れ子）を弾く', () => {
    const verdict = inspectBashCommand('bash -c "sh -c \'gh pr merge 1 -d\'"');
    expect(verdict.blocked).toBe(true);
    if (!verdict.blocked) throw new Error('unreachable');
    expect(verdict.form).toBe('gh-pr-merge-delete-branch');
  });

  it('bash -c "sh -c \'gh pr merge 1 --squash\'"（入れ子でも -d が無ければ通す）', () => {
    expect(inspectBashCommand('bash -c "sh -c \'gh pr merge 1 --squash\'"').blocked).toBe(false);
  });

  /**
   * `bash -c "…"` を実際の bash の二重引用符ネストの規則
   * （1段ごとにバックスラッシュを倍にしてから `"` をエスケープする）で
   * N回包む。`hasGhPrMergeDeleteBranch` の素朴な `\\(.)→$1` の外し方は、
   * ちょうどこの規則を1段ずつ正しく打ち消す（doc「後戻りの設計」参照）。
   */
  function wrapBashCDouble(inner: string): string {
    const escaped = inner.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    return `bash -c "${escaped}"`;
  }

  it('3層ネスト（MAX_NESTED_SHELL_DEPTH=3 の範囲内）は弾く', () => {
    let command = 'gh pr merge 1 -d';
    for (let i = 0; i < 3; i++) command = wrapBashCDouble(command);
    expect(inspectBashCommand(command).blocked).toBe(true);
  });

  // 深さの上限を超えた入れ子（4層以上）は、構文を見ずに字面だけで判定して
  // 弾く側へ倒す（`looksLikeGhPrMergeDeleteBranch`）。最初の版は「既知の限界として
  // 通る」を `toBe(false)` で固定していたが、レビュー（mgr-712ad619）で弾く側へ直した。
  // すり抜けを作らないことを優先し、誤検知の向きは受け入れる。
  for (const layers of [4, 6]) {
    it(`${layers}層ネスト（深さの上限を超える）も弾く`, () => {
      let command = 'gh pr merge 1 -d';
      for (let i = 0; i < layers; i++) command = wrapBashCDouble(command);
      expect(inspectBashCommand(command).blocked).toBe(true);
    });
  }

  it('4層ネストでも、中身に -d が無ければ通す', () => {
    let command = 'gh pr merge 1 --squash';
    for (let i = 0; i < 4; i++) command = wrapBashCDouble(command);
    expect(inspectBashCommand(command).blocked).toBe(false);
  });

  it('⚠️ 受け入れる誤検知: 4層ネストの中の echo の引数の字面でも弾く（上限では構文を見ない）', () => {
    let command = 'echo gh pr merge 1 -d';
    for (let i = 0; i < 4; i++) command = wrapBashCDouble(command);
    expect(inspectBashCommand(command).blocked).toBe(true);
  });
});

/**
 * 時間の歯 —— 既存の `bash-wait-guard-delete-branch-issue-2068.test.ts` と
 * 同じ形。この PR で足した5つの新しい正規表現（`SHELL_DASH_C_RE`・
 * `EVAL_RE`・`SSH_RE`・`PIPE_TO_SHELL_TARGET_RE`・`SHELL_HEREDOC_RE`）が、
 * 長い繰り返し入力で後戻りが爆発しないことを測る。
 *
 * ⚠️ **`;` が大量に並ぶ入力（`'a;'.repeat(n)` のような形）は、ここでは
 * 意図して使っていない。** そのような入力は、この PR とは無関係な
 * **既存の**穴（`GH_WORD_SRC`/`hasGhPrMergeDeleteBranch` の直接一致自身が
 * 持つ、無制限の `\S*\/`（パス接頭辞）による2乗の後戻り——mgr-712ad619 が
 * この PR の作業中に発見、`GH_WORD_SRC` の doc に記録・Issue へ切り出す
 * 予定）を踏んでしまい、この PR の新しい正規表現の後戻りを測るという
 * 目的からずれる。ここでは既存の時間の歯と同じ「区切り文字を挟まない
 * 単純な繰り返し」の形で、新しい構文だけを測る。
 */
describe('gh-pr-merge-delete-branch: issue #2104 の新しい正規表現が長い繰り返しで後戻りしない', () => {
  // issue #2187 —— 壁時計の絶対値（`TIME_BUDGET_MS = 200`）から伸びの比へ
  // 替えた。`n * factor` を、直す前にテストしていた繰り返し回数に揃えてある。

  it('シェルの -c（終端していない単一引用符の繰り返し、gh を含まない）が線形に終わる', () => {
    const makeInput = (n: number) => `${"bash -c '".repeat(n)}x`;
    expect(inspectBashCommand(makeInput(1250 * 4)).blocked).toBe(false);
    expectNotSuperlinear(inspectBashCommand, makeInput, { n: 1250 });
  });

  it('eval の繰り返し（gh を含まない）が線形に終わる', () => {
    const makeInput = (n: number) => `${'eval x '.repeat(n)}x`;
    expect(inspectBashCommand(makeInput(1250 * 4)).blocked).toBe(false);
    expectNotSuperlinear(inspectBashCommand, makeInput, { n: 1250 });
  });

  it('ssh の繰り返し（gh を含まない、; で区切る現実的な形）が線形に終わる', () => {
    const makeInput = (n: number) => `${'ssh host x; '.repeat(n)}x`;
    expect(inspectBashCommand(makeInput(750 * 4)).blocked).toBe(false);
    expectNotSuperlinear(inspectBashCommand, makeInput, { n: 750 });
  });

  it('シェルへのパイプの繰り返し（引用符無し、gh を含まない）が線形に終わる', () => {
    const makeInput = (n: number) => `${'a | bash '.repeat(n)}x`;
    expect(inspectBashCommand(makeInput(500 * 4)).blocked).toBe(false);
    expectNotSuperlinear(inspectBashCommand, makeInput, { n: 500 });
  });

  it('シェルへのパイプの繰り返し（各区間に引用符あり、gh を含まない）が線形に終わる', () => {
    const makeInput = (n: number) => `${"'x' | bash ".repeat(n)}x`;
    expect(inspectBashCommand(makeInput(500 * 4)).blocked).toBe(false);
    expectNotSuperlinear(inspectBashCommand, makeInput, { n: 500 });
  });

  it('シェルへのヒアドキュメントの本体が大きくても（gh を含まない）線形に終わる', () => {
    const makeInput = (n: number) => {
      const body = 'x\n'.repeat(n);
      return `bash <<'EOF'\n${body}EOF`;
    };
    expect(inspectBashCommand(makeInput(1250 * 4)).blocked).toBe(false);
    expectNotSuperlinear(inspectBashCommand, makeInput, { n: 1250 });
  });

  it('シェルの -c が多数繰り返され、最後の1個だけ本物の payload を持つ場合も線形に終わる', () => {
    const makeInput = (n: number) => `${"bash -c 'echo hi';".repeat(n)}bash -c 'gh pr merge 1 -d'`;
    expect(inspectBashCommand(makeInput(1000 * 4)).blocked).toBe(true);
    expectNotSuperlinear(inspectBashCommand, makeInput, { n: 1000 });
  });

  // `SHELL_NAME_SRC`/`SSH_RE` のパス接頭辞を `\S{0,64}` に絞った直し
  // （`SHELL_NAME_SRC` の doc）自体の実測——非現実的に長い1本のパス
  // （スラッシュ区切りが1万個）でも後戻りが線形のままであること。
  it('非現実的に長いパス接頭辞（bash の前）でも線形に終わる（実際には認識されず通る——既知の限界）', () => {
    const makeInput = (n: number) => {
      const longPath = 'a/'.repeat(n) + 'bash';
      return `${longPath} -c 'gh pr merge 1 -d'`;
    };
    // 64文字を超えるパス接頭辞は認識されない（doc「弾けないと分かっている
    // 形」に準じる、稀な形と判断）——ここで測りたいのは blocked の真偽では
    // なく、後戻りが暴走しないことそのもの。
    expect(inspectBashCommand(makeInput(1250 * 4)).blocked).toBe(false);
    expectNotSuperlinear(inspectBashCommand, makeInput, { n: 1250 });
  });

  it('現実的な長さのパス接頭辞（/usr/local/bin/bash 等）は引き続き認識して弾く', () => {
    expect(inspectBashCommand("/usr/local/bin/bash -c 'gh pr merge 1 -d'").blocked).toBe(true);
    expect(inspectBashCommand("/bin/sh -c 'gh pr merge 1 -d'").blocked).toBe(true);
  });
});

/**
 * レビュー（mgr-712ad619、2026-09-29T04:5xZ）で見つけた、同じ穴の残り3形。
 * どれも Issue の数える単位（文字列が別のシェルに渡され、実行される形）に入る。
 */
describe('gh-pr-merge-delete-branch: レビューで足した入口の残り（issue #2104）', () => {
  const blocked: ReadonlyArray<[string, string]> = [
    ['引用符の無い ssh の遠くのコマンド', 'ssh host gh pr merge 1 -d'],
    [
      'オプション付きの ssh（値を取る -i / -p を読み飛ばす）',
      'ssh -i key -p 22 host gh pr merge 1 -d',
    ],
    ['シェルへのパイプの中身がヒアドキュメント', 'cat <<EOF | bash\ngh pr merge 1 -d\nEOF'],
    ['fish -c', "fish -c 'gh pr merge 1 -d'"],
    ['/bin/ash -c', "/bin/ash -c 'gh pr merge 1 -d'"],
  ];
  for (const [label, command] of blocked) {
    it(`${label}: 弾く`, () => {
      const verdict = inspectBashCommand(command);
      expect(verdict.blocked).toBe(true);
      if (!verdict.blocked) throw new Error('unreachable');
      expect(verdict.form).toBe('gh-pr-merge-delete-branch');
    });
  }

  const passing: ReadonlyArray<[string, string]> = [
    ['ssh の遠くのコマンドが echo の引数', 'ssh host echo gh pr merge 1 -d'],
    ['ssh の遠くのコマンドに -d が無い', 'ssh host gh pr merge 1 --squash'],
    ['パイプの無いヒアドキュメント（既存の通す形）', "cat > f <<'EOF'\ngh pr merge 1 -d\nEOF"],
    [
      'シェルへのパイプだが、ヒアドキュメントの本文が echo の引数',
      'cat <<EOF | bash\necho gh pr merge 1 -d\nEOF',
    ],
  ];
  for (const [label, command] of passing) {
    it(`${label}: 通す`, () => {
      expect(inspectBashCommand(command).blocked).toBe(false);
    });
  }
});
