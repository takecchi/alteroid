import { describe, expect, it } from 'vitest';

import {
  commandBasename,
  OUTWARD_COMMANDS,
  outwardCommandsIn,
  stripCommandPrefixes,
} from './outward-commands.js';

// git-worktree-hints.ts と共有する頭の外し方（#5666）
describe('stripCommandPrefixes / commandBasename', () => {
  it('先頭の NAME=value を外す', () => {
    expect(stripCommandPrefixes(['A=1', 'B_2=x', 'git', 'push'])).toEqual(['git', 'push']);
  });

  it('timeout とそのオプション・秒数を外す（-k / -s は値を取り、--kill-after=5 は1語）', () => {
    expect(stripCommandPrefixes(['timeout', '-k', '5', '-s', 'KILL', '530', 'gh', 'pr'])).toEqual([
      'gh',
      'pr',
    ]);
    expect(
      stripCommandPrefixes(['A=1', '/usr/bin/timeout', '--kill-after=5', '60', 'git']),
    ).toEqual(['git']);
  });

  it('頭が無ければそのまま', () => {
    expect(stripCommandPrefixes(['git', '-C', '/w', 'push'])).toEqual(['git', '-C', '/w', 'push']);
    expect(stripCommandPrefixes([])).toEqual([]);
  });

  it('commandBasename は最後の / より後ろ', () => {
    expect(commandBasename('/usr/bin/git')).toBe('git');
    expect(commandBasename('git')).toBe('git');
  });
});

describe('OUTWARD_COMMANDS: 背景待ちでも待たずに配る「外へ出す」コマンドの一覧', () => {
  it('一覧は固定してある（足す・外すときはこの歯も直す）', () => {
    expect(OUTWARD_COMMANDS.map((words) => words.join(' '))).toEqual([
      'gh pr create',
      'gh pr merge',
      'gh pr close',
      'gh pr comment',
      'gh pr review',
      'gh issue create',
      'gh issue close',
      'gh issue comment',
      'gh release create',
      'git push',
    ]);
  });
});

describe('outwardCommandsIn: コマンド文字列から外へ出すコマンドを見つける', () => {
  it('素の形を見つける', () => {
    expect(outwardCommandsIn('gh pr merge 4612 -R takecchi/alteroid --squash')).toEqual([
      'gh pr merge',
    ]);
    expect(outwardCommandsIn('git push -u origin fix/x')).toEqual(['git push']);
  });

  it('git の値を取る大域オプション・フルパス・timeout・先頭の NAME=value を飛ばして見つける', () => {
    expect(outwardCommandsIn('git -C /tmp/w push origin fix/x')).toEqual(['git push']);
    expect(outwardCommandsIn('/usr/bin/git push')).toEqual(['git push']);
    expect(outwardCommandsIn('timeout -k 5 120 gh pr create --title t --body b')).toEqual([
      'gh pr create',
    ]);
    expect(outwardCommandsIn('GH_PROMPT_DISABLED=1 gh issue comment 12 --body x')).toEqual([
      'gh issue comment',
    ]);
  });

  it('つないだ形は部分ごとに見て、重複なしで出た順に返す', () => {
    expect(
      outwardCommandsIn('git push origin x && gh pr create --fill\ngh pr merge 1 ; git push'),
    ).toEqual(['git push', 'gh pr create', 'gh pr merge']);
  });

  it('読むだけのコマンドや、引数に語が出るだけのものは当てない', () => {
    expect(outwardCommandsIn('gh pr list --state all')).toEqual([]);
    expect(outwardCommandsIn('gh pr view 12 --json state')).toEqual([]);
    expect(outwardCommandsIn('git status')).toEqual([]);
    expect(outwardCommandsIn('git commit -m "push later"')).toEqual([]);
    expect(outwardCommandsIn('grep -rn "gh pr merge" docs')).toEqual([]);
    expect(outwardCommandsIn('')).toEqual([]);
  });
});
