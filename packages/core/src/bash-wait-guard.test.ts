import { describe, expect, it } from 'vitest';

import { inspectBashCommand } from './bash-wait-guard-delete-branch.test-support.js';

/**
 * `inspectBashCommand`（#894 段1・案(A)）の歯。
 *
 * **2群に分けて測る。**
 *
 * 1. **弾くべきもの** —— #894 が逐語で記録した実物2本（Issue 本文からコピー。
 *    書き手の写しを信用しない）＋ 合成した `while` / `tail -f` の2本。
 * 2. **弾いてはいけないもの** —— AGENTS.md「テストを弱めずに直す」の言う
 *    「対象をスコープして特定する」側。**3件では足りない**（最小の要素数では、
 *    両方が同じ向きに間違える対称な誤りが通る）ので、「弾いてはいけないもの」
 *    に挙げた全種を fixture にする。
 */

describe('inspectBashCommand — 弾くべきもの（無限待ちの形）', () => {
  // ⭐ Issue #894 本文からの逐語（`gh issue view 894 --repo takecchi/alteroid` で
  // コピー）。書き手の写しではなく実物そのもの。
  it('#894 実測1: mutation run の完了を待つ until+sleep を弾く', () => {
    const verdict = inspectBashCommand(
      'until grep -q "^run: まとめ$" /tmp/mutation-run-865.log 2>/dev/null; do sleep 5; done; echo "=== mutation run finished ==="; tail -5 /tmp/mutation-run-865.log',
    );
    expect(verdict.blocked).toBe(true);
    if (!verdict.blocked) throw new Error('unreachable');
    expect(verdict.form).toBe('until-sleep');
    expect(verdict.reason).toContain('gh run watch');
    expect(verdict.reason).toContain('timeout');
  });

  it('#894 実測2: verify run2 の完了を待つ until+sleep を弾く', () => {
    const verdict = inspectBashCommand(
      'until grep -q "^VERIFY_EXIT=" /tmp/verify-run2.log 2>/dev/null; do sleep 15; done; echo "=== verify run2 finished ==="; tail -40 /tmp/verify-run2.log',
    );
    expect(verdict.blocked).toBe(true);
    if (!verdict.blocked) throw new Error('unreachable');
    expect(verdict.form).toBe('until-sleep');
  });

  it('while + sleep の形も弾く', () => {
    const verdict = inspectBashCommand('while ! test -f done.txt; do sleep 10; done');
    expect(verdict.blocked).toBe(true);
    if (!verdict.blocked) throw new Error('unreachable');
    expect(verdict.form).toBe('while-sleep');
  });

  it('tail -f を弾く', () => {
    const verdict = inspectBashCommand('tail -f /tmp/run.log');
    expect(verdict.blocked).toBe(true);
    if (!verdict.blocked) throw new Error('unreachable');
    expect(verdict.form).toBe('tail-f');
  });

  it('tail --follow も弾く', () => {
    const verdict = inspectBashCommand('tail --follow=name /tmp/run.log');
    expect(verdict.blocked).toBe(true);
    if (!verdict.blocked) throw new Error('unreachable');
    expect(verdict.form).toBe('tail-f');
  });

  it('拒否の理由には具体的な代替が3つとも入っている（依頼者からの明示の条件）', () => {
    const verdict = inspectBashCommand('until false; do sleep 3; done');
    expect(verdict.blocked).toBe(true);
    if (!verdict.blocked) throw new Error('unreachable');
    expect(verdict.reason).toContain('gh run watch');
    expect(verdict.reason).toContain('timeout');
    expect(verdict.reason).toContain('成果物が在るかを前景の呼び出しで見に行く');
  });
});

