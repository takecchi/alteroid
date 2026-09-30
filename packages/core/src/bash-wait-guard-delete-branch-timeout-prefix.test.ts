import { describe, expect, it } from 'vitest';

import { inspectBashCommand } from './bash-wait-guard.js';
import { expectNotSuperlinear } from './time-growth.test-support.js';

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
      inspectBashCommand('timeout 20 env FOO=1 GH_PAGER=cat gh pr merge 1 --delete-branch').blocked,
    ).toBe(true);
  });

  it('前置きの並びを変えても、無関係なコマンドは引き続き通す', () => {
    expect(inspectBashCommand('cd /tmp && env FOO=1 timeout 20 pnpm test').blocked).toBe(false);
    expect(inspectBashCommand('timeout 20 GH_PAGER=cat gh pr view 1').blocked).toBe(false);
  });
});

/**
 * `LEADING_ENV_PREFIX_SRC` を `(?:代入|timeout|env)*` という順不同の繰り
 * 返しへ直すとき、`env` コマンドの中でも `NAME=値` を読む素朴な形のままだと
 * 後戻りが入力長に対して指数的に増える（`bash-wait-guard.ts` の
 * `ENV_COMMAND_PREFIX_SRC` の doc 参照）。ここでは実際のガードが指数時間を
 * 踏まないことを、長い前置きの繰り返しで測る。
 *
 * 別立ての使い捨てスクリプト（`packages/core/scratch-backtracking-check.mjs`。
 * コミットしない）で、`env` の中でも代入を読む「素朴な形」のまま順不同に
 * した場合を測ったところ、同じ入力（`env A=1 B=2 ` を N 回）で
 * repeats=10 → 2.469ms、repeats=15 → 663.963ms（Node v22、
 * `performance.now()` 実測）と桁で伸びた。実際に直したガード
 * （`ENV_COMMAND_PREFIX_SRC` が `env` の中で代入を読まない形）はこの節の
 * 下のテストのとおり repeats を増やしても線形にしか伸びない。
 */
describe('gh-pr-merge-delete-branch: 前置きの繰り返しが長くても後戻りで爆発しない', () => {
  // issue #2187 —— 壁時計の絶対値（`TIME_BUDGET_MS = 200`）から伸びの比へ
  // 替えた。直す前にテストしていた repeats は 30 と小さいので（上のスクリプト
  // の実測では repeats=15 で既に664msかかる指数的な後戻り）、`factor: 2` に
  // して `n * factor`（=30）を同じ大きさに揃えてある。
  it('弾かれない入力（gh pr view）でも後戻りが爆発しない', () => {
    const makeInput = (n: number) => `${'env A=1 B=2 '.repeat(n)}gh pr view 1`;
    expect(inspectBashCommand(makeInput(30)).blocked).toBe(false);
    expectNotSuperlinear(inspectBashCommand, makeInput, { n: 15, factor: 2 });
  });

  it('gh pr merge を含まない無関係な入力でも後戻りが爆発しない', () => {
    const makeInput = (n: number) => `${'env A=1 B=2 '.repeat(n)}echo x`;
    expect(inspectBashCommand(makeInput(30)).blocked).toBe(false);
    expectNotSuperlinear(inspectBashCommand, makeInput, { n: 15, factor: 2 });
  });

  it('長い前置きの後ろに gh pr merge --delete-branch が来ても弾き、かつ後戻りが爆発しない', () => {
    const makeInput = (n: number) => `${'env A=1 B=2 '.repeat(n)}gh pr merge 1 --delete-branch`;
    expect(inspectBashCommand(makeInput(30)).blocked).toBe(true);
    expectNotSuperlinear(inspectBashCommand, makeInput, { n: 15, factor: 2 });
  });
});

/**
 * issue #1933（#1886 の続き・領域D）——`TIMEOUT_COMMAND_PREFIX_SRC`
 * （`timeout\s+\d+[a-zA-Z]*\s+`）は**小数の継続時間**に当たらない。`\d+`
 * の直後の `.` は `[a-zA-Z]` にも `\s` にも当たらないため、`timeout 1.5m` の
 * ような前置きは読み飛ばせず、`gh` が前置きの続きに見えなくなって検出器
 * 自体が一致しない（＝弾けない）。
 *
 * GNU coreutils の `timeout` は継続時間に小数を受け付ける（この器で実測、
 * 2026-09-28T02:37Z 観測。`timeout (GNU coreutils) 9.7`）:
 *
 * ```
 * $ timeout 0.1 true; echo $?      # 0
 * $ timeout .5 true; echo $?       # 0（先頭が `.` の形も受ける）
 * $ timeout 1.5m true; echo $?     # 0
 * $ timeout 0.5h true; echo $?     # 0
 * $ timeout .5s true; echo $?      # 0
 * $ timeout 1. true; echo $?       # 0（末尾が `.` で終わる形も受ける——この
 *                                    # PR では対応していない。下の
 *                                    # 「確かめていないこと」参照）
 * $ timeout . true; echo $?        # 125（`.` 単独は拒否される）
 * ```
 *
 * Issue #1933 が挙げた2例（`timeout 1.5m` / `timeout 0.5h`）に加え、先頭が
 * `.` の形（`.5s`）も実測で GNU が受けることを確認できたのでここに含める。
 */
