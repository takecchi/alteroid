import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as prettier from 'prettier';
import { describe, expect, it } from 'vitest';

// @ts-expect-error -- 素の .mjs（型宣言を持たない build 用スクリプト）を読む
import { extractJobsSection, listWorkflowFiles } from './workflow-scan-core.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const WORKFLOWS_DIR = path.join(ROOT, '.github', 'workflows');

/**
 * **配線の歯。workflow の YAML が構文として壊れていないことを測っている唯一の門
 * （`ci` の `pnpm format:check`）を、たまたまの配線から名指しの配線へ固定する。**
 *
 * ## 何のためにここが在るか
 *
 * workflow を読む他の歯（`ci-draft-gating.test.ts` / `check-scripts-wired.test.ts` /
 * `main-ci-alarm.test.ts` / `workflow-scan-core.mjs` を使う道具）は、どれも文字列と
 * 正規表現で必要な行だけを拾う。**YAML として壊れた行が在っても、拾う行と無関係なら
 * 緑のままである。**実測（2026-09-23）: `ci.yml` の step 名を `'omitted' の段が…`
 * （先頭の `'` が引用符として読まれ、閉じた後に文字が続く＝不正な YAML）に変えても、
 * それらの歯は全部緑だった。同じ形の破損は別リポジトリで実際に起きている。
 *
 * **捕まえたのは `pnpm format:check` だけだった**——prettier は YAML を本物の
 * パーサで読むので、`SyntaxError: Unexpected scalar at node end` で落ちる。
 * ⟹ **workflow の構文を守っているのは prettier であり、しかもそれはどこにも
 * 宣言されていなかった。**`.prettierignore` に `.github/` を足す、`format:check` の
 * 対象を絞る、`ci` から step を外す、のどれか1つで、この守りは黙って消える。
 *
 * ## 測っているもの
 *
 * 1. `.github/workflows/` の各ファイル（一覧は導出する。ベタ書きしない）が、
 *    CLI と同じ ignore ファイル（`.gitignore` / `.prettierignore`）で除外されて
 *    おらず、設定を解決したうえで parser が `yaml` と推定されること。
 * 2. 解決した設定が `requirePragma` / `checkIgnorePragma` を有効にしていないこと
 *    （どちらも、ファイルの中身次第で parse せずに素通りさせる設定である）。
 * 3. `package.json` の `format:check` が `.` を対象にした `prettier --check` で
 *    あり、`ci.yml` の `ci` ジョブがそれを `run: pnpm format:check` で呼ぶこと。
 *
 * **無関係な ignore は禁じない。**`.prettierignore` に何を足しても、workflow
 * ファイルを外さない限りこの歯は緑のままである。
 *
 * ## この歯が測っていないこと
 *
 * - **`ci` ジョブのその step が実際に実行されることまでは見ない。**step に
 *   `if:` が付いたり、ジョブの `if:` が変わったりしても、「書いてある」を見て
 *   緑を返す（`check-scripts-wired.test.ts` の同種の断りと同じ形）。
 * - **`ci.yml` 自身が GitHub に読めないほど壊れた場合**、`ci` は起動しないので
 *   この歯も `format:check` も走らない。そのとき required の `ci` が来ない
 *   ことで止まる、という見立ては GitHub 上で確かめていない。
 * - **prettier の YAML パーサと GitHub Actions のパーサが同じものを拒む保証は
 *   無い。**測ったのは上の `'omitted' の…` の形で prettier が落ちることだけである。
 */

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

  it('`ci.yml` の `ci` ジョブに `run: pnpm format:check` の step が在る', () => {
    const text = readFileSync(path.join(WORKFLOWS_DIR, 'ci.yml'), 'utf8');
    const jobs = `\n${extractJobsSection(text) as string}`;
    const m = /\n {2}ci:\n([\s\S]*?)(?=\n {2}[A-Za-z0-9_-]+:|$)/.exec(jobs);
    expect(m, '`ci.yml` に `ci` ジョブが見つからない').not.toBeNull();
    expect(m?.[1] ?? '').toMatch(/^ +- run: pnpm format:check[ \t]*$/m);
  });
});
