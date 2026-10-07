import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { makeTempDir } from '../vitest.tmpdir.js';

import { gitChildEnv } from './git-child-env.js';
import {
  listGitScannableFiles,
  // @ts-expect-error -- 素の .mjs
} from './git-scannable-files-core.mjs';

// テストファイルは走査しない: SDK が返す使用量の key は具体の id そのもので、fixture にその現物が要るため。

const ROOT = fileURLToPath(new URL('..', import.meta.url));

const CODE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs'];

const TEST_EXTENSION_PATTERN = /\.test\.(ts|tsx|mts|cts|js|mjs|cjs)$/;

const SELF_PATH = 'scripts/check-no-hardcoded-model-ids.test.ts';

export const MODEL_ID_PATTERN = /claude-(opus|sonnet|haiku|fable)-\d/;

// コメント行の判定に `#` を足さない: JS/TS の行頭の `#` は private フィールド（`#model = 'claude-opus-5';`）で、足すとその記法が抜け道になるため。
export function isCommentLine(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*');
}

export function hasHardcodedModelId(line: string): boolean {
  if (isCommentLine(line)) return false;
  return MODEL_ID_PATTERN.test(line);
}

// `.claude/skills/` 配下は拡張子フィルタに加えて明示的にも除く: `.mjs` が実在するため。
export function scannableFiles(root: string = ROOT): string[] {
  return (listGitScannableFiles({ cwd: root }) as string[])
    .filter((p) => CODE_EXTENSIONS.some((ext) => p.endsWith(ext)))
    .filter((p) => !TEST_EXTENSION_PATTERN.test(p))
    .filter((p) => p !== SELF_PATH)
    .filter((p) => !p.startsWith('.claude/'));
}

describe('scannableFiles は未追跡ファイルも対象に入れる（#1817）', () => {
  async function makeRepoWithUntrackedFile(): Promise<string> {
    const dir = await makeTempDir('check-no-hardcoded-model-ids-1817-');
    const git = (...args: string[]) =>
      execFileSync('git', args, { cwd: dir, encoding: 'utf8', env: gitChildEnv() });
    git('init', '-q');
    git('config', 'user.email', 'test@example.invalid');
    git('config', 'user.name', 'test');
    await writeFile(path.join(dir, 'tracked.ts'), 'export const ok = 1;\n');
    git('add', '-A');
    git('commit', '-qm', 'init');
    await writeFile(path.join(dir, 'new-untracked.ts'), "const m = 'claude-opus-5';\n");
    return dir;
  }

  it('🔴（直す前の形）: 素の `git ls-files -z` は新規ファイルを見落とす', async () => {
    const dir = await makeRepoWithUntrackedFile();
    const oldForm = execFileSync('git', ['ls-files', '-z'], {
      cwd: dir,
      encoding: 'utf8',
      env: gitChildEnv(),
    })
      .split('\0')
      .filter((p) => p.length > 0);
    expect(oldForm).not.toContain('new-untracked.ts');
  });

  it('🟢（直した後）: scannableFiles は同じ新規ファイルを対象に入れる', async () => {
    const dir = await makeRepoWithUntrackedFile();
    const files = scannableFiles(dir);
    expect(files).toContain('new-untracked.ts');
    expect(files).toContain('tracked.ts');
  });
});

describe('具体のモデル id の直書き', () => {
  it('引っかかる書き方を全部見つける', () => {
    const broken = [
      "const MODEL = 'claude-opus-5';",
      'model: "claude-sonnet-5-20260101",',
      "if (id === 'claude-haiku-4') return true;",
      'const FABLE = `claude-fable-3`;',
      '  claude-opus-41 // 版が2桁でも当たる',
      "  #model = 'claude-opus-5';",
    ];
    for (const line of broken) expect(hasHardcodedModelId(line), line).toBe(true);
  });

  it('引っかからない書き方は見逃す', () => {
    const fine = [
      "const MODEL_ALIAS = 'opus';",
      "const label = 'claude-opus'; // 数字が無い版はエイリアスの一部として許す",
      '// claude-opus-5 のような具体の id が SDK 側の対応表に焼かれている',
      '* claude-sonnet-5 は例として挙げているだけ',
    ];
    for (const line of fine) expect(hasHardcodedModelId(line), line).toBe(false);
  });

  it('走査対象のファイル一覧が十分な数ある（走査が壊れて0件を緑と読まない足場）', () => {
    const files = scannableFiles();
    expect(files.length).toBeGreaterThan(50);
  });

  it('既知のファイル（claude-provider.ts）が走査対象に入っている', () => {
    const files = scannableFiles();
    expect(files).toContain('packages/core/src/claude-provider.ts');
  });

  it('走査対象からテストファイルとこの検査自身が除かれている', () => {
    const files = scannableFiles();
    expect(files.some((f) => TEST_EXTENSION_PATTERN.test(f))).toBe(false);
    expect(files).not.toContain('scripts/check-no-hardcoded-model-ids.test.ts');
  });

  it('コードのどこにも具体のモデル id が直書きされていない', () => {
    const files = scannableFiles();
    const hits: string[] = [];
    for (const file of files) {
      let text: string;
      try {
        text = readFileSync(path.join(ROOT, file), 'utf8');
      } catch {
        continue;
      }
      if (text.includes('\0')) continue;
      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line !== undefined && hasHardcodedModelId(line)) {
          hits.push(`${file}:${i + 1}: ${line.trim()}`);
        }
      }
    }
    expect(
      hits,
      '具体のモデル id を直書きしないこと。エイリアス（fable / opus / sonnet）で書くこと。' +
        '具体の id への対応は SDK のバンドル（sdk.mjs の aliases）が持つ。' +
        '正当に直書きが要る場面が現れたら、この歯（scripts/check-no-hardcoded-model-ids.test.ts）に' +
        '理由付きの免除表を足すこと（いまは該当が0件なので作っていない）。',
    ).toEqual([]);
  });
});
