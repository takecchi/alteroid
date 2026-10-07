import { spawnSync } from 'node:child_process';

import { describe, expect, it } from 'vitest';

import { mutateCliChildEnv } from './mutate-cli-child-env.js';

describe('mutateCliChildEnv', () => {
  it('偽の機微変数は子に渡らない。PATH だけは効いて node を起動できる', () => {
    const before = process.env.FAKE_SECRET_FOR_TEST;
    process.env.FAKE_SECRET_FOR_TEST = 'not-a-real-value';
    try {
      const result = spawnSync(
        'node',
        ['-e', 'process.stdout.write(JSON.stringify(process.env.FAKE_SECRET_FOR_TEST ?? null))'],
        { encoding: 'utf8', env: mutateCliChildEnv() },
      );
      expect(result.status).toBe(0);
      expect(result.stdout).toBe('null');
    } finally {
      if (before === undefined) delete process.env.FAKE_SECRET_FOR_TEST;
      else process.env.FAKE_SECRET_FOR_TEST = before;
    }
  });
});