describe('inspectBashCommand — 弾いてはいけないもの（有界と読める形。⚠️ 全種を fixture にする）', () => {
  it('全体が timeout N ... に包まれていれば通す', () => {
    const verdict = inspectBashCommand(
      "timeout 60 bash -c 'until grep -q done /tmp/x.log; do sleep 5; done'",
    );
    expect(verdict.blocked).toBe(false);
  });

  it('for ループ（sleep を伴っても）は通す', () => {
    const verdict = inspectBashCommand('for i in $(seq 1 30); do echo "tick $i"; sleep 2; done');
    expect(verdict.blocked).toBe(false);
  });

  it('while read（入力で尽きる）は sleep を伴っても通す', () => {
    const verdict = inspectBashCommand(
      'while read -r line; do sleep 1; echo "$line"; done < /tmp/queue.txt',
    );
    expect(verdict.blocked).toBe(false);
  });

  it('カウンタの比較（-lt）が在れば通す', () => {
    const verdict = inspectBashCommand(
      'i=0; while [ "$i" -lt 30 ]; do sleep 1; i=$((i + 1)); done',
    );
    expect(verdict.blocked).toBe(false);
  });

  it('カウンタの比較（算術文脈 (( ))）が在れば通す', () => {
    const verdict = inspectBashCommand('i=0; while (( i < 30 )); do sleep 1; i=$((i + 1)); done');
    expect(verdict.blocked).toBe(false);
  });

  it('本体に break が在れば通す', () => {
    const verdict = inspectBashCommand(
      'while true; do sleep 1; if [ -f /tmp/finished.flag ]; then break; fi; done',
    );
    expect(verdict.blocked).toBe(false);
  });

  // ⭐ #894 段2で直した誤爆の回帰歯。逐語は bash-wait-guard.ts の doc
  // 「`do` / `done` は『コマンドの位置に在るとき』だけ終端と見なす」に在る。
  // 以前はこの入力を「有界なのに弾く」形で誤爆していた（`/tmp/done` の
  // `done` を本物の `done` と取り違え、`break` を読む前に本体を打ち切って
  // いた）。前任者はこの実例のパス名を `/tmp/finished.flag` へ避けて回避
  // したが、それは検出器の正しさとは無関係に緑にしただけだった。この歯は
  // 避けずに元の実例そのものを歯として戻す。
  it('本体に break が在れば通す（パス名が done を含んでいても誤爆しない）', () => {
    const verdict = inspectBashCommand(
      'while true; do sleep 1; if [ -f /tmp/done ]; then break; fi; done',
    );
    expect(verdict.blocked).toBe(false);
  });

  it('ループが無ければ通す（gh run watch のような自分で終わる呼び出し）', () => {
    const verdict = inspectBashCommand('gh run watch 12345 --exit-status');
    expect(verdict.blocked).toBe(false);
  });

  it('単独の sleep（ループを伴わない1回の待ち）は通す', () => {
    const verdict = inspectBashCommand('sleep 5; echo done');
    expect(verdict.blocked).toBe(false);
  });

  it('sleep を伴わない until/while（busy-wait 相当）は、この検出器の対象外として通す', () => {
    const verdict = inspectBashCommand('until false; do :; done');
    expect(verdict.blocked).toBe(false);
  });

  it('tail -n（follow ではない）は通す', () => {
    const verdict = inspectBashCommand('tail -n 40 /tmp/run.log');
    expect(verdict.blocked).toBe(false);
  });

  it('別の単純コマンドに在る -f は tail の追従と混同しない', () => {
    const verdict = inspectBashCommand('tail -5 /tmp/a.log; grep -f /tmp/patterns.txt /tmp/b.log');
    expect(verdict.blocked).toBe(false);
  });

  it('空文字列は通す', () => {
    expect(inspectBashCommand('').blocked).toBe(false);
  });
});

/**
 * `gh run watch` を背景へ置く形（AGENTS.md「CI の完了を待つ形」）。
 *
 * **2群に分けるのは上の2つと同じだが、比重が逆である。** 上の2群は「弾く
 * べきもの」が実測の逐語から来ていた。こちらは **⭐ 弾いてはいけないものの
 * ほうを厚くする** —— この判定器はこの repo で走る全てのマネージャーと
 * 作業者の `Bash` に効くので、**偽陽性のほうが偽陰性より高い。** 普通の
 * コマンド（`git status` / `pnpm -v` / `gh pr list` / パイプ / 日本語）が
 * 通ることを、`backgrounded` の両方の値で測る。
 */
