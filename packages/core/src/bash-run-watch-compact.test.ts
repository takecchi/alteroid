import { describe, expect, it } from 'vitest';

import { describeRunWatchRewrite, planRunWatchCompact } from './bash-run-watch-compact.js';

function rewritten(command: string, extra: Record<string, unknown> = {}): string | undefined {
  return planRunWatchCompact({ command, ...extra })?.command;
}

describe('gh run watch に --compact と --interval 30 を足す（#5322・#5327）', () => {
  it('正規の待ちの形（timeout + --exit-status）に、timeout と上限を変えずに両方を足す', () => {
    expect(rewritten('timeout 540 gh run watch 123 --exit-status')).toBe(
      'timeout 540 gh run watch --compact --interval 30 123 --exit-status',
    );
  });

  it('timeout のオプション・-R があっても、watch の直後に足すだけで他の語を動かさない', () => {
    expect(rewritten('timeout -k 5 540 gh run watch 9 --exit-status -R takecchi/alteroid')).toBe(
      'timeout -k 5 540 gh run watch --compact --interval 30 9 --exit-status -R takecchi/alteroid',
    );
  });

  it('timeout の無い素の呼び出しにも足す', () => {
    expect(rewritten('gh run watch 7')).toBe('gh run watch --compact --interval 30 7');
  });

  it('--interval が既にあれば値も含め触らず、--compact だけを足す', () => {
    expect(rewritten('timeout 540 gh run watch 1 --interval 10')).toBe(
      'timeout 540 gh run watch --compact 1 --interval 10',
    );
    expect(rewritten('timeout 540 gh run watch 1 -i 10')).toBe(
      'timeout 540 gh run watch --compact 1 -i 10',
    );
    expect(rewritten('timeout 540 gh run watch 1 --interval=5')).toBe(
      'timeout 540 gh run watch --compact 1 --interval=5',
    );
    expect(rewritten('timeout 540 gh run watch 1 -i10')).toBe(
      'timeout 540 gh run watch --compact 1 -i10',
    );
  });

  it('--compact が既にあれば、--interval 30 だけを足す', () => {
    expect(rewritten('timeout 540 gh run watch 123 --compact --exit-status')).toBe(
      'timeout 540 gh run watch --interval 30 123 --compact --exit-status',
    );
  });

  it('両方が既にあれば何もしない', () => {
    expect(
      rewritten('timeout 540 gh run watch 123 --compact --exit-status --interval 30'),
    ).toBeUndefined();
    expect(rewritten('gh run watch 1 --compact -i 3')).toBeUndefined();
    expect(rewritten('gh run watch 1 --compact --interval=5')).toBeUndefined();
  });

  it('他の gh の呼び出しには触れない', () => {
    expect(rewritten('gh run view 123')).toBeUndefined();
    expect(rewritten('gh run list --limit 3')).toBeUndefined();
    expect(rewritten('gh pr checks 12')).toBeUndefined();
    expect(rewritten('gh run watchdog 1')).toBeUndefined();
  });

  it('引用符・区切り・置換を含む形は書き換えない（別の語を壊さないため）', () => {
    expect(rewritten('git commit -m "gh run watch 1"')).toBeUndefined();
    expect(rewritten('echo "gh run watch 1"')).toBeUndefined();
    expect(rewritten('gh run watch 1 --exit-status && echo ok')).toBeUndefined();
    expect(rewritten('gh run watch $(cat id)')).toBeUndefined();
    expect(rewritten('gh run watch 1\ngh run watch 2')).toBeUndefined();
  });

  it('背景に置く呼び出しは書き換えない', () => {
    expect(
      rewritten('gh run watch 123 --exit-status', { run_in_background: true }),
    ).toBeUndefined();
  });

  it('command が文字列でなければ何もしない', () => {
    expect(planRunWatchCompact({})).toBeUndefined();
    expect(planRunWatchCompact({ command: 5 })).toBeUndefined();
  });

  it('両方を足したときは1つの案内にまとまり、1行で全文の取り方も入る', () => {
    const note = describeRunWatchRewrite({ addedCompact: true, addedInterval: true });
    expect(note).toContain('--compact');
    expect(note).toContain('--interval 30');
    expect(note).toContain('gh run view <id>');
    expect(note).toContain('--log-failed');
    expect(note).not.toContain('\n');
  });

  it('--interval だけを足したときの案内は --compact を名乗らない', () => {
    const note = describeRunWatchRewrite({ addedCompact: false, addedInterval: true });
    expect(note).toContain('--interval 30');
    expect(note).not.toContain('--compact');
  });
});