describe('gh-pr-merge-delete-branch: timeout 前置きの小数の継続時間も弾く（issue #1933）', () => {
  it('Issue #1933 の実例1: `cd x && timeout 1.5m gh pr merge … --delete-branch` を弾く', () => {
    const v = inspectBashCommand('cd x && timeout 1.5m gh pr merge 1 --squash --delete-branch');
    expect(v.blocked).toBe(true);
  });

  it('Issue #1933 の実例2: `timeout 0.5h gh pr merge 1 -d` を弾く', () => {
    expect(inspectBashCommand('timeout 0.5h gh pr merge 1 -d').blocked).toBe(true);
  });

  it('単位無しの小数（`timeout 1.5 …`）でも弾く', () => {
    expect(inspectBashCommand('timeout 1.5 gh pr merge 1 --delete-branch').blocked).toBe(true);
  });

  it('先頭が `.` の小数（`timeout .5s …`）でも弾く（GNU timeout が受ける形、実測済み）', () => {
    expect(inspectBashCommand('timeout .5s gh pr merge 1 --delete-branch').blocked).toBe(true);
  });

  it('`&&` の後ろの env 前置き + 小数 timeout でも弾く', () => {
    expect(
      inspectBashCommand('cd /tmp && GH_PAGER=cat timeout 0.5h gh pr merge 1 --delete-branch')
        .blocked,
    ).toBe(true);
  });

  it('弾いたときの形は引き続き gh-pr-merge-delete-branch', () => {
    const v = inspectBashCommand('timeout 1.5m gh pr merge 1 --squash --delete-branch');
    expect(v).toMatchObject({ blocked: true, form: 'gh-pr-merge-delete-branch' });
  });

  it('偽陽性にならないこと——小数 timeout に包まれた無関係なコマンドは引き続き通す', () => {
    expect(inspectBashCommand('cd /tmp && timeout 1.5m pnpm test').blocked).toBe(false);
  });

  /**
   * PR #1939 のレビュー指摘——上の doc コメントで「対応していない」とした
   * 「末尾が `.` で終わる小数」（`timeout 1.` 等）も、GNU が受ける以上は
   * #1933 と同じ穴（小数の継続時間）の残りである。継続時間を
   * `(?:\d+(?:\.\d*)?|\.\d+)` に直せば、`1.` は「整数の直後に `.` と0個
   * 以上の小数部」として先頭が数字の側の選択肢に収まり、`.5` は先頭が `.`
   * の側のままで、2つの選択肢は先頭の文字（数字 / `.`）で排他のまま保たれる
   * （`.` 単独はどちらにも一致しない——`\.\d+` は `.` の後ろに最低1桁を
   * 要求する）。
   */
  it('末尾が `.` で終わる小数（`timeout 1. …`）でも弾く（PR #1939 レビュー指摘）', () => {
    expect(inspectBashCommand('timeout 1. gh pr merge 1 --delete-branch').blocked).toBe(true);
  });
});

/**
 * issue #2423 —— `timeout` の前置きを GNU timeout のオプション文法どおりに読む。
 * 以前は `-k <秒>`・`--kill-after=`・`-s <sig>`・`--signal=`・`--preserve-status` の
 * 空白区切りの狭い形と、`\d+<単位>` の継続時間しか読み飛ばさなかった。
 */
