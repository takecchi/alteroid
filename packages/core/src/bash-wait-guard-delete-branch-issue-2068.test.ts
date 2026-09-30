import { describe, expect, it } from 'vitest';

import { inspectBashCommand } from './bash-wait-guard-delete-branch.test-support.js';
import { expectNotSuperlinear } from './time-growth.test-support.js';

/**
 * issue #2068 —— `gh pr merge --delete-branch`/`-d` の検出が、次の3か所
 * ですり抜けていた: (A) コマンドの位置と `gh` のあいだの**前置きのコマンド**
 * （`sudo`/`nice`/`nohup`/`command`/`exec`/`xargs`/`setsid`/`stdbuf` 等、
 * オプション付きを含む） (B) 既存の前置き（`env`/`timeout`）自身のオプション
 * （`env -i`/`env --`/`env -S`、`timeout -k`/`timeout --signal=`） (C) 代入
 * の値が空白を含む引用符形（`X="a b"`） (D) `gh` という語そのものの書き方
 * （パス付き・`\gh`・引用符で囲んだだけ） (E) `gh` と `pr` のあいだの
 * リポジトリ選択フラグ（`-R`/`--repo`） (F) `-d` の短縮オプションの束ね書き
 * （`-sd` 等）・ANSI-C/`$"…"` クオート。
 *
 * 依頼者が main 795d829 の写しで実測した結果（`inspectBashCommand(cmd)
 * .blocked`）は、Issue 本文に挙げた31形のうち28形が `false`（すり抜け）
 * だった。直し方は `bash-wait-guard.ts` の `LEADING_COMMAND_PREFIX_SRC`・
 * `FLOCK_PREFIX_SRC`（A族）・`ENV_COMMAND_OPTION_SRC`・
 * `TIMEOUT_COMMAND_OPTION_SRC`（B族）・`ENV_ASSIGNMENT_VALUE_SRC`（C族）・
 * `GH_WORD_SRC`（D族）・`GH_REPO_FLAG_SRC`（E族）・
 * `SHORT_DELETE_BRANCH_FLAG_SRC`（F族）の doc 参照。
 */
