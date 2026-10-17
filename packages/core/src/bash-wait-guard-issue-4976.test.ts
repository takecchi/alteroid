import { describe, expect, it } from 'vitest';

import { inspectBashCommand } from './bash-wait-guard.js';

// 上限のある `tail -f`（区間の頭の `timeout <期間>`・`--pid`）は、前に別の命令が付いてもパイプの左でも通す（#4976）。
// 外側の `timeout` を見る判定は命令全体が1つの単純な命令のときしか効かず、HOUSE-15 の `tail --pid=… -f /dev/null` 形が1日に3回止まった（2026-10-17）。

describe('上限のある tail -f は通す（#4976）', () => {
  it.each([
    ['timeout と --pid', 'timeout 595 tail --pid=487026 -f /dev/null'],
    ['--pid だけ（= で渡す）', 'tail --pid=487026 -f /dev/null'],
    ['--pid だけ（空白で渡す）', 'tail -f --pid 487026 x.log'],
    ['前に cd && が付いた timeout', 'cd /tmp && timeout 595 tail --pid=487026 -f /dev/null'],
    ['前に ; が付いた timeout', 'echo start; timeout 60 tail -f x.log'],
    ['パイプの左の timeout', 'timeout 60 tail -f x.log | grep -m1 ready'],
    ['環境変数の後の timeout', 'cd /w && LC_ALL=C timeout 30 tail -F x.log'],
    ['--follow でも', 'cd /w && timeout 30 tail --follow=name x.log'],
  ])('%s: %s', (_label, command) => {
    expect(inspectBashCommand(command)).toEqual({ blocked: false });
  });
});

describe('上限の無い tail -f は今までどおり止める（#4976）', () => {
  it.each([
    ['素の tail -f', 'tail -f x.log'],
    ['パイプの右の timeout は tail を包まない', 'tail -f x.log | timeout 5 grep ready'],
    ['前の命令の timeout は後ろの tail を包まない', 'timeout 5 true; tail -f x.log'],
    ['単体の & の後ろの tail -f', 'timeout 60 make & tail -f x.log'],
    ['上限のある tail と並んだ、上限の無い tail', 'timeout 60 tail -f a.log; tail -f b.log'],
    ['--pid は別の命令の引数', 'kill --pid=1 x; tail -f x.log'],
  ])('%s: %s', (_label, command) => {
    const verdict = inspectBashCommand(command);
    expect(verdict.blocked).toBe(true);
    if (!verdict.blocked) throw new Error('unreachable');
    expect(verdict.form).toBe('tail-f');
    expect(verdict.reason).toContain('`--pid=<待つ相手の pid>`');
  });
});
