import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { makeTempDir } from '../vitest.tmpdir.js';

import { gitChildEnv } from './git-child-env.js';

// 1行に畳む: `@ts-expect-error` は次の1行にしか効かず、多行 import だと `from` の行（TS7016 が出る場所）へ届かないため。
// prettier-ignore
// @ts-expect-error -- 素の .mjs（型宣言を持たない build 用スクリプト）を読む
import { BANNED_PHRASES, CHECKER_CORE_PATH, GENERATOR_PATH, findAdviceHits, isExempt, listScannableSources } from './check-advice-single-source-core.mjs';

import {
  listGitScannableFiles,
  // @ts-expect-error -- 素の .mjs
} from './git-scannable-files-core.mjs';

type Hit = { path: string; id: string; text: string; why: string; line: number };
type Phrase = { id: string; text: string; why: string };

const phrases = BANNED_PHRASES as Phrase[];
const texts = phrases.map((p) => p.text);

describe('check-advice-single-source', () => {
  it('5つの字面（助言・過小な言い方・旧字面・統一後のバッククォート無し/有り）を見ている', () => {
    expect(phrases.map((p) => [p.id, p.text])).toEqual([
      ['advice', 'manager_stop → manager_start で起こし直すこと'],
      ['understatement', '会話は失われる'],
      ['old', '先に manager_start で起こし直さないこと'],
      ['unified-plain', '確かめる前に manager_start で起こし直さないこと'],
      ['unified-code', '確かめる前に `manager_start` で起こし直さないこと'],
    ]);
  });

  it.each(phrases)('生成元の外に字面「$id」が在れば捕まえる（＝空振りしない）', ({ id, text }) => {
    const hits = findAdviceHits([
      {
        path: 'packages/core/src/tools.ts',
        content: `const x = '${text} — 同じ仕事が2本になる。';`,
      },
    ]) as Hit[];

    expect(hits).toHaveLength(1);
    expect(hits[0]?.id).toBe(id);
    expect(hits[0]?.line).toBe(1);
  });

  it('生成元・この検査自身の core は免除される（定数も、経緯の doc の引用も、探す字面の定義も、そこに在るのが正しい）', () => {
    const content = texts.map((t, i) => `export const A${i} = '${t}';`).join('\n');
    for (const path of [GENERATOR_PATH, CHECKER_CORE_PATH]) {
      expect(isExempt(path)).toBe(true);
      expect(findAdviceHits([{ path, content }])).toEqual([]);
    }
  });

  it('⭐ CHECKER_CORE_PATH は実在し、実際に全部の字面を含む（免除が空振りしていない）', () => {
    const content = readFileSync(new URL(`../${CHECKER_CORE_PATH}`, import.meta.url), 'utf8');

    for (const text of texts) expect(content).toContain(text);
  });

  it('テストは免除される（助言の字面を引いて当てる側であって、配る側ではない）', () => {
    const hits = findAdviceHits([
      {
        path: 'packages/core/src/tools.test.ts',
        content: texts.map((t) => `expect(reply).toContain('${t}');`).join('\n'),
      },
    ]) as Hit[];

    expect(hits).toEqual([]);
    expect(isExempt('apps/web/app/routes/usage.test.tsx')).toBe(true);
  });

  it('lost 向けの別の助言・manager.ts の言い換えの族（貸し出しの関門）は捕まえない（偽陽性で門を腐らせない）', () => {
    const hits = findAdviceHits([
      {
        path: 'packages/core/src/tools.ts',
        content:
          "const y = 'まずそこを確かめ、続きが要ると判断したときだけ manager_start で起こし直すこと。';",
      },
      {
        path: 'packages/core/src/manager.ts',
        content:
          "const y = '**新しく起こし直さないこと** — 起こし直すと同じ仕事が2本になりえます。';\n" +
          "const z = '起こし直すと続きは失われるので、ここで起こし直さないこと。';",
      },
    ]) as Hit[];

    expect(hits).toEqual([]);
  });
});

describe('check-advice-single-source: apps/web の .tsx を走査する（Issue #1873）', () => {
  const advice = phrases.find((p) => p.id === 'advice');
  const tsxPath = 'apps/web/app/routes/usage.tsx';

  async function makeRepoWithTsxFile(): Promise<string> {
    const dir = await makeTempDir('check-advice-single-source-1873-');
    const git = (...gitArgs: string[]) =>
      execFileSync('git', gitArgs, { cwd: dir, encoding: 'utf8', env: gitChildEnv() });
    git('init', '-q');
    git('config', 'user.email', 'test@example.invalid');
    git('config', 'user.name', 'test');
    await mkdir(join(dir, 'apps/web/app/routes'), { recursive: true });
    await writeFile(
      join(dir, tsxPath),
      `export const Notice = () => <p>${advice?.text}（新しい鍵で走る）。</p>;\n`,
    );
    await writeFile(join(dir, 'notes.md'), `${advice?.text}（散文は走査しない）\n`);
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
    expect(oldForm).not.toContain(tsxPath);

    const hits = findAdviceHits(
      oldForm.map((path) => ({ path, content: readFileSync(join(dir, path), 'utf8') })),
    ) as Hit[];
    expect(hits).toEqual([]);
  });

  it('🟢（直した後）: listScannableSources は apps/web の .tsx も対象に入れ、直書きを捕まえる', async () => {
    const dir = await makeRepoWithTsxFile();
    const files = listScannableSources(dir) as string[];
    expect(files).toContain(tsxPath);
    expect(files).not.toContain('notes.md');

    const hits = findAdviceHits(
      files.map((path) => ({ path, content: readFileSync(join(dir, path), 'utf8') })),
    ) as Hit[];
    expect(hits).toHaveLength(1);
    expect(hits[0]?.path).toBe(tsxPath);
    expect(hits[0]?.id).toBe('advice');
  });
});
