import { describe, expect, it } from 'vitest';

import { inspectBashCommand } from './bash-wait-guard.js';

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
  // ⭐ AGENTS.md「CI の完了を待つ形」が逐語で記録した実物2本。**どちらも
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
