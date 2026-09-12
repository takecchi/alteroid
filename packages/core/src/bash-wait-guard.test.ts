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
