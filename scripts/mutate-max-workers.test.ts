import { describe, expect, it } from 'vitest';

// @ts-expect-error -- 素の .mjs（型宣言を持たない変異試験ハーネス）を読む
import {
  buildTestSpawnArgs,
  DEFAULT_MAX_WORKERS,
  readMaxWorkers,
} from '../.claude/skills/mutation-testing/mutate-core.mjs';

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

/**
 * `readMaxWorkers`（`mutate-core.mjs`）の歯。
 *
 * **マネージャーの差し戻し（2026-08-23）が起点**: `--max-workers=2` という
 * `=` の形が静かに無視され、既定の `4` へ落ちていた欠陥の回帰確認。
 * vitest 本体のフラグが `--maxWorkers=4` という `=` の形そのものなので、
 * その形を知っている人ほどこの形で打つ。空白区切りの形（`--max-workers 2`）
 * との両方を受けることを固定する。
 */
describe('mutate-core: readMaxWorkers (#331 差し戻し)', () => {
  it('引数に無ければ undefined を返す（呼び出し側の既定に委ねる）', () => {
    expect(readMaxWorkers([])).toBeUndefined();
    expect(readMaxWorkers(['--plan', 'plan.json'])).toBeUndefined();
  });

  it('空白区切りの形（--max-workers <n>）を読む', () => {
    expect(readMaxWorkers(['--max-workers', '2'])).toBe(2);
  });

  it('= の形（--max-workers=<n>）を読む（差し戻し前は静かに無視されていた）', () => {
    expect(readMaxWorkers(['--max-workers=2'])).toBe(2);
  });

  it('= の形は、他の引数と混ざっていても読める', () => {
    expect(readMaxWorkers(['--plan', 'plan.json', '--max-workers=3'])).toBe(3);
  });

  it('0以下の値は拒否する', () => {
    expect(() => readMaxWorkers(['--max-workers=0'])).toThrow(/1以上の整数/);
    expect(() => readMaxWorkers(['--max-workers', '-1'])).toThrow(/1以上の整数/);
  });

  it('整数でない値は拒否する', () => {
    expect(() => readMaxWorkers(['--max-workers=abc'])).toThrow(/1以上の整数/);
    expect(() => readMaxWorkers(['--max-workers=1.5'])).toThrow(/1以上の整数/);
  });
});