describe('inspectBashCommand — gh run watch を背景へ置く形', () => {
  // ⭐ `.claude/skills/pr-green/SKILL.md`（この項は #1753 で AGENTS.md「CI の
  // 完了を待つ形」から移った）が逐語で記録した実物2本。**どちらも
  // `&` を持たない** —— 背景化は `Bash` ツールの `run_in_background` 側で
  // 起きていた。だから文字列だけを読む機械では、この2本は検出できない。
  it('実測1: worker a25a28c41 の形を、run_in_background なら弾く', () => {
    const command =
      'gh run watch 35196482974 --repo takecchi/alteroid --exit-status 2>&1 | tail -60';
    const verdict = inspectBashCommand(command, { backgrounded: true });
    expect(verdict.blocked).toBe(true);
    if (!verdict.blocked) throw new Error('unreachable');
    expect(verdict.form).toBe('gh-run-watch-background');
  });

  it('実測2: worker a86fd5bd3 の形を、run_in_background なら弾く', () => {
    const command =
      'gh run watch 35195863856 --repo takecchi/alteroid --exit-status 2>&1 | tail -40';
    expect(inspectBashCommand(command, { backgrounded: true }).blocked).toBe(true);
  });

  it('コマンド文字列の末尾の & でも弾く', () => {
    const verdict = inspectBashCommand('gh run watch 12345 --exit-status &');
    expect(verdict.blocked).toBe(true);
    if (!verdict.blocked) throw new Error('unreachable');
    expect(verdict.form).toBe('gh-run-watch-background');
  });

  it('パイプライン全体を & で背景へ置く形も弾く', () => {
    expect(inspectBashCommand('gh run watch 123 2>&1 | tail -60 &').blocked).toBe(true);
  });

  it('nohup + & も弾く', () => {
    expect(inspectBashCommand('nohup gh run watch 123 --exit-status &').blocked).toBe(true);
  });

  // 拒否は必ず代替と対にする（このファイル冒頭「単独の `sleep` を弾かない理由」）。
  it('理由に代替が3つとも載る（前景 timeout / 上限付きポーリング / head sha の明示）', () => {
    const verdict = inspectBashCommand('gh run watch 123 &');
    if (!verdict.blocked) throw new Error('unreachable');
    expect(verdict.reason).toContain('timeout');
    expect(verdict.reason).toContain('check-runs');
    expect(verdict.reason).toContain('head sha を明示');
    expect(verdict.reason).toContain('| tail');
  });
});

describe('inspectBashCommand — 背景の判定で誤爆しない（⭐ 偽陽性のほうが高い）', () => {
  // ⭐ 依頼者が名指しで要求した5つ。**`backgrounded` の両方の値で測る** ——
  // 背景指定そのものを禁止にしてしまうと、この repo の全員の手が止まる。
  const ordinaryCommands = [
    ['git status', 'git status'],
    ['pnpm -v', 'pnpm -v'],
    ['gh pr list', 'gh pr list --state all --limit 1000'],
    ['パイプを含む', "gh run list --limit 10 | head -5 | awk '{print $1}'"],
    ['日本語を含む', 'echo "検証が緑になりました" && git log --oneline -1'],
    ['gh run list の背景実行', 'gh run list --repo takecchi/alteroid --limit 50 &'],
    ['pnpm test の背景実行', 'pnpm test --maxWorkers=4 > /tmp/test.log 2>&1 &'],
  ] as const;

  for (const [label, command] of ordinaryCommands) {
    it(`${label}: 前景でも背景でも通す`, () => {
      expect(inspectBashCommand(command).blocked).toBe(false);
      expect(inspectBashCommand(command, { backgrounded: true }).blocked).toBe(false);
    });
  }

  // ⭐ ここがいちばん効く歯である —— `2>&1` の `&` を背景化と読むと、
  // リダイレクトを書いた全てのコマンドが止まる。
  it('2>&1 のリダイレクトを背景化と読まない（前景の gh run watch は通す）', () => {
    expect(inspectBashCommand('gh run watch 123 --exit-status 2>&1 | tail -60').blocked).toBe(
      false,
    );
  });

  it('&& の連鎖を背景化と読まない', () => {
    expect(inspectBashCommand('gh run watch 123 --exit-status && echo ok').blocked).toBe(false);
  });

  it('前景の gh run watch は通す（ALTERNATIVES が勧めている当の形）', () => {
    expect(inspectBashCommand('gh run watch 12345 --exit-status').blocked).toBe(false);
  });

  it('後続の別コマンドだけが背景なら通す', () => {
    expect(inspectBashCommand('gh run watch 123 --exit-status; echo done &').blocked).toBe(false);
  });

  // 意図して開けてある逃げ道（`bash-wait-guard.ts` の doc「弾かないと分かっている形」）。
  it('timeout に包まれていれば背景でも通す（このモジュールの約束を崩さない）', () => {
    expect(inspectBashCommand('timeout 600 gh run watch 123 --exit-status &').blocked).toBe(false);
    expect(
      inspectBashCommand('timeout 600 gh run watch 123 --exit-status', { backgrounded: true })
        .blocked,
    ).toBe(false);
  });

  it('gh の別サブコマンドは watch という語を含んでいても通す', () => {
    expect(inspectBashCommand('gh api repos/o/r/actions/runs --jq .workflow_runs &').blocked).toBe(
      false,
    );
    expect(inspectBashCommand('gh run list | grep watch &').blocked).toBe(false);
  });

  // fail-open の形そのもの: 呼び出し側が何も渡さなくても既定で前景に倒れる。
  it('invocation を省いても落ちず、前景として扱う', () => {
    expect(inspectBashCommand('gh run watch 123 --exit-status').blocked).toBe(false);
  });
});