describe('gh-pr-merge-delete-branch: timeout 前置きのオプション・継続時間・パスを読み飛ばす（issue #2423）', () => {
  const tail = 'gh pr merge 7 --squash --delete-branch';
  it.each([
    ['-k5 (詰めた短い形)', `timeout -k5 60 ${tail}`],
    ['-k 5 (空白区切りの短い形)', `timeout -k 5 60 ${tail}`],
    ['--kill-after 5 (空白区切りの長い形)', `timeout --kill-after 5 60 ${tail}`],
    ['--kill-after=5 (= の長い形)', `timeout --kill-after=5 60 ${tail}`],
    ['--signal KILL', `timeout --signal KILL 60 ${tail}`],
    ['--signal=KILL', `timeout --signal=KILL 60 ${tail}`],
    ['-sKILL', `timeout -sKILL 60 ${tail}`],
    ['-s KILL', `timeout -s KILL 60 ${tail}`],
    ['--foreground', `timeout --foreground 60 ${tail}`],
    ['--preserve-status', `timeout --preserve-status 60 ${tail}`],
    ['-v', `timeout -v 60 ${tail}`],
    ['--verbose', `timeout --verbose 60 ${tail}`],
    ['-fv (値なしの束)', `timeout -fv 60 ${tail}`],
    ['-vk5 (束 + 値)', `timeout -vk5 60 ${tail}`],
    ['-pfs KILL (束 + 空白区切りの値)', `timeout -pfs KILL 60 ${tail}`],
    ['オプションの併用', `timeout --foreground -k5 -s KILL --verbose 60 ${tail}`],
    ['/usr/bin/timeout', `/usr/bin/timeout 60 ${tail}`],
    ['パス付き + オプション', `/usr/bin/timeout -k5 60 ${tail}`],
    ['継続時間 1e1', `timeout 1e1 ${tail}`],
    ['継続時間 0x10', `timeout 0x10 ${tail}`],
    ['継続時間 inf', `timeout inf ${tail}`],
    ['&& の後ろ + オプション', `cd /tmp && timeout -k5 60 ${tail}`],
    ['-d（短縮形）+ オプション', `timeout --foreground 60 gh pr merge 7 -d`],
  ])('弾く: %s', (_label, command) => {
    expect(inspectBashCommand(command)).toMatchObject({
      blocked: true,
      form: 'gh-pr-merge-delete-branch',
    });
  });

  it.each([
    [
      '--delete-branch 無しの gh pr merge',
      'timeout 20 gh pr merge 7 --squash --body x --match-head-commit abc',
    ],
    [
      'オプション付きで --delete-branch 無し',
      'timeout -k5 --foreground 60 gh pr merge 7 --squash --body x --match-head-commit abc',
    ],
    [
      'パス付きで --delete-branch 無し',
      '/usr/bin/timeout 60 gh pr merge 7 --squash --body x --match-head-commit abc',
    ],
    ['無関係なコマンド', 'timeout --signal KILL -k5 60 pnpm test'],
    ['echo の引数', 'echo /usr/bin/timeout -k5 60 gh pr merge 1 --delete-branch'],
  ])('通す: %s', (_label, command) => {
    expect(inspectBashCommand(command).blocked).toBe(false);
  });

  it('isTimeoutWrapped: パス付き timeout に包まれた単一コマンドは有界と読んで通す', () => {
    expect(inspectBashCommand('/usr/bin/timeout 60 tail -f /tmp/x').blocked).toBe(false);
    expect(inspectBashCommand('timeout --foreground 60 tail -f /tmp/x').blocked).toBe(false);
    expect(inspectBashCommand('/usr/bin/timeout 60 tail -f /tmp/x; tail -f /tmp/y').blocked).toBe(
      true,
    );
  });

  it('オプションの繰り返しが長くても後戻りで爆発しない（弾かれる入力）', () => {
    const makeInput = (n: number) =>
      `${'timeout -k5 -fv -s KILL --kill-after 5 60 '.repeat(n)}gh pr merge 1 --delete-branch`;
    expect(inspectBashCommand(makeInput(30)).blocked).toBe(true);
    expectNotSuperlinear(inspectBashCommand, makeInput, { n: 15, factor: 2 });
  });

  it('前置きの繰り返しの末尾が外れる入力でも後戻りで爆発しない', () => {
    const makeInput = (n: number) => `${'/x/timeout -k5 60 A=/timeout '.repeat(n)}gh pr view 1`;
    expect(inspectBashCommand(makeInput(30)).blocked).toBe(false);
    expectNotSuperlinear(inspectBashCommand, makeInput, { n: 15, factor: 2 });
  });

  it('オプションだけの長い並びでも爆発しない', () => {
    const makeInput = (n: number) => `timeout ${'-fvp '.repeat(n)}x`;
    expect(inspectBashCommand(makeInput(400)).blocked).toBe(false);
    expectNotSuperlinear(inspectBashCommand, makeInput, { n: 200, factor: 2 });
  });
});
