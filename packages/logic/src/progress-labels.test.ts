import { describeGithubCi } from '@alteroid/core';
import { describe, expect, it } from 'vitest';

import {
  GITHUB_CI_COUNT_LABEL,
  GITHUB_CI_COUNT_ORDER,
  GITHUB_OBSERVED_BY_UNKNOWN,
  githubObservedByLabel,
} from './progress-labels.js';

describe('GITHUB_CI_COUNT_LABEL', () => {
  it('core の describeGithubCi が出す軸をすべて覆い、並びも同じ（歯が測る原本と表のずれを落とす）', () => {
    const original = describeGithubCi({
      ci: { pulls: 3, success: 1, failure: 1, pending: 1, checks: 'x' },
    });
    const axes = [...original.matchAll(/(\w+) 1/g)].map((m) => m[1]);
    expect(axes).toEqual([...GITHUB_CI_COUNT_ORDER]);
    expect(Object.keys(GITHUB_CI_COUNT_LABEL).sort()).toEqual([...axes].sort());
  });

  it('ラベルは空でなく、英語の識別子でも重複でもない', () => {
    const labels = Object.values(GITHUB_CI_COUNT_LABEL);
    expect(new Set(labels).size).toBe(labels.length);
    for (const label of labels) expect(label).toMatch(/[ぁ-んァ-ヶ一-龠]/);
  });
});

describe('githubObservedByLabel', () => {
  it('clone はクローン', () => {
    expect(githubObservedByLabel('clone')).toBe('クローン');
  });
  it('知らない値・組み込みの名前は識別子を出さず一般的な言い方にする', () => {
    for (const raw of ['mgr-1', 'constructor', '__proto__', 'toString']) {
      expect(githubObservedByLabel(raw)).toBe(GITHUB_OBSERVED_BY_UNKNOWN);
    }
  });
});