/**
 * `gh pr merge --delete-branch`（Issue #1764）。
 *
 * **上の3形・`gh-run-watch-background` とは害の種類が違う。** あちらは
 * 「コマンドが終わらない」ことを弾いているが、こちらは一瞬で終わる ——
 * 害は「終わった後に取り返しが付かない」ことのほうである（積んだ PR が
 * 黙って閉じ、閉じたあとは reopen も --base の付け替えも拒まれる。実測は
 * `.claude/skills/tool-quirks/SKILL.md`、2026-09-15T07:3xZ、PR #1008/#1010）。
 *
 * **2群に分けるのは他の形と同じだが、Issue 本文が明示した順で書く** ——
 * 「弾く形」より先に「弾いてはいけないもの」を厚く測る。この文字列は
 * PR 本文・Issue 本文・説明文の中に頻出するので、`gh-run-watch-background`
 * と同じ理由で偽陽性のほうが高くつく。
 */
describe('inspectBashCommand — gh pr merge --delete-branch: 弾いてはいけないもの（⚠️ 偽陽性を先に測る）', () => {
  it('--delete-branch を付けていない gh pr merge は通す', () => {
    expect(inspectBashCommand('gh pr merge 123 --squash').blocked).toBe(false);
  });

  it('ヒアドキュメントの本文の中に在る gh pr merge --delete-branch は通す', () => {
    const command = "cat > body.md <<'EOF'\ngh pr merge 1 --delete-branch を使った\nEOF";
    expect(inspectBashCommand(command).blocked).toBe(false);
  });

  it('引用符の中に在る gh pr merge --delete-branch は通す', () => {
    expect(inspectBashCommand('echo "gh pr merge 1 --delete-branch は使わない"').blocked).toBe(
      false,
    );
  });

  it('gh pr create --body の引用符の中に在る --delete-branch は通す（Issue 本文の例そのまま）', () => {
    expect(
      inspectBashCommand(
        'gh pr create --title x --body "この PR は --delete-branch を使っていません"',
      ).blocked,
    ).toBe(false);
  });

  it('gh pr merge 以外のコマンドの引数に現れる --delete-branch は通す（Issue 本文の例そのまま）', () => {
    expect(inspectBashCommand("grep -- '--delete-branch' notes.md").blocked).toBe(false);
  });

  it('-d を含む別の語（-dev 等）と誤認しない', () => {
    expect(inspectBashCommand('gh pr merge 123 -dev').blocked).toBe(false);
  });

  // ⚠️ 弾けない形だった（doc「この検出器が弾けないと分かっている形」）。
  // 構文（コマンド位置）しか見ていなかったので、`bash -c` の引用符の中に
  // 本物の `gh pr merge --delete-branch` が在っても、この検出器はここでは
  // 検出できなかった。
  //
  // ⚠️ issue #2035 の作業（マネージャー mgr-712ad619 からの依頼）で
  // `it.fails` へ反転した。**その PR は `bash -c '…'` の中身を直していない**
  // ——直したのは bash の予約語・グルーピングの直後（`SHELL_KEYWORD_
  // PREFIX_SRC` 参照）であって、単一引用符の中を構文解析することとは別の
  // 穴だった。それでも AGENTS.md「テストを弱めずに直す」の言う「現行の
  // 欠陥を仕様として固定しているテストは反転させてよい」に当たると判断
  // した——`toBe(false)` のままだと「この文字列は通ってよい」が仕様として
  // 固定され、将来 `bash -c` の中身まで見る変更が入っても、このテストは
  // 何も知らせずに緑のまま通り続ける。`it.fails` にして期待値を望む挙動
  // （`blocked: true`）へ反転すれば、直った瞬間にこの `it.fails` 自体が
  // 失敗し（トリップワイヤー）、次に読む者が気づいて `it` へ戻せる。
  //
  // ⚠️ **issue #2104 の作業（マネージャー mgr-712ad619 からの依頼）で直り、
  // `it` へ戻した。** 直し方は「入口（シェルの `-c` 等）を見つけたら中身を
  // 取り出し、`hasGhPrMergeDeleteBranch` 自身にもう一度かける」再帰
  // （`bash-wait-guard.ts` の `hasGhPrMergeDeleteBranch` の doc、歯は
  // `bash-wait-guard-delete-branch-issue-2104.test.ts`）。トリップワイヤーが
  // 意図どおり働いた——このテストが赤くなって、直った事実を知らせた。
  it('bash -c の引用符の中の gh pr merge --delete-branch を弾く（issue #2104 で直った）', () => {
    expect(inspectBashCommand("bash -c 'gh pr merge 1 --delete-branch'").blocked).toBe(true);
  });
});

