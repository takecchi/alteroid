import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { makeTempDir } from '../vitest.tmpdir.js';

// ⚠ **1行に畳んである。** `@ts-expect-error` は次の1行にしか効かないので、
// 多行 import にすると `from` の行（実際に TS7016 が出る場所）へ届かない。
// prettier-ignore
// @ts-expect-error -- 素の .mjs（型宣言を持たない build 用スクリプト）を読む
import { BANNED_PHRASES, CHECKER_CORE_PATH, GENERATOR_PATH, findStaleTokenAdviceHits, isExempt, listScannableSources } from './check-stale-token-restart-advice-core.mjs';

import {
  listGitScannableFiles,
  // @ts-expect-error -- 素の .mjs
} from './git-scannable-files-core.mjs';

type Hit = { path: string; id: string; text: string; why: string; line: number };
type Phrase = { id: string; text: string; why: string };

/**
 * **門が空振りしないことを、毎回当て直す**（Issue #1175）。
 *
 * ⚠ 作った日に手で1回「赤くなった」を見ただけでは、**明日それが空振りへ戻っても
 * 誰も気づかない**。⟹ 陰性対照そのものをテストにして残す（#1220 で同じ形を採った）。
 *
 * ここで測るのは4つ:
 *
 * 1. 生成元の外に字面が在れば**赤くなる**（空振りしない）
 * 2. 生成元のファイル自身は**免除される**（定数の本体と、経緯を説明する doc の引用）
 * 3. `*.test.ts` は**免除される**（順序の歯は助言の字面を引いて当てる側である）
 * 4. ⭐ `lost` 向けの別の助言を**誤って捕まえない**（偽陽性の歯）
 */
