import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname } from 'node:path';

import { describe, expect, it } from 'vitest';

import { enterPrivateTmpdir, PRIVATE_TMPDIR_PREFIX } from './vitest.private-tmpdir.js';
import { makeTempDirSync } from './vitest.tmpdir.js';

describe('テストの実行ごとの専用の tmpdir（#5136）', () => {
  it('⭐ テストの中の os.tmpdir() は、global setup が作った専用の dir を指す（器の本物の /tmp/alteroid-* へ書かない）', () => {
    expect(basename(tmpdir()).startsWith(PRIVATE_TMPDIR_PREFIX)).toBe(true);
    expect(process.env.TMPDIR).toBe(tmpdir());
    expect(existsSync(tmpdir())).toBe(true);
  });

  describe('enterPrivateTmpdir', () => {
    it('基点の直下に作って TMPDIR を向け、leave で元の値へ戻して dir を消す', () => {
      const base = makeTempDirSync('private-tmpdir-base-');
      const env: NodeJS.ProcessEnv = { TMPDIR: '/original' };
      const entered = enterPrivateTmpdir(env, base);
      expect(dirname(entered.dir)).toBe(base);
      expect(basename(entered.dir).startsWith(PRIVATE_TMPDIR_PREFIX)).toBe(true);
      expect(env.TMPDIR).toBe(entered.dir);
      expect(existsSync(entered.dir)).toBe(true);

      entered.leave();
      expect(env.TMPDIR).toBe('/original');
      expect(existsSync(entered.dir)).toBe(false);
    });

    it('もともと TMPDIR が無ければ、leave で欄ごと消す（空文字を残さない）', () => {
      const base = makeTempDirSync('private-tmpdir-base-');
      const env: NodeJS.ProcessEnv = {};
      const entered = enterPrivateTmpdir(env, base);
      entered.leave();
      expect('TMPDIR' in env).toBe(false);
    });
  });
});
