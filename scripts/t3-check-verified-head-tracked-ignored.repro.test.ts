import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { makeTempDir } from '../vitest.tmpdir.js';

import {
  compareVerifiedHead,
  // @ts-expect-error -- 素の .mjs
} from './check-verified-head-core.mjs';
import {
  fingerprint,
  recordFor,
  writeTreeFor,
  // @ts-expect-error -- 同上
} from './verify-core.mjs';

/**
 * 横断レビュー（PR #1774）の再現テスト。
 *
 * `verify-core.mjs` の `writeTreeFor` の doc は「`fingerprint` と見る範囲を
 * 揃えてある」と主張する（`fingerprint` は `git ls-files -co --exclude-standard`
 * が挙げる集合を畳み、`writeTreeFor` の `git add -A` も同じ規則でその集合を
 * ステージする、という主張）。
 *
 * **この主張は「追跡されているが .gitignore にも一致するファイル」では
 * 成り立たない。** `git ls-files -c`（cached）は追跡済みなら ignore 規則に
 * 関わらず常に一覧へ出す。一方 `writeTreeFor` は毎回まっさらな一時 index
 * （`GIT_INDEX_FILE` が指す新規ファイル）に対して `git add -A` するため、
 * その一時 index の視点では「追跡されていないファイル」に見え、
 * `--exclude-standard` 相当の ignore 規則が適用されて丸ごと拾われない。
 *
 * 結果:
 * - `fingerprint()` はそのファイルの実体を畳む（範囲に含む）
 * - `writeTreeFor()` が作る tree にはそのファイルが一切現れない（範囲から漏れる）
 *
 * この漏れは、`pnpm check:verified-head` の「一致」判定を壊す —— 追跡+ignore
 * のファイルを1つでも持つリポジトリでは、**verify した直後に何も変えずに
 * commit した HEAD ですら「不一致」になる**（歯1の前提が崩れる）。
 *
 * いまの alteroid 本体には追跡+ignore のファイルが無い
 * （`git ls-files -ci --exclude-standard` が0件、2026-09-27 実測）ため症状は
 * 眠っているが、**`writeTreeFor` の doc が主張する「範囲が揃っている」は
 * 事実として偽である**——1つでもそういうファイルが増えた瞬間に発火する
 * （force-add されたファイル・後から .gitignore に足されたパターンが
 * 既存の追跡ファイルに掛かる、等はこの repo で起きていない保証が無い）。
 */
describe('PR #1774 再現: 追跡+ignore のファイルで fingerprint と writeTreeFor の範囲がずれる', () => {
  async function makeRepoWithTrackedIgnoredFile(): Promise<string> {
    const dir = await makeTempDir('t3-check-verified-head-repro-');
    const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
    git('init', '-q');
    git('config', 'user.email', 'test@example.invalid');
    git('config', 'user.name', 'test');
    // 先に追跡する（.gitignore が無い時点で追加）。
    await writeFile(join(dir, 'tracked-but-ignored.txt'), 'original content\n');
    git('add', '-A');
    git('commit', '-qm', 'init: track the file before it is ignored');
    // 後から .gitignore にそのファイルを足す（force-add 済みファイルにパターンが
    // 後から掛かる、というよくある事故と同じ形）。
    await writeFile(join(dir, '.gitignore'), 'tracked-but-ignored.txt\n');
    git('add', '-A');
    git('commit', '-qm', 'add .gitignore matching the already-tracked file');
    return dir;
  }

  it('前提確認: git ls-files -c は無視パターンに関わらず追跡ファイルを見せ続ける', async () => {
    const dir = await makeRepoWithTrackedIgnoredFile();
    const out = execFileSync('git', ['ls-files', '-co', '--exclude-standard'], {
      cwd: dir,
      encoding: 'utf8',
    });
    expect(out.split('\n').filter(Boolean)).toContain('tracked-but-ignored.txt');
  });

  it('fingerprint() は追跡+ignore ファイルを範囲に含む', async () => {
    const dir = await makeRepoWithTrackedIgnoredFile();
    const fpWith = fingerprint(dir) as string;

    // ファイルの中身を変えると fingerprint が動くはずである
    // （範囲に含まれているなら、という前提の検証）。
    await writeFile(join(dir, 'tracked-but-ignored.txt'), 'DIFFERENT content\n');
    const fpAfterEdit = fingerprint(dir) as string;

    expect(fpAfterEdit).not.toBe(fpWith);
  });

  it('🔴 writeTreeFor() が作る tree には追跡+ignore ファイルが1つも現れない', async () => {
    const dir = await makeRepoWithTrackedIgnoredFile();
    const tree = writeTreeFor(dir) as string;
    expect(tree).not.toBeNull();

    const lsTree = execFileSync('git', ['ls-tree', '-r', '--name-only', tree], {
      cwd: dir,
      encoding: 'utf8',
    });
    const paths = lsTree.split('\n').filter(Boolean);

    // **本来なら含まれているべき**（fingerprint は含めている。doc は
    // 「範囲を揃えてある」と主張している）。実際には漏れる。
    expect(paths).toContain('tracked-but-ignored.txt');
  });

  it('🔴 帰結: verify直後に何も変えずcommitしたHEADが「不一致」になる（歯1の前提が崩れる）', async () => {
    const dir = await makeRepoWithTrackedIgnoredFile();
    const recordPath = join(dir, '.git', 'alteroid-verify.json');

    // `verify.mjs` の末尾がやっているのと同じ手順:
    // 「verify が通った瞬間の作業ツリー」を tree として記録する。
    const fp = fingerprint(dir) as string;
    const tree = writeTreeFor(dir) as string;
    writeFileSync(
      recordPath,
      JSON.stringify(recordFor(fp, new Date('2026-09-27T00:00:00.000Z'), tree), null, 2) + '\n',
    );

    // **間に何も変えていない** —— 歯1（check-verified-head.test.ts）と同じ前提。
    const result = compareVerifiedHead({ repo: dir, rev: 'HEAD', recordPath });

    // 歯1の主張どおりなら 'match' になるはずである。
    expect(result.verdict).toBe('match');
  });
});