describe('gh-pr-merge-delete-branch: issue #2068 の28形すべてを弾く', () => {
  const knownGaps: ReadonlyArray<[string, string]> = [
    // A族——前置きのコマンド（オプション付きを含む）
    ['A: sudo（オプション無し、--delete-branch）', 'sudo gh pr merge 1 --delete-branch'],
    ['A: sudo -u bot（分離した値）', 'sudo -u bot gh pr merge 1 -d'],
    ['A: nice -n 10（分離した値）', 'nice -n 10 gh pr merge 1 -d'],
    ['A: nohup', 'nohup gh pr merge 1 -d'],
    ['A: command', 'command gh pr merge 1 -d'],
    ['A: exec', 'exec gh pr merge 1 -d'],
    ['A: xargs（オプション無し）', 'xargs gh pr merge -d'],
    ['A: xargs -I{}（くっついた値）', 'xargs -I{} gh pr merge {} -d'],
    ['A: setsid', 'setsid gh pr merge 1 -d'],
    ['A: stdbuf -oL（くっついた値）', 'stdbuf -oL gh pr merge 1 -d'],

    // B族——env / timeout 自身のオプション
    ['B: env -i', 'env -i gh pr merge 1 -d'],
    ['B: env --', 'env -- gh pr merge 1 -d'],
    ['B: env -S "x"', 'env -S "x" gh pr merge 1 -d'],
    ['B: timeout -k 5 30', 'timeout -k 5 30 gh pr merge 1 -d'],
    ['B: timeout --signal=KILL 30', 'timeout --signal=KILL 30 gh pr merge 1 -d'],

    // C族——代入の値が空白を含む引用符形
    ['C: X="a b"（二重引用符）', 'X="a b" gh pr merge 1 -d'],
    ["C: X='a b'（単一引用符）", "X='a b' gh pr merge 1 -d"],

    // F族——短縮オプションの束ね書き・ANSI-C/$"…"クオート
    ['F: -sd', 'gh pr merge 1 -sd'],
    ['F: -ds', 'gh pr merge 1 -ds'],
    ['F: -msd', 'gh pr merge 1 -msd'],
    ['F: -sdt x（d の後ろに値を取る t が続く）', 'gh pr merge 1 -sdt x'],
    ["F: $'-d'（ANSI-C クオート）", "gh pr merge 1 $'-d'"],
    ['F: $"-d"', 'gh pr merge 1 $"-d"'],

    // E族——gh と pr のあいだのリポジトリ選択フラグ
    ['E: gh -R o/r pr merge', 'gh -R o/r pr merge 1 -d'],
    ['E: gh --repo o/r pr merge', 'gh --repo o/r pr merge 1 -d'],

    // D族——gh という語そのものの書き方
    ['D: パス付き（/usr/local/bin/gh）', '/usr/local/bin/gh pr merge 1 -d'],
    ['D: バックスラッシュ（\\gh）', '\\gh pr merge 1 -d'],
    ['D: 引用符で囲んだだけ（"gh"）', '"gh" pr merge 1 -d'],
  ];

  // Issue 本文の31形のうち、既に true だった3形（回帰確認として残す。
  // 28形の対象ではない——`gh  pr merge`/`gh pr  merge` は複数空白、
  // `GH_REPO=o/r gh …` は素の環境変数代入で、どちらも直す前から `\s+`/
  // `ENV_ASSIGNMENT_SRC` がすでに読めていた）。
  const alreadyTrueBeforeThisIssue: ReadonlyArray<[string, string]> = [
    ['複数空白（gh と pr のあいだ）', 'gh  pr merge 1 -d'],
    ['複数空白（pr と merge のあいだ）', 'gh pr  merge 1 -d'],
    ['GH_REPO=o/r（素の環境変数代入、既存の ENV_ASSIGNMENT_SRC）', 'GH_REPO=o/r gh pr merge 1 -d'],
  ];

  for (const [label, command] of [...knownGaps, ...alreadyTrueBeforeThisIssue]) {
    it(`${label}: 弾く`, () => {
      const verdict = inspectBashCommand(command);
      expect(verdict.blocked).toBe(true);
      if (!verdict.blocked) throw new Error('unreachable');
      expect(verdict.form).toBe('gh-pr-merge-delete-branch');
    });
  }

  it('28形すべてで knownGaps の件数が28件であること（表と実装のずれを検知する）', () => {
    expect(knownGaps.length).toBe(28);
  });
});

/**
 * 偽陽性にならないこと —— A〜F族の直しを足しても、既存の「通す形」が
 * 巻き込まれて弾かれるようになっていないか。Issue 本文・#1764/#1910/#1991
 * の受け入れ基準（引用符の中・別コマンドの引数・値を取るフラグの値）を
 * そのまま対照にする。
 */
describe('gh-pr-merge-delete-branch: issue #2068 の直しを足しても偽陽性にならない', () => {
  it('引用符の中の sudo gh pr merge -d は通す（echo の引数）', () => {
    expect(inspectBashCommand('echo "sudo gh pr merge 1 -d"').blocked).toBe(false);
  });

  it('gh pr merge 1 -bd は通す（-b は値を取るので d は --body の値）', () => {
    expect(inspectBashCommand('gh pr merge 1 -bd').blocked).toBe(false);
  });

  it('gh pr merge 1 --squash は通す（--delete-branch も -d も無い）', () => {
    expect(inspectBashCommand('gh pr merge 1 --squash').blocked).toBe(false);
  });

  it('sudo gh pr merge 1 --squash は通す（sudo は読み飛ばすが --squash に -d は無い）', () => {
    expect(inspectBashCommand('sudo gh pr merge 1 --squash').blocked).toBe(false);
  });

  it("grep -- '-sd' f は通す（gh pr merge の呼び出しがそもそも無い）", () => {
    expect(inspectBashCommand("grep -- '-sd' f").blocked).toBe(false);
  });

  it('gh pr create --body の引用符の中の sudo gh pr merge -d は通す（--body の値として潰される）', () => {
    expect(inspectBashCommand('gh pr create --body "sudo gh pr merge 1 -d"').blocked).toBe(false);
  });

  it('/usr/local/bin/gh pr view 1 は通す（パス付き gh でも merge ではなく view）', () => {
    expect(inspectBashCommand('/usr/local/bin/gh pr view 1').blocked).toBe(false);
  });

  it('-d を含む別の語（-dev 等）と誤認しない（回帰確認、F族の直しで壊していないこと）', () => {
    expect(inspectBashCommand('gh pr merge 123 -dev').blocked).toBe(false);
  });
});

