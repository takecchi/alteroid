import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { makeTempDir } from '../vitest.tmpdir.js';

import { gitChildEnv } from './git-child-env.js';
import {
  compareVerifiedHead,
  formatVerdict,
  // @ts-expect-error -- 素の .mjs（型宣言を持たない build 用スクリプト）を読む
} from './check-verified-head-core.mjs';
import {
  recordFor,
  writeTreeFor,
  // @ts-expect-error -- 同上
} from './verify-core.mjs';

describe('pnpm check:verified-head（Issue #1763）', () => {
  async function makeRepo(): Promise<string> {
    const dir = await makeTempDir('check-verified-head-');
    const git = (...args: string[]) =>
      execFileSync('git', args, { cwd: dir, encoding: 'utf8', env: gitChildEnv() });
    git('init', '-q');
    git('config', 'user.email', 'test@example.invalid');
    git('config', 'user.name', 'test');
    await writeFile(join(dir, 'a.txt'), 'one\n');
    git('add', '-A');
    git('commit', '-qm', 'init');
    return dir;
  }

  const recordPath = (dir: string) => join(dir, '.git', 'alteroid-verify.json');

  function recordVerifySuccess(dir: string, now = new Date('2026-09-27T00:00:00.000Z')): string {
    const tree = writeTreeFor(dir) as string;
    expect(tree).not.toBeNull();
    writeFileSync(
      recordPath(dir),
      JSON.stringify(recordFor('fp-unused', now, tree), null, 2) + '\n',
    );
    return tree;
  }

  it('歯1: verify が通った直後に commit した HEAD は「一致」になる（exit 0 相当）', async () => {
    const dir = await makeRepo();
    recordVerifySuccess(dir);

    const result = compareVerifiedHead({ repo: dir, rev: 'HEAD', recordPath: recordPath(dir) });
    expect(result.verdict).toBe('match');

    const text = formatVerdict('HEAD', result);
    expect(text).toContain('一致');
    expect(text).toContain('ツリーそのものである');
  });

  it('歯2: 通った後に1行変えて commit した HEAD は「不一致」になり、そのファイル名が出る', async () => {
    const dir = await makeRepo();
    recordVerifySuccess(dir);

    await writeFile(join(dir, 'a.txt'), 'one\ntwo\n');
    execFileSync('git', ['add', '-A'], { cwd: dir, env: gitChildEnv() });
    execFileSync('git', ['commit', '-qm', 'after-verify edit'], { cwd: dir, env: gitChildEnv() });

    const result = compareVerifiedHead({ repo: dir, rev: 'HEAD', recordPath: recordPath(dir) });
    expect(result.verdict).toBe('mismatch');

    const text = formatVerdict('HEAD', result);
    expect(text).toContain('不一致');
    expect(text).toContain('a.txt');
  });

  it('歯3: 通ったときに未追跡のファイルが在り、それを commit しなかった HEAD は「不一致」になる', async () => {
    const dir = await makeRepo();
    await writeFile(join(dir, 'untracked.txt'), 'forgot to commit me\n');
    recordVerifySuccess(dir);

    const result = compareVerifiedHead({ repo: dir, rev: 'HEAD', recordPath: recordPath(dir) });
    expect(result.verdict).toBe('mismatch');

    const text = formatVerdict('HEAD', result);
    expect(text).toContain('不一致');
    expect(text).toContain('untracked.txt');
  });

  describe('歯4: 判定できない（「一致」へは倒さない）', () => {
    it('記録が無い（pnpm verify を一度も通していない）', async () => {
      const dir = await makeRepo();
      const result = compareVerifiedHead({ repo: dir, rev: 'HEAD', recordPath: recordPath(dir) });
      expect(result.verdict).toBe('undecidable');
      expect(result.reason).toBe('no-record');
      expect(formatVerdict('HEAD', result)).toContain('判定できない');
    });

    it('古い形式の記録（tree を持たない。指紋だけの旧レコード）', async () => {
      const dir = await makeRepo();
      writeFileSync(
        recordPath(dir),
        JSON.stringify({ fingerprint: 'abc', at: '2026-09-01T00:00:00.000Z', day: '2026-09-01' }),
      );

      const result = compareVerifiedHead({ repo: dir, rev: 'HEAD', recordPath: recordPath(dir) });
      expect(result.verdict).toBe('undecidable');
      expect(result.reason).toBe('no-tree-in-record');
      expect(formatVerdict('HEAD', result)).toContain('判定できない');
    });

    it('記録が壊れている（JSON として読めない）', async () => {
      const dir = await makeRepo();
      writeFileSync(recordPath(dir), 'not json{{{');

      const result = compareVerifiedHead({ repo: dir, rev: 'HEAD', recordPath: recordPath(dir) });
      expect(result.verdict).toBe('undecidable');
      expect(result.reason).toBe('broken-record');
    });

    it('<rev> が tree として解決できない', async () => {
      const dir = await makeRepo();
      recordVerifySuccess(dir);

      const result = compareVerifiedHead({
        repo: dir,
        rev: 'does-not-exist-branch',
        recordPath: recordPath(dir),
      });
      expect(result.verdict).toBe('undecidable');
      expect(result.reason).toBe('unresolvable-rev');
    });

    it('記録の置き場そのものが取れない（recordPath が null）', () => {
      const result = compareVerifiedHead({
        repo: '/does/not/matter',
        rev: 'HEAD',
        recordPath: null,
      });
      expect(result.verdict).toBe('undecidable');
      expect(result.reason).toBe('no-record-path');
    });

    it('「判定できない」を「一致」として数えない —— 2値化の回帰防止', async () => {
      const dir = await makeRepo();
      const noRecord = compareVerifiedHead({ repo: dir, rev: 'HEAD', recordPath: recordPath(dir) });
      expect(noRecord.verdict).not.toBe('match');
      expect(['match', 'mismatch', 'undecidable']).toContain(noRecord.verdict);
    });
  });

  it('commit を跨いでも tree が同じなら一致する（tree は HEAD の sha ではない、が看板）', async () => {
    const dir = await makeRepo();
    recordVerifySuccess(dir);

    execFileSync('git', ['commit', '--allow-empty', '-qm', 'empty commit, same tree'], {
      cwd: dir,
      env: gitChildEnv(),
    });

    const result = compareVerifiedHead({ repo: dir, rev: 'HEAD', recordPath: recordPath(dir) });
    expect(result.verdict).toBe('match');
  });
});
