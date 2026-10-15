import { describe, expect, it } from 'vitest';

import { inspectBashCommand } from './bash-wait-guard.js';

describe('sudo・env・nice・nohup などの前置きの付いた timeout も上限と数える（#4914）', () => {
  const passing: ReadonlyArray<[string, string]> = [
    ['sudo timeout', "sudo timeout 600 bash -c 'until X; do sleep 5; done'"],
    ['env timeout', 'env timeout 60 sh -c "while ! X; do sleep 2; done"'],
    ['nice -n5 timeout', "nice -n5 timeout 300 bash -c 'until X; do sleep 5; done'"],
    ['nohup timeout', "nohup timeout 300 bash -c 'until X; do sleep 5; done'"],
    ['env 代入 + timeout', "env FOO=1 timeout 300 bash -c 'until X; do sleep 5; done'"],
    ['&& の後ろの sudo timeout', "cd /tmp && sudo timeout 300 bash -c 'until X; do sleep 5; done'"],
  ];
  for (const [label, command] of passing) {
    it(`${label}: 通す`, () => {
      expect(inspectBashCommand(command).blocked).toBe(false);
    });
  }

  const blocked: ReadonlyArray<[string, string]> = [
    ['sudo が timeout を包まない', 'sudo true; until X; do sleep 5; done'],
    ['env 代入が timeout を包まない', 'env FOO=1 true && until X; do sleep 5; done'],
    ['sudo timeout が別の文', 'sudo timeout 5 true; until X; do sleep 5; done'],
    ['nice の後ろに timeout が無い', 'nice -n5 true; while true; do sleep 1; done'],
    ['timeout という語だけ', 'sudo echo timeout; until X; do sleep 5; done'],
  ];
  for (const [label, command] of blocked) {
    it(`${label}: 止める`, () => {
      expect(inspectBashCommand(command).blocked).toBe(true);
    });
  }
});
