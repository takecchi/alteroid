import { describe, expect, it } from 'vitest';

import { inspectBashCommand } from './bash-wait-guard.js';

describe('#5198 —— 引数を実行しないコマンドの引用符の中のループと gh run watch & を、待ちの形と読まない', () => {
  const falsePositives: ReadonlyArray<[string, string]> = [
    [
      'gh issue comment の本文の while',
      'gh issue comment 1 --body "while true; do sleep 1; done の形"',
    ],
    [
      'gh issue comment の本文の until',
      'gh issue comment 1 --body "until x; do sleep 5; done を断る"',
    ],
    [
      'gh issue comment の本文の for ((;;))',
      'gh issue comment 1 --body "for ((;;)); do sleep 1; done"',
    ],
    ['単一引用符の本文の while', "gh issue comment 1 --body 'while true; do sleep 1; done'"],
    [
      'gh pr create の本文の gh run watch &',
      'gh pr create --title t --body "gh run watch 123 & の形"',
    ],
    ['git commit -m の while', 'git commit -m "docs: while :; do sleep 1; done を断る"'],
    ['echo の while', 'echo "while :; do sleep 1; done"'],
    ['grep のパターンの until', 'grep -n "until x; do sleep 5; done" /tmp/x.md'],
  ];

  for (const [label, command] of falsePositives) {
    it(`${label}: 通す`, () => {
      expect(inspectBashCommand(command)).toEqual({ blocked: false });
    });
  }

  it('Bash の run_in_background で起こした gh pr create の本文の gh run watch も通す', () => {
    expect(
      inspectBashCommand('gh pr create --title t --body "gh run watch 123 --exit-status"', {
        backgrounded: true,
      }),
    ).toEqual({ blocked: false });
  });
});

describe('#5198 —— 中身を実行する形・引用符の外の待ちは今どおり断る', () => {
  const knownForms: ReadonlyArray<[string, string, string]> = [
    ['bash -c の中の while', "bash -c 'while true; do sleep 1; done'", 'while-sleep'],
    ['sh -c の中の until', 'sh -c "until test -f x; do sleep 5; done"', 'until-sleep'],
    ['eval の中の for ((;;))', 'eval "for ((;;)); do sleep 1; done"', 'for-sleep'],
    ['ssh の中の while', 'ssh h "while true; do sleep 1; done"', 'while-sleep'],
    [
      '本文の後ろに引用符の外の while',
      'gh issue comment 1 --body "x"; while true; do sleep 1; done',
      'while-sleep',
    ],
    ['echo の出力を bash へ渡す', 'echo "while true; do sleep 1; done" | bash', 'while-sleep'],
    ['引用符の外の gh run watch &', 'gh run watch 123 --exit-status &', 'gh-run-watch-background'],
  ];

  for (const [label, command, form] of knownForms) {
    it(`${label}: 断る（form: ${form}）`, () => {
      const verdict = inspectBashCommand(command);
      expect(verdict.blocked).toBe(true);
      if (!verdict.blocked) throw new Error('unreachable');
      expect(verdict.form).toBe(form);
    });
  }
});
