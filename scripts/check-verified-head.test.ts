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

/**
 * `pnpm check:verified-head`（Issue #1763・#1192 の N7）の受け入れ基準の歯。
 *
 * Issue #1763 の受け入れ基準4本をそのまま歯にしてある:
 *
 * 1. verify が通った直後に commit した HEAD で「一致」になる
 * 2. 通った後に1行変えて commit した HEAD で「不一致」になり、そのファイル名が出る
 * 3. 通ったときに未追跡のファイルが在り、それを commit しなかった HEAD で「不一致」になる
 * 4. 記録が無い／古い形式のときに「判定できない」になる
 *
 * **本物の作業ツリー・index は一度も使わない。** すべて `makeTempDir` で作った
 * 使い捨ての git リポジトリの中だけで完結させる（`scripts/verify-core.test.ts`
 * と同じ形）。
 */
describe('pnpm check:verified-head（Issue #1763）', () => {
  /** commit が1つある使い捨ての git リポジトリ。 */
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

  /** `writeTreeFor` で「いまの作業ツリー」の tree を取り、記録として書く。
   * `pnpm verify` の末尾（`verify.mjs`）が成功時にやっているのと同じ手順。 */
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
    // **verify を通した時点のツリー = いまの HEAD のツリー**（間に何も変えていない）。
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

    // **verify を通した後に1行直して commit する**（「緑を見てから1行直して push した」の形）。
    await writeFile(join(dir, 'a.txt'), 'one\ntwo\n');
    execFileSync('git', ['add', '-A'], { cwd: dir, env: gitChildEnv() });
    execFileSync('git', ['commit', '-qm', 'after-verify edit'], { cwd: dir, env: gitChildEnv() });

    const result = compareVerifiedHead({ repo: dir, rev: 'HEAD', recordPath: recordPath(dir) });
    expect(result.verdict).toBe('mismatch');

    const text = formatVerdict('HEAD', result);
    expect(text).toContain('不一致');
    // **どのファイルが変わったかが出力に出ること**（受け入れ基準の要求そのもの）。
    expect(text).toContain('a.txt');
  });

  it('歯3: 通ったときに未追跡のファイルが在り、それを commit しなかった HEAD は「不一致」になる', async () => {
    const dir = await makeRepo();
    // **verify を走らせた時点で未追跡のファイルが存在する**
    // （`writeTreeFor` は `git add -A` で拾うので、この時点の tree には含まれる）。
    await writeFile(join(dir, 'untracked.txt'), 'forgot to commit me\n');
    recordVerifySuccess(dir);

    // **その未追跡ファイルを commit しないまま HEAD を比べる。**
    // 追跡している a.txt だけの commit なので、HEAD の tree には untracked.txt が無い。
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
      // **旧形式**: `fingerprint` / `at` / `day` はあるが `tree` が無い
      // （この PR 以前の `pnpm verify` が書いた記録の形そのもの）。
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
      // 上のケースすべてで verdict が 'match' になっていないことを、まとめて確認する。
      const dir = await makeRepo();
      const noRecord = compareVerifiedHead({ repo: dir, rev: 'HEAD', recordPath: recordPath(dir) });
      expect(noRecord.verdict).not.toBe('match');
      expect(['match', 'mismatch', 'undecidable']).toContain(noRecord.verdict);
    });
  });

  it('commit を跨いでも tree が同じなら一致する（tree は HEAD の sha ではない、が看板）', async () => {
    const dir = await makeRepo();
    recordVerifySuccess(dir);

    // **中身を1文字も変えずに、空コミット相当（同じ tree のまま作者情報だけ変える commit）を作る。**
    // fingerprint は HEAD の sha を畳むので変わるはずだが、tree の比較はここで動かない。
    execFileSync('git', ['commit', '--allow-empty', '-qm', 'empty commit, same tree'], {
      cwd: dir,
      env: gitChildEnv(),
    });

    const result = compareVerifiedHead({ repo: dir, rev: 'HEAD', recordPath: recordPath(dir) });
    expect(result.verdict).toBe('match');
  });
});
