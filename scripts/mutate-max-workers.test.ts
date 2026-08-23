import { describe, expect, it } from 'vitest';

// @ts-expect-error -- 素の .mjs（型宣言を持たない変異試験ハーネス）を読む
import { buildTestSpawnArgs, DEFAULT_MAX_WORKERS } from '../.claude/skills/mutation-testing/mutate-core.mjs';

/**
 * #331: 変異ハーネスの `runTests` が `pnpm test` へ渡す args 配列を組み立てる
 * `buildTestSpawnArgs`（`mutate-core.mjs`）の歯。
 *
 * **いちばん大事な保証はここ**: `baseline` / `run --plan` から並列度を外から
 * 渡せるようにする依頼だったが、既定を変える話ではない。呼び出し側が何も
 * 渡さなければ、これまでどおり `--maxWorkers=4` で走ることを固定する。
 * 既定を消すと、渡し忘れた回だけ vitest の既定（`nproc` 相当）へ跳ね上がる
 * （`.claude/skills/mutation-testing/SKILL.md` / Issue #331）。
 */
describe('mutate-core: buildTestSpawnArgs (#331)', () => {
  it('DEFAULT_MAX_WORKERS は 4 である', () => {
    expect(DEFAULT_MAX_WORKERS).toBe(4);
  });

  it('引数を渡さなければ、これまでどおり --maxWorkers=4 になる（既定は変えない）', () => {
    expect(buildTestSpawnArgs()).toEqual(['test', '--maxWorkers=4']);
  });

  it('extraArgs だけ渡しても、maxWorkers は既定の4のままである', () => {
    expect(buildTestSpawnArgs(['apps/cli/src/conversations'])).toEqual([
      'test',
      '--maxWorkers=4',
      'apps/cli/src/conversations',
    ]);
  });

  it('maxWorkers を明示すれば、その値がそのまま使われる', () => {
    expect(buildTestSpawnArgs([], 2)).toEqual(['test', '--maxWorkers=2']);
  });

  it('maxWorkers と extraArgs を両方渡せる（extraArgs は末尾に残る）', () => {
    expect(buildTestSpawnArgs(['apps/cli/src/conversations'], 3)).toEqual([
      'test',
      '--maxWorkers=3',
      'apps/cli/src/conversations',
    ]);
  });
});
