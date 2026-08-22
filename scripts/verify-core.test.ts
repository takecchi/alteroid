import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

// @ts-expect-error -- 素の .mjs（型宣言を持たない build 用スクリプト）を読む
import { decideSkip, fingerprint } from './verify-core.mjs';

/**
 * `pnpm verify` の「無料で返す」判定の歯。
 *
 * **2本を別々に置くのは意図である。**
 *
 * - **歯①（動いたら緑を名乗らない）だけ**だと、「常に走る」実装が緑になる。
 *   それは安全だが**通し直しが無料でなくなる** ＝ 直そうとしている当の問題
 *   （打ち直しを思い出せない）が残る
 * - **歯②（動いていなければ緑を名乗る）だけ**だと、「常に無料で返す」実装が緑になる。
 *   それは**検証を一度も走らせない**
 *
 * **片方だけでは受け取れない、というのが依頼者の条件だった。**
 */
describe('pnpm verify — 通し直しを無料にする判定', () => {
  const made: string[] = [];

  afterEach(async () => {
    for (const dir of made.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  /** commit が1つある使い捨ての git リポジトリ。 */
  async function makeRepo(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'verify-core-'));
    made.push(dir);
    const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
    git('init', '-q');
    git('config', 'user.email', 'test@example.invalid');
    git('config', 'user.name', 'test');
    await writeFile(join(dir, 'a.txt'), 'one\n');
    git('add', '-A');
    git('commit', '-qm', 'init');
    return dir;
  }

  const record = (dir: string) => join(dir, '.git', 'alteroid-verify.json');
  const save = (dir: string, fp: string) =>
    writeFileSync(record(dir), JSON.stringify({ fingerprint: fp, at: '2026-08-22T00:00:00.000Z' }));

  it('歯②: ツリーが動いていなければ、無料で返す（緑を名乗る）', async () => {
    const dir = await makeRepo();
    const fp = fingerprint(dir) as string;
    expect(fp).not.toBeNull();
    save(dir, fp);

    const decided = decideSkip({ repo: dir, recordPath: record(dir) });
    expect(decided.skip).toBe(true);
    expect(decided.reason).toBe('unchanged');
    // 領収書に載せる時刻が読めていること（**畳んだと記録に残す**ため）。
    expect(decided.at).toBe('2026-08-22T00:00:00.000Z');
  });

  it('歯①: ツリーが動いたら、緑を名乗らない', async () => {
    const dir = await makeRepo();
    save(dir, fingerprint(dir) as string);

    // **追跡ファイルを1文字動かす。**
    await writeFile(join(dir, 'a.txt'), 'two\n');
    expect(decideSkip({ repo: dir, recordPath: record(dir) })).toMatchObject({
      skip: false,
      reason: 'changed',
    });
  });

  it('未追跡のファイルが増えただけでも、緑を名乗らない', async () => {
    const dir = await makeRepo();
    save(dir, fingerprint(dir) as string);

    // **追跡だけを見ていると、新しく足したファイルが指紋から漏れる。**
    // それは「一式を通した後に新しいファイルを足した」を素通りさせる。
    await writeFile(join(dir, 'b.txt'), 'new\n');
    expect(decideSkip({ repo: dir, recordPath: record(dir) })).toMatchObject({ skip: false });
  });

  it('ignore されているものは指紋に入らない（node_modules で毎回走らない）', async () => {
    const dir = await makeRepo();
    await writeFile(join(dir, '.gitignore'), 'ignored/\n');
    execFileSync('git', ['add', '-A'], { cwd: dir });
    execFileSync('git', ['commit', '-qm', 'ignore'], { cwd: dir });
    save(dir, fingerprint(dir) as string);

    await mkdir(join(dir, 'ignored'), { recursive: true });
    await writeFile(join(dir, 'ignored', 'x'), 'noise\n');
    expect(decideSkip({ repo: dir, recordPath: record(dir) })).toMatchObject({ skip: true });
  });

  it('記録が無い・壊れている・--force のときは、必ず走る側へ倒す', async () => {
    const dir = await makeRepo();

    // 記録が無い
    expect(decideSkip({ repo: dir, recordPath: record(dir) })).toMatchObject({
      skip: false,
      reason: 'no-record',
    });

    // 記録が壊れている（**読めない記録を信じない**）
    writeFileSync(record(dir), '{ this is not json');
    expect(decideSkip({ repo: dir, recordPath: record(dir) })).toMatchObject({
      skip: false,
      reason: 'broken-record',
    });

    // --force（一致していても走る）
    save(dir, fingerprint(dir) as string);
    expect(decideSkip({ repo: dir, recordPath: record(dir), force: true })).toMatchObject({
      skip: false,
      reason: 'force',
    });
  });

  it('git リポジトリでなければ指紋を取れず、走る側へ倒す', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'verify-core-bare-'));
    made.push(dir);
    expect(fingerprint(dir)).toBeNull();
    expect(decideSkip({ repo: dir, recordPath: join(dir, 'nope.json') })).toMatchObject({
      skip: false,
      reason: 'no-fingerprint',
    });
  });
});