describe('check-stale-token-restart-advice', () => {
  const advice = (BANNED_PHRASES as Phrase[]).find((p) => p.id === 'advice');
  const understatement = (BANNED_PHRASES as Phrase[]).find((p) => p.id === 'understatement');

  it('2つの字面（助言そのもの・過小な言い方）を見ている', () => {
    expect(advice?.text).toBe('manager_stop → manager_start で起こし直すこと');
    expect(understatement?.text).toBe('会話は失われる');
  });

  it('生成元の外に助言の字面が在れば捕まえる（＝空振りしない）', () => {
    const hits = findStaleTokenAdviceHits([
      {
        path: 'packages/core/src/tools.ts',
        content: `const x = '429 が続くなら ${advice?.text}（新しい鍵で走る）。';`,
      },
    ]) as Hit[];

    expect(hits).toHaveLength(1);
    expect(hits[0]?.id).toBe('advice');
    expect(hits[0]?.line).toBe(1);
  });

  it('過小な言い方（#914 が名指しした「会話は失われる」）の復活も捕まえる', () => {
    const hits = findStaleTokenAdviceHits([
      {
        path: 'packages/core/src/manager.ts',
        content: `// 起こし直す（${understatement?.text}）。`,
      },
    ]) as Hit[];

    expect(hits).toHaveLength(1);
    expect(hits[0]?.id).toBe('understatement');
  });

  it('生成元のファイル自身は免除される（定数も、経緯の doc の引用も、そこに在るのが正しい）', () => {
    expect(isExempt(GENERATOR_PATH)).toBe(true);

    const hits = findStaleTokenAdviceHits([
      { path: GENERATOR_PATH, content: `export const A = '${advice?.text}';` },
    ]) as Hit[];

    expect(hits).toEqual([]);
  });

  it('テストは免除される（助言の字面を引いて当てる側であって、配る側ではない）', () => {
    const hits = findStaleTokenAdviceHits([
      {
        path: 'packages/core/src/tools.test.ts',
        content: `expect(reply).toContain('${advice?.text}');`,
      },
    ]) as Hit[];

    expect(hits).toEqual([]);
  });

  /**
   * ⭐ **偽陽性の歯。** `lost` の委譲向けの助言（「まずそこを確かめ、続きが要ると
   * 判断したときだけ manager_start で起こし直すこと」）は**別の助言**であり、
   * 独自の前提を既に持っている。⟹ これを捕まえる形にすると、門は「無関係な行を
   * 赤くする道具」になり、次の人が免除表へ逃がして**本物の割れを見逃す**側へ倒れる。
   *
   * 判定の字面に `manager_stop → ` を含めてあるのは、まさにこれを外すためである。
   */
  /**
   * ⭐ **門が自分自身を指して落ちないこと。** このファイル（検査の core）は
   * **探す字面の定義そのもの**を持つので、必ず両方の字面を含む。免除が無いと、
   * 門は生えた瞬間から赤くなり続ける——**実際にそうなっていた**（PR #1286 の
   * `ci` が、6件すべてこの core を挙げて落ちた）。
   */
  it('⭐ この検査自身の core は免除される（探す字面の定義を持つので、必ず両方を含む）', () => {
    expect(isExempt(CHECKER_CORE_PATH)).toBe(true);

    const hits = findStaleTokenAdviceHits([
      {
        path: CHECKER_CORE_PATH,
        content: `text: '${advice?.text}', why: '${understatement?.text}'`,
      },
    ]) as Hit[];

    expect(hits).toEqual([]);
  });

  /**
   * ⚠ **免除が空振りしていないことを、実物で当て直す。** 上の歯は「その
   * パスなら免除される」しか言わない——**core のファイル名が変われば
   * `CHECKER_CORE_PATH` は実在しないパスを指したまま緑を返し、門はまた
   * 自分自身で赤くなる。** ⟹ 定数が指す先が実在し、実際に両方の字面を
   * 含むことまで見る。
   */
  it('⭐ CHECKER_CORE_PATH は実在し、実際に両方の字面を含む（免除が空振りしていない）', () => {
    const content = readFileSync(new URL(`../${CHECKER_CORE_PATH}`, import.meta.url), 'utf8');

    expect(content).toContain(advice?.text);
    expect(content).toContain(understatement?.text);
  });

  it('lost 向けの別の助言は捕まえない（偽陽性で門を腐らせない）', () => {
    const hits = findStaleTokenAdviceHits([
      {
        path: 'packages/core/src/tools.ts',
        content:
          "const y = 'まずそこを確かめ、続きが要ると判断したときだけ manager_start で起こし直すこと。';",
      },
    ]) as Hit[];

    expect(hits).toEqual([]);
  });
});

describe('check-stale-token-restart-advice: listScannableSources（Issue #1817）', () => {
  async function makeRepoWithUntrackedFiles(): Promise<string> {
    const dir = await makeTempDir('check-stale-token-restart-advice-1817-');
    const git = (...gitArgs: string[]) =>
      execFileSync('git', gitArgs, { cwd: dir, encoding: 'utf8' });
    git('init', '-q');
    git('config', 'user.email', 'test@example.invalid');
    git('config', 'user.name', 'test');
    await writeFile(`${dir}/tracked.ts`, 'export const ok = 1;\n');
    git('add', '-A');
    git('commit', '-qm', 'init');
    // まだ `git add` していない新規ファイル（拡張子フィルタに掛かるものと
    // 掛からないものの両方を置く）。
    await writeFile(`${dir}/new-untracked.ts`, '// new file, not staged yet\n');
    await writeFile(`${dir}/new-untracked.md`, '# not scanned\n');
    return dir;
  }

  it('🔴（直す前の形）: 素の `git ls-files -z` は新規ファイルを見落とす', async () => {
    const dir = await makeRepoWithUntrackedFiles();
    const oldForm = execFileSync('git', ['ls-files', '-z'], { cwd: dir, encoding: 'utf8' })
      .split('\0')
      .filter((p) => p.length > 0);
    expect(oldForm).not.toContain('new-untracked.ts');
  });

  it('🟢（直した後）: listScannableSources は同じ新規ファイルを対象に入れる', async () => {
    const dir = await makeRepoWithUntrackedFiles();
    const files = listScannableSources(dir) as string[];
    expect(files).toContain('new-untracked.ts');
    expect(files).toContain('tracked.ts');
    expect(files).not.toContain('new-untracked.md');
  });
});

