import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as prettier from 'prettier';
import { describe, expect, it } from 'vitest';

// @ts-expect-error -- 素の .mjs（型宣言を持たない build 用スクリプト）を読む
import { extractJobNames, extractJobsSection, listWorkflowFiles } from './workflow-scan-core.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const WORKFLOWS_DIR = path.join(ROOT, '.github', 'workflows');

// `ci` の `pnpm format:check` を名指しで固定する: workflow の YAML 構文を守っているのは prettier だけで、他の歯は文字列と正規表現で行を拾うだけのため、壊れた YAML に気づかないため。

const IGNORE_PATHS = [path.join(ROOT, '.gitignore'), path.join(ROOT, '.prettierignore')];

const workflowFiles: string[] = listWorkflowFiles(WORKFLOWS_DIR);

describe('workflow の YAML は prettier に parse される', () => {
  it('workflow が1本以上見つかる（空集合で緑にならない）', () => {
    expect(workflowFiles.length).toBeGreaterThan(0);
  });

  it.each(workflowFiles)('%s は ignore されず、yaml として parse される', async (file) => {
    const filePath = path.join(WORKFLOWS_DIR, file);
    const info = await prettier.getFileInfo(filePath, {
      ignorePath: IGNORE_PATHS,
      resolveConfig: true,
    });
    expect(info.ignored).toBe(false);
    expect(info.inferredParser).toBe('yaml');

    const config = (await prettier.resolveConfig(filePath)) ?? {};
    expect(config.requirePragma ?? false).toBe(false);
    expect((config as { checkIgnorePragma?: boolean }).checkIgnorePragma ?? false).toBe(false);
  });
});

describe('`ci` ジョブが `pnpm format:check` を走らせる', () => {
  it('`format:check` は `.` を対象にした `prettier --check` である', () => {
    const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    const tokens = (pkg.scripts?.['format:check'] ?? '').trim().split(/\s+/);
    expect(tokens.slice(0, 2)).toEqual(['prettier', '--check']);
    expect(tokens.slice(2)).toContain('.');
  });

  it('`ci.yml` の、`ci` が needs に載せている job に `run: pnpm format:check` の step が在る', () => {
    const text = readFileSync(path.join(WORKFLOWS_DIR, 'ci.yml'), 'utf8');
    const jobs = `\n${extractJobsSection(text) as string}`;
    const block = (name: string): string =>
      new RegExp(`\\n {2}${name}:\\n([\\s\\S]*?)(?=\\n {2}[A-Za-z0-9_-]+:|$)`).exec(jobs)?.[1] ??
      '';

    const ciBlock = block('ci');
    expect(ciBlock, '`ci.yml` に `ci` ジョブが見つからない').not.toBe('');
    const needsMatch = /^ {4}needs:\s*\[([^\]\n]*)\]/m.exec(ciBlock);
    expect(needsMatch, '`ci` ジョブの `needs: [...]` が読めない').not.toBeNull();
    const needs = (needsMatch?.[1] ?? '')
      .split(',')
      .map((n) => n.trim())
      .filter((n) => n.length > 0);

    const withFormatCheck = (extractJobNames(jobs.slice(1)) as string[]).filter((name) =>
      /^ +- run: pnpm format:check[ \t]*$/m.test(block(name)),
    );
    expect(withFormatCheck.length, '`run: pnpm format:check` の step がどの job にも無い').toBe(1);
    expect(
      needs,
      `format:check を走らせる job（${withFormatCheck.join(', ')}）が \`ci\` の needs に載っていない`,
    ).toContain(withFormatCheck[0]);
  });
});
