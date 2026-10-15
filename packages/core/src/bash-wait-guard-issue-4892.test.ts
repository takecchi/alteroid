import { describe, expect, it } from 'vitest';

import { inspectBashCommand } from './bash-wait-guard.js';

describe('上限の付いた待ちは確認に上げない・上限の無い待ちは止める（#4892）', () => {
  const passing: ReadonlyArray<[string, string]> = [
    ['timeout 秒 + bash -c + until', "timeout 300 bash -c 'until X; do sleep 5; done'"],
    ['timeout 分 + sh -c + while !', 'timeout 5m sh -c "while ! X; do sleep 2; done"'],
    ['timeout -k + 秒', "timeout -k 10 300 bash -c 'until X; do sleep 5; done'"],
    [
      'パイプを含む条件（issue の形）',
      "timeout 300 bash -c 'until gh pr checks 5 | grep -q pass; do sleep 5; done'",
    ],
    ['--kill-after 付き', "timeout --kill-after=10 300 bash -c 'until X; do sleep 5; done'"],
    ['後ろに続く && の前の文', "cd /tmp && timeout 300 bash -c 'until X; do sleep 5; done'"],
    ['後ろへ pipe', "timeout 300 bash -c 'until X; do sleep 5; done' 2>&1 | tail -3"],
    ['; の後ろ', "echo go; timeout 300 bash -c 'while ! X; do sleep 5; done'; echo done"],
    ['env 代入つき', "FOO=1 timeout 300 bash -c 'until X; do sleep 5; done'"],
    ['for ;; を timeout で包む', "timeout 60 bash -c 'for ((;;)); do X; sleep 1; done'"],
    ['for seq', 'for i in $(seq 60); do X && break; sleep 5; done'],
    ['for 波括弧の範囲', 'for i in {1..30}; do X; sleep 1; done'],
    ['for C 形式の有限', 'for ((i=0;i<10;i++)); do X; sleep 1; done'],
  ];
  for (const [label, command] of passing) {
    it(`${label}: 通す`, () => {
      expect(inspectBashCommand(command).blocked).toBe(false);
    });
  }

  const blocked: ReadonlyArray<[string, string]> = [
    ['素の until', 'until X; do sleep 5; done'],
    ['while true', 'while true; do X; sleep 5; done'],
    ['timeout がループを包まない（; の前）', 'timeout 5 true; until X; do sleep 5; done'],
    ['echo timeout', 'echo timeout; until X; do sleep 5; done'],
    ['timeout が別の文（&& の前）', 'timeout 5 true && until X; do sleep 5; done'],
    [
      'timeout が bash -c の外のループを包まない',
      "timeout 5 bash -c 'X'; while true; do sleep 1; done",
    ],
    ['引用符の中にだけ timeout', "echo 'timeout 300'; until X; do sleep 5; done"],
    [
      'bash -c の引用符の中に timeout が在るだけ',
      "bash -c 'timeout 5 true; until X; do sleep 5; done'",
    ],
    ['timeout の引数でない文字列', 'echo "timeout 300 bash -c"; while true; do sleep 1; done'],
  ];
  for (const [label, command] of blocked) {
    it(`${label}: 止める`, () => {
      expect(inspectBashCommand(command).blocked).toBe(true);
    });
  }

  it('止めた理由文に、for の回数の例と外側の timeout の例が入っている', () => {
    const verdict = inspectBashCommand('until X; do sleep 5; done');
    expect(verdict.blocked).toBe(true);
    if (!verdict.blocked) return;
    expect(verdict.reason).toContain('for i in $(seq 60); do');
    expect(verdict.reason).toContain("timeout 300 bash -c 'until");
    expect(verdict.reason).toContain('(1)');
    expect(verdict.reason).toContain('(3)');
  });

  it('止めた理由文は、全ての形（tail -f・for-sleep）にも例を載せる', () => {
    for (const command of ['tail -f x.log', 'for ((;;)); do sleep 1; done']) {
      const verdict = inspectBashCommand(command);
      expect(verdict.blocked).toBe(true);
      if (verdict.blocked) expect(verdict.reason).toContain('for i in $(seq 60); do');
    }
  });
});
