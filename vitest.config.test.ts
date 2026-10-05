import { describe, expect, it } from 'vitest';

import rootConfig, { MAX_WORKERS_CAP, defaultMaxWorkers } from './vitest.config.js';

/**
 * root の vitest 設定が置く worker 数の上限（#2905）の歯。理由は
 * `vitest.config.ts` の `MAX_WORKERS_CAP` の doc に在る。
 */
describe('vitest の worker 数の上限（#2905）', () => {
  it('CPU の多い器では上限で頭打ちになる（共有の runner は 32）', () => {
    expect(defaultMaxWorkers(32)).toBe(MAX_WORKERS_CAP);
    expect(defaultMaxWorkers(48)).toBe(MAX_WORKERS_CAP);
  });

  it('CI（ubuntu-latest の 4 vCPU）では vitest の既定（CPU 数 - 1）のまま変わらない', () => {
    expect(defaultMaxWorkers(4)).toBe(3);
    expect(defaultMaxWorkers(2)).toBe(1);
  });

  it('CPU が1つでも 0 にならない', () => {
    expect(defaultMaxWorkers(1)).toBe(1);
  });

  it('上限は root の設定に配線されている（各ワークスペースの設定もここを引き継ぐ）', () => {
    expect(rootConfig.test?.maxWorkers).toBe(defaultMaxWorkers());
  });
});