/**
 * issue #2035 の作業（マネージャー mgr-712ad619 からの依頼）で足した歯
 * ——`bash-wait-guard.ts` の「弾けないと分かっている形」に doc としては
 * 既に載っているが、これまでテストが無かった既知の穴。それぞれ
 * `it.fails` で「望む挙動（`blocked: true`）」を期待値に書き、直った
 * ときのトリップワイヤーにする（`toBe(false)` を仕様として固定しない
 * ため——上の `bash -c` の反転と同じ理由）。
 *
 * この PR（#2057/#2035）が実際に直したのは bash の**予約語・グルーピング**
 * （コマンドの位置を作るが、それ自体はコマンドとして実行されない）の直後
 * だけである。ここに並ぶのは、それとは別の族の前置き——**それ自体が1個の
 * コマンドとして実行される**前置き（`sudo`/`nice`/`xargs`/`command`/
 * `exec`/`nohup`）・`timeout` 自身のオプション文法（`-k`）・値が空白を
 * 含む引用符形の代入（`X="a b"`）・短縮オプションの束ね書き（`-sd`）——
 * どれも 1件ずつ検討する方針（#1192 のオーナー決定）で、この PR の範囲外
 * のまま残していた。
 *
 * ⚠️ **issue #2068 の作業（マネージャー mgr-712ad619 からの依頼）で、この
 * 9本すべてを `it` へ戻した。** `bash-wait-guard.ts` の A/B/C/F族の直しで
 * 9形とも `blocked: true` になったため——`it.fails` のまま直っていたら
 * ここが赤くなってトリップワイヤーとして働くはずだった（実際に直った
 * 結果、これらは緑のまま `it` として保証を持つテストになった）。`bash -c
 * '…'` の `it.fails` は issue #2068 の範囲外（構文解析そのものの限界）
 * だったので、その時点ではそのまま残した。
 *
 * ⚠️ **その `bash -c '…'` の穴自体は、issue #2104（マネージャー
 * mgr-712ad619 からの依頼）で直った——`it` へ戻し、上の describe の末尾に
 * 移した（「弾いてはいけないもの」の describe の最後の歯）。この
 * describe（issue #2035 で足した既知の穴）は9本のままで変わらない
 * ——`bash -c` の穴は元々別の describe（構文解析そのものの限界）に
 * 属していたため、ここへは足さない。
 */