/**
 * bonus —— Issue の必須28形には無いが、A〜F族の依頼文がそのまま挙げていた
 * 追加の書き方（`--repo=`・`./gh`・単一引用符の `'gh'`）。28形の表には
 * 含めていない（数え上げの対象は上の describe だけ）。
 */
describe('gh-pr-merge-delete-branch: issue #2068 の追加確認（28形の表には含めない bonus）', () => {
  it('E bonus: --repo=o/r（= 区切り）', () => {
    expect(inspectBashCommand('gh --repo=o/r pr merge 1 -d').blocked).toBe(true);
  });

  it('D bonus: ./gh（相対パス）', () => {
    expect(inspectBashCommand('./gh pr merge 1 -d').blocked).toBe(true);
  });

  it("D bonus: 'gh'（単一引用符）", () => {
    expect(inspectBashCommand("'gh' pr merge 1 -d").blocked).toBe(true);
  });

  it('A bonus: flock <file>（オプション無し）', () => {
    expect(inspectBashCommand('flock /tmp/l gh pr merge 1 -d').blocked).toBe(true);
  });

  // ⚠️ 弾けない形（`FLOCK_PREFIX_SRC` の doc）。`flock` 自身のオプション
  // 文法までは解いていないので、`-n` のようなオプションが付くと `flock`
  // の直後に来るべき「素の位置引数（ロックファイル）」が見つからず、
  // この前置き全体が読み飛ばせなくなる——`gh` が前置きコマンドの名前と
  // 誤認されないぶん安全側（すり抜けではなく検出漏れ）。
  //
  // ⚠️ レビュー（mgr-712ad619）で `it.fails` に直した。最初の版は
  // `toBe(false)` で「通る」を仕様として固定していた。これは既知の穴であって
  // 望む挙動ではないので、望む挙動（`true`）を期待値に書き、直った瞬間に
  // 赤くなって知らせる形にした（`bash-wait-guard.test.ts` の `bash -c` の
  // 反転と同じ理由）。
  //
  // その後、`flock` 自身のオプションを読むようにして直った（mgr-712ad619、
  // 2026-09-29T06:2xZ。`FLOCK_PREFIX_SRC` の doc）ので、`it.fails` から `it` へ戻した。
  // 期待値（`true`）は変えていない。他の形の歯は `bash-wait-guard-delete-branch-flock.test.ts`。
  it('A bonus: flock -n <file>（オプション付き。直った）', () => {
    expect(inspectBashCommand('flock -n /tmp/l gh pr merge 1 -d').blocked).toBe(true);
  });

  // 以下はレビュー（mgr-712ad619、2026-09-29T01:1xZ）で見つけて直した形。
  it('F: -dR o/r（d の後ろに、値を取る -R が続く＝ -d -R o/r）', () => {
    expect(inspectBashCommand('gh pr merge 1 -dR o/r').blocked).toBe(true);
  });

  it('F: -sdR o/r', () => {
    expect(inspectBashCommand('gh pr merge 1 -sdR o/r').blocked).toBe(true);
  });

  it('A: オプションの値が timeout という語でも読む（sudo -u timeout gh …）', () => {
    expect(inspectBashCommand('sudo -u timeout gh pr merge 1 -d').blocked).toBe(true);
  });

  it('A: オプションの値が前置きの名前でも弾く（sudo -u sudo gh …）', () => {
    expect(inspectBashCommand('sudo -u sudo gh pr merge 1 -d').blocked).toBe(true);
  });

  it('A: オプションの値が gh という語なら、gh として読んで弾く（sudo -u gh pr merge …）', () => {
    expect(inspectBashCommand('sudo -u gh pr merge 1 -d').blocked).toBe(true);
  });
});

