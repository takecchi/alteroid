import { describe, expect, it } from 'vitest';

import { autoModeStripsDelegatedRule } from './auto-mode-strip-prediction.js';

// SDK 0.3.312 の stripDangerousPermissionsForAutoMode（EVr→Aer）の Bash の判定の写し（#5435）

describe('autoModeStripsDelegatedRule', () => {
  for (const rule of [
    'Bash(*)',
    'Bash(python:*)',
    'Bash(python3:*)',
    'Bash(node:*)',
    'Bash(npm run:*)',
    'Bash(pnpm run:*)',
    'Bash(bash:*)',
    'Bash(env:*)',
    'Bash(sudo:*)',
    'Bash(python)',
    'Bash(python *)',
    'Bash(python*)',
    'Bash(PYTHON:*)',
    'Bash(python -c*)',
    'Bash(node --eval*)',
  ]) {
    it(`${rule} は当たる`, () => {
      expect(autoModeStripsDelegatedRule(rule)).toBe(true);
    });
  }

  for (const rule of [
    'Bash(gh pr merge:*)',
    'Bash(npm run test:*)',
    'Bash(git:*)',
    'Bash(python script.py)',
    'Bash(pythonista:*)',
    'Bash(python -m pytest.main:*)',
    'Bash(Edit:*)',
    'Edit(python:*)',
    'Bash(make test)',
  ]) {
    it(`${rule} は当たらない`, () => {
      expect(autoModeStripsDelegatedRule(rule)).toBe(false);
    });
  }

  it('`python -m <module>` の除外は python 系の語だけ（node では除外しない）', () => {
    expect(autoModeStripsDelegatedRule('Bash(node -m foo.bar:*)')).toBe(true);
  });
});
