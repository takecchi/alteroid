import { describe, expect, it } from 'vitest';

import { inspectBashCommand } from './bash-wait-guard.js';
import { expectNotSuperlinear } from './time-growth.test-support.js';

describe('単体の & と <( は、引用符を潰す区間を分ける・潰さない（#2401）', () => {
  const blocked: ReadonlyArray<[string, string]> = [
    ['対照: bash -c', 'bash -c "tail -f x.log"'],
    ['echo & の後ろの bash -c', 'echo hi & bash -c "tail -f x.log"'],
    ['grep & の後ろの bash -c', 'grep x f & bash -c "tail -f x.log"'],
    ['& を2回', 'echo a & echo b & bash -c "tail -f x.log"'],
    ['echo 2>&1 の後の & の後ろ', 'echo hi 2>&1 & bash -c "tail -f x.log"'],
    ['grep <( の中', 'grep x <(bash -c "tail -f x.log")'],
    ['echo <( の中', 'echo hi <(bash -c "tail -f x.log")'],
    ['cat <( の中（許可リスト外）', 'cat <(bash -c "tail -f x.log")'],
  ];
  for (const [label, command] of blocked) {
    it(`${label}: 弾く`, () => {
      expect(inspectBashCommand(command).blocked).toBe(true);
    });
  }

  const passing: ReadonlyArray<[string, string]> = [
    ['echo の引用符の中の tail -f', 'echo "tail -f x.log"'],
    ['echo 2>&1 の引用符の中', 'echo "tail -f x.log" 2>&1'],
    ['echo &> の引用符の中', 'echo "tail -f x.log" &> out'],
    ['git commit -m の引用符の中（2>&1）', 'git commit -m "tail -f x" 2>&1'],
    ['& の後ろが許可リストの echo', 'sleep 1 & echo "tail -f x.log"'],
    ['引用符の中の & は区切りではない', 'echo "a & tail" -f x'],
    ['grep の検索語（プロセス置換なし）', 'grep "tail -f x" log'],
  ];
  for (const [label, command] of passing) {
    it(`${label}: 通す`, () => {
      expect(inspectBashCommand(command).blocked).toBe(false);
    });
  }
});

describe('& で区切った長い入力で2乗にならない（#2401）', () => {
  it('echo の繰り返しを & で繋ぐ', () => {
    const makeInput = (n: number) => `${'echo "a b" & '.repeat(n)}echo done`;
    expectNotSuperlinear(inspectBashCommand, makeInput, { n: 500 });
  });
  it('<( の繰り返し', () => {
    const makeInput = (n: number) => `grep x ${'<(echo a) '.repeat(n)}`;
    expectNotSuperlinear(inspectBashCommand, makeInput, { n: 500 });
  });
});