/**
 * 時間の歯 —— 既存の `bash-wait-guard-delete-branch-issue-2035.test.ts` /
 * `bash-wait-guard-delete-branch-timeout-prefix.test.ts` と同じ形。
 *
 * A族の最初の版（`LEADING_COMMAND_PREFIX_OPTION_SRC` の doc参照）は
 * `stdbuf -oL `.repeat(n) で n=30 のとき28755ms（約29秒）というカタスト
 * ロフィックな後戻りを起こした。ここではその直し（1文字フラグ+空白+値、
 * ダッシュ+くっついた値の2択に分けた版）が実際に線形で終わることを、
 * 依頼された繰り返し（`sudo -u a `/`env -i `/`X="a b" `）に加え、
 * `stdbuf -oL `/`xargs -I{} `（バグを踏んだ形そのもの）でも測る。
 *
 * issue #2187 —— 壁時計の絶対値（`TIME_BUDGET_MS = 200`）から伸びの比へ
 * 替えた。`n * factor` を、直す前にテストしていた繰り返し回数へ揃えてある
 * （依頼者の実測では A族の最初の版が n=30 で28755ms、直した版は数ms）。
 */
describe('gh-pr-merge-delete-branch: issue #2068 前置きの繰り返しが長くても後戻りで爆発しない', () => {
  it('sudo -u a の繰り返し（gh pr merge を含まない）が線形に終わる', () => {
    const makeInput = (n: number) => `${'sudo -u a '.repeat(n)}x`;
    expect(inspectBashCommand(makeInput(1250 * 4)).blocked).toBe(false);
    expectNotSuperlinear(inspectBashCommand, makeInput, { n: 1250 });
  });

  it('env -i の繰り返し（gh pr merge を含まない）が線形に終わる', () => {
    const makeInput = (n: number) => `${'env -i '.repeat(n)}x`;
    expect(inspectBashCommand(makeInput(2000 * 4)).blocked).toBe(false);
    expectNotSuperlinear(inspectBashCommand, makeInput, { n: 2000 });
  });

  it('X="a b" の繰り返し（gh pr merge を含まない）が線形に終わる', () => {
    const makeInput = (n: number) => `${'X="a b" '.repeat(n)}x`;
    expect(inspectBashCommand(makeInput(1250 * 4)).blocked).toBe(false);
    expectNotSuperlinear(inspectBashCommand, makeInput, { n: 1250 });
  });

  // `LEADING_COMMAND_PREFIX_OPTION_SRC` の doc に書いた、実際に
  // カタストロフィックな後戻りを踏んだ形そのもの（くっついた値）。
  it('stdbuf -oL の繰り返し（くっついた値、gh pr merge を含まない）が線形に終わる', () => {
    const makeInput = (n: number) => `${'stdbuf -oL '.repeat(n)}x`;
    expect(inspectBashCommand(makeInput(1000 * 4)).blocked).toBe(false);
    expectNotSuperlinear(inspectBashCommand, makeInput, { n: 1000 });
  });

  it('xargs -I{} の繰り返し（くっついた値、gh pr merge を含まない）が線形に終わる', () => {
    const makeInput = (n: number) => `${'xargs -I{} '.repeat(n)}x`;
    expect(inspectBashCommand(makeInput(1000 * 4)).blocked).toBe(false);
    expectNotSuperlinear(inspectBashCommand, makeInput, { n: 1000 });
  });

  it('timeout -k 5 30 の繰り返し（gh pr merge を含まない）が線形に終わる', () => {
    const makeInput = (n: number) => `${'timeout -k 5 30 '.repeat(n)}x`;
    expect(inspectBashCommand(makeInput(1000 * 4)).blocked).toBe(false);
    expectNotSuperlinear(inspectBashCommand, makeInput, { n: 1000 });
  });

  // レビュー（mgr-712ad619）で見つけた指数的な後戻り。オプションの値の位置に
  // `-` で始まる語や前置きの名前が来ると、値として飲み込む読みと飲み込まない
  // 読みが同じ続きへ再合流していた（直す前は n=28 で 3.5ms、4 増えるごとに
  // 約7倍。n=2000 は現実的な時間では終わらない）。
  it('値の位置に - で始まる語が続く繰り返し（sudo -a -a …）が線形に終わる', () => {
    const makeInput = (n: number) => `sudo ${'-a '.repeat(n)}x`;
    expect(inspectBashCommand(makeInput(500 * 4)).blocked).toBe(false);
    expectNotSuperlinear(inspectBashCommand, makeInput, { n: 500 });
  });

  // 上の n=2000 は、指数の版では終わらない（テストが失敗ではなく止まる）。
  // 指数の版でも1秒前後で終わって赤になる大きさを別に置く（4 増えるごとに
  // 約7倍なので、n=28 の 3.5ms から n=40 は 1 秒を超える）。ここは
  // `factor: 2` にして、`2n`（=40）を直す前にテストしていた大きさへ揃える。
  it('値の位置に - で始まる語が続く短い繰り返し（n=40）も予算内に終わる', () => {
    const makeInput = (n: number) => `sudo ${'-a '.repeat(n)}x`;
    expect(inspectBashCommand(makeInput(40)).blocked).toBe(false);
    expectNotSuperlinear(inspectBashCommand, makeInput, { n: 20, factor: 2 });
  });

  it('値の位置に前置きの名前が続く繰り返し（sudo -u sudo -u …）が線形に終わる', () => {
    const makeInput = (n: number) => `${'sudo -u '.repeat(n)}x`;
    expect(inspectBashCommand(makeInput(500 * 4)).blocked).toBe(false);
    expectNotSuperlinear(inspectBashCommand, makeInput, { n: 500 });
  });

  it('前置きの繰り返しの末尾に gh pr merge -d が来ても弾き、かつ後戻りが爆発しない', () => {
    const makeInput = (n: number) => `${'sudo -u a '.repeat(n)}gh pr merge 1 -d`;
    expect(inspectBashCommand(makeInput(1250 * 4)).blocked).toBe(true);
    expectNotSuperlinear(inspectBashCommand, makeInput, { n: 1250 });
  });
});