/**
 * **`apps/web` の `.tsx` が走査から漏れていた穴**（Issue #1873）。
 *
 * 一時の git リポジトリに `apps/web/app/routes/usage.tsx` を作り、生成元
 * （`packages/core/src/usage-limits.ts`）を通さずに助言の逐語をそのまま
 * 埋め込む。直す前の拡張子フィルタ（`.ts` / `.mjs` / `.js`）だとこのファイルは
 * 対象にすら入らない ⟹ `findStaleTokenAdviceHits` まで届く前に見落とされ、
 * 検査は「異常なし」で緑のまま終わる。
 */
describe('check-stale-token-restart-advice: apps/web の .tsx を走査する（Issue #1873）', () => {
  const advice = (BANNED_PHRASES as Phrase[]).find((p) => p.id === 'advice');

  async function makeRepoWithTsxFile(): Promise<string> {
    const dir = await makeTempDir('check-stale-token-restart-advice-1873-');
    const git = (...gitArgs: string[]) =>
      execFileSync('git', gitArgs, { cwd: dir, encoding: 'utf8' });
    git('init', '-q');
    git('config', 'user.email', 'test@example.invalid');
    git('config', 'user.name', 'test');
    await mkdir(`${dir}/apps/web/app/routes`, { recursive: true });
    // 生成元を通さず、Web の画面コンポーネントに助言の逐語を直書きした形。
    await writeFile(
      `${dir}/apps/web/app/routes/usage.tsx`,
      `export const Notice = () => <p>${advice?.text}（新しい鍵で走る）。</p>;\n`,
    );
    git('add', '-A');
    git('commit', '-qm', 'init');
    return dir;
  }

  it('🔴（直す前の形）: 拡張子フィルタを .ts/.mjs/.js に絞ると apps/web の .tsx を見落とす', async () => {
    const dir = await makeRepoWithTsxFile();
    const oldSuffixes = ['.ts', '.mjs', '.js'];
    const oldForm = (listGitScannableFiles({ cwd: dir }) as string[]).filter((path) =>
      oldSuffixes.some((suffix) => path.endsWith(suffix)),
    );
    expect(oldForm).not.toContain('apps/web/app/routes/usage.tsx');

    // ⟹ 見落とされたファイルは findStaleTokenAdviceHits にすら渡らないので、
    // 生成元を通さない逐語があっても検査は「異常なし」を返す（空振り）。
    const hits = findStaleTokenAdviceHits(
      oldForm.map((path) => ({
        path,
        content: readFileSync(`${dir}/${path}`, 'utf8'),
      })),
    ) as Hit[];
    expect(hits).toEqual([]);
  });

  it('🟢（直した後）: listScannableSources は apps/web の .tsx も対象に入れ、直書きを捕まえる', async () => {
    const dir = await makeRepoWithTsxFile();
    const files = listScannableSources(dir) as string[];
    expect(files).toContain('apps/web/app/routes/usage.tsx');

    const hits = findStaleTokenAdviceHits(
      files.map((path) => ({
        path,
        content: readFileSync(`${dir}/${path}`, 'utf8'),
      })),
    ) as Hit[];
    expect(hits).toHaveLength(1);
    expect(hits[0]?.path).toBe('apps/web/app/routes/usage.tsx');
    expect(hits[0]?.id).toBe('advice');
  });

  it('.test.tsx は免除される（Web のテストが助言の字面を引いて当てる側であるため）', () => {
    expect(isExempt('apps/web/app/routes/usage.test.tsx')).toBe(true);
  });
});
