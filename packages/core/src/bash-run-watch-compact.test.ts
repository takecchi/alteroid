import { describe, expect, it } from 'vitest';

import { RUN_WATCH_COMPACT_NOTE, planRunWatchCompact } from './bash-run-watch-compact.js';

function rewritten(command: string, extra: Record<string, unknown> = {}): string | undefined {
  return planRunWatchCompact({ command, ...extra })?.command;
}

describe('gh run watch に --compact を足す（#5322）', () => {
  it('正規の待ちの形（timeout + --exit-status）に、timeout と上限を変えずに足す', () => {
    expect(rewritten('timeout 540 gh run watch 123 --exit-status')).toBe(
      'timeout 540 gh run watch --compact 123 --exit-status',
    );
  });

  it('timeout のオプション・間隔・-R があっても、watch の直後に足すだけで他の語を動かさない', () => {
    expect(
      rewritten('timeout -k 5 540 gh run watch 9 --exit-status --interval 30 -R takecchi/alteroid'),
    ).toBe(
      'timeout -k 5 540 gh run watch --compact 9 --exit-status --interval 30 -R takecchi/alteroid',
    );
  });

  it('timeout の無い素の呼び出しにも足す', () => {
    expect(rewritten('gh run watch 7')).toBe('gh run watch --compact 7');
  });

  it('既に --compact があれば何もしない', () => {
    expect(rewritten('timeout 540 gh run watch 123 --compact --exit-status')).toBeUndefined();
    expect(rewritten('timeout 540 gh run watch --compact 123')).toBeUndefined();
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

  it('案内に絞ったことと全文の取り方が1行で入る', () => {
    expect(RUN_WATCH_COMPACT_NOTE).toContain('--compact');
    expect(RUN_WATCH_COMPACT_NOTE).toContain('gh run view <id>');
    expect(RUN_WATCH_COMPACT_NOTE).toContain('--log-failed');
    expect(RUN_WATCH_COMPACT_NOTE).not.toContain('\n');
  });
});