describe('inspectBashCommand — gh pr merge --delete-branch: issue #2035 で歯を足した既知の穴（issue #2068 で直り、it へ戻した）', () => {
  it('sudo 前置き（コマンドとしての前置き、issue #2068 A族で直した）', () => {
    expect(inspectBashCommand('sudo gh pr merge 1 --delete-branch').blocked).toBe(true);
  });

  it('nice 前置き（同上、issue #2068 A族で直した）', () => {
    expect(inspectBashCommand('nice gh pr merge 1 --delete-branch').blocked).toBe(true);
  });

  it('xargs 前置き（同上、issue #2068 A族で直した）', () => {
    expect(inspectBashCommand('xargs gh pr merge 1 --delete-branch').blocked).toBe(true);
  });

  it('command 前置き（この PR で範囲外にした族。同じ「コマンドとしての前置き」。issue #2068 A族で直した）', () => {
    expect(inspectBashCommand('command gh pr merge 1 --delete-branch').blocked).toBe(true);
  });

  it('exec 前置き（同上、issue #2068 A族で直した）', () => {
    expect(inspectBashCommand('exec gh pr merge 1 --delete-branch').blocked).toBe(true);
  });

  it('nohup 前置き（同上、issue #2068 A族で直した）', () => {
    expect(inspectBashCommand('nohup gh pr merge 1 --delete-branch').blocked).toBe(true);
  });

  it('timeout -k（timeout 自身のオプション文法までは解いていない。issue #2068 B族で -k/--signal 等を読むようにした）', () => {
    expect(inspectBashCommand('timeout -k 5 30 gh pr merge 1 --delete-branch').blocked).toBe(true);
  });

  it('値が空白を含む引用符形の代入（X="a b"。\\S* が最初の空白までしか読めない。issue #2068 C族で引用符区間を読むようにした）', () => {
    expect(inspectBashCommand('X="a b" gh pr merge 1 --delete-branch').blocked).toBe(true);
  });

  it('-sd のような短縮オプションの束ね書き（issue #2068 F族で -[smr]*d を読むようにした）', () => {
    expect(inspectBashCommand('gh pr merge 1 -sd').blocked).toBe(true);
  });
});

describe('inspectBashCommand — gh pr merge --delete-branch を弾く', () => {
  it('--delete-branch を弾く', () => {
    const verdict = inspectBashCommand('gh pr merge 123 --delete-branch');
    expect(verdict.blocked).toBe(true);
    if (!verdict.blocked) throw new Error('unreachable');
    expect(verdict.form).toBe('gh-pr-merge-delete-branch');
    expect(verdict.reason).toContain('--delete-branch');
    expect(verdict.reason).toContain('delete_branch_on_merge');
  });

  it('-d（短縮形）も弾く', () => {
    expect(inspectBashCommand('gh pr merge 123 -d').blocked).toBe(true);
  });

  it('フラグの順序に依存しない（--delete-branch が先でも後でも弾く）', () => {
    expect(inspectBashCommand('gh pr merge 123 --delete-branch --squash').blocked).toBe(true);
    expect(inspectBashCommand('gh pr merge 123 --squash --delete-branch').blocked).toBe(true);
  });

  it('コマンドの位置（; && || | の直後）に在れば弾く', () => {
    expect(inspectBashCommand('git fetch; gh pr merge 123 --delete-branch').blocked).toBe(true);
    expect(inspectBashCommand('git fetch && gh pr merge 123 --delete-branch').blocked).toBe(true);
    expect(inspectBashCommand('false || gh pr merge 123 --delete-branch').blocked).toBe(true);
    expect(inspectBashCommand('echo hi | gh pr merge 123 --delete-branch').blocked).toBe(true);
  });

  it('複数行スクリプトの2行目に在っても弾く（改行もコマンド位置）', () => {
    expect(inspectBashCommand('git fetch\ngh pr merge 123 --delete-branch').blocked).toBe(true);
  });

  // ⭐ これが「無限待ち」の3形と違ってこの形だけ持つ歯である —— timeout は
  // 待ちを有界にするだけで、PR を巻き添えで閉じる危険は消えない
  // （`isTimeoutWrapped` の早期 return より先に見ている。doc「timeout N
  // ... に包まれていても見る」）。
  it('timeout でラップされていても弾く（待ちの有界性とは無関係の危険）', () => {
    expect(inspectBashCommand('timeout 30 gh pr merge 123 --delete-branch').blocked).toBe(true);
  });

  it('拒否の理由に具体的な逃げ道が入っている（Issue 本文が指定した文言）', () => {
    const verdict = inspectBashCommand('gh pr merge 123 --delete-branch');
    if (!verdict.blocked) throw new Error('unreachable');
    expect(verdict.reason).toContain('外して打つ');
    expect(verdict.reason).toContain('delete_branch_on_merge');
  });

  it('actor と 形=gh-pr-merge-delete-branch は runner-pre-tool-use.test.ts の配線の歯が持つ（ここでは判定器の戻り値だけを見る）', () => {
    const verdict = inspectBashCommand('gh pr merge 123 --delete-branch');
    expect(verdict).toMatchObject({ blocked: true, form: 'gh-pr-merge-delete-branch' });
  });
});