/**
 * 前置き（代入・`timeout`・`env`）の末尾の空白を `[ \t]+` に絞った直しの歯
 * （`ENV_ASSIGNMENT_SRC` の doc）。`\s+` の版では改行を跨いで鎖が繋がり、
 * `'A=1\n'.repeat(10000)+'x'`（40KB）が 715〜788ms かかった（直した版は 5.4ms。
 * mgr-712ad619 の実測 2026-09-29T02:1xZ）。
 *
 * issue #2187 —— 壁時計の絶対値から伸びの比へ替えた。`n * factor` を
 * 直す前にテストしていた繰り返し回数（10000 / 8000）に揃えてある。
 */
describe('gh-pr-merge-delete-branch: 前置きの鎖は改行を跨がない（2乗の後戻りを作らない）', () => {
  it('改行で区切った代入の繰り返し（gh pr merge を含まない）が予算内に終わる', () => {
    const makeInput = (n: number) => `${'A=1\n'.repeat(n)}x`;
    expect(inspectBashCommand(makeInput(2500 * 4)).blocked).toBe(false);
    expectNotSuperlinear(inspectBashCommand, makeInput, { n: 2500 });
  });

  it('改行で区切った timeout 5 の繰り返しが予算内に終わる', () => {
    const makeInput = (n: number) => `${'timeout 5\n'.repeat(n)}x`;
    expect(inspectBashCommand(makeInput(2000 * 4)).blocked).toBe(false);
    expectNotSuperlinear(inspectBashCommand, makeInput, { n: 2000 });
  });

  // 改行の直後はコマンドの位置なので、鎖が改行で切れても次の行の gh は弾く。
  const acrossNewline: ReadonlyArray<[string, string]> = [
    ['代入の次の行', 'A=1\ngh pr merge 1 -d'],
    ['代入と timeout の次の行', 'A=1 B=2\ntimeout 5\ngh pr merge 1 -d'],
    ['env の次の行', 'env\ngh pr merge 1 -d'],
    ['タブ区切りの代入', 'A=1\tgh pr merge 1 -d'],
    ['then の次の行の代入付き', 'if true; then\n  GH_TOKEN=x gh pr merge 1 -d\nfi'],
  ];
  for (const [label, command] of acrossNewline) {
    it(`${label}: 弾く`, () => {
      expect(inspectBashCommand(command).blocked).toBe(true);
    });
  }
});
