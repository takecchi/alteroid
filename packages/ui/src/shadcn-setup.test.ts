import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * shadcn の部品の置き場（`src/components/ui/`）が、`shadcn add` の癖で黙って崩れていないか。
 *
 * どれも**型検査かテストのどこかで落ちるとは限らない**形なので、ここで直に測る
 * （理由はそれぞれの `it` に書く）。`shadcn add` は `pnpm --filter @alteroid/ui shadcn:add`
 * （`scripts/shadcn-add.mjs`）で打つ前提で、あの包みが直すものをここが確かめる。
 */
const packageDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const uiDir = path.join(packageDir, 'src/components/ui');

function componentFiles(): string[] {
  return readdirSync(uiDir)
    .filter((file) => file.endsWith('.tsx'))
    .filter((file) => !file.endsWith('.stories.tsx') && !file.endsWith('.test.tsx'))
    .sort();
}

describe('shadcn の部品の置き場', () => {
  it('部品が1つ以上在る（下の検査が空の集合で緑にならないように）', () => {
    expect(componentFiles().length).toBeGreaterThan(0);
  });

  /**
   * shadcn 4.21.0 はこの repo で `import { cn } from "cn"` を吐く（`scripts/shadcn-add.mjs`
   * の冒頭）。npm の `cn` は別物なので、入れば描画が壊れる——が、依存に `cn` が入って
   * いると型検査は通りうる。
   */
  it('`cn` を npm の `cn` から取っている部品が無い', () => {
    const offenders = componentFiles().filter((file) =>
      /from\s+["']cn["']/.test(readFileSync(path.join(uiDir, file), 'utf8')),
    );
    expect(offenders).toEqual([]);
  });

  it('package.json の依存に npm の `cn` が無い', () => {
    const pkg = JSON.parse(readFileSync(path.join(packageDir, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    expect(Object.keys(pkg.dependencies ?? {})).not.toContain('cn');
    expect(Object.keys(pkg.devDependencies ?? {})).not.toContain('cn');
  });

  /**
   * 足した部品を `index.ts` へ書き忘れると、`@alteroid/ui/shadcn` から見えないまま
   * 置き場にだけ在る。画面から使おうとした人は `@/components/ui/...` を書きたくなるが、
   * それは ESLint が止める（`eslint.config.js` の `UI_ALIAS_BAN`）ので、ここで先に知らせる。
   */
  it('置き場の部品が全部 `index.ts`（`@alteroid/ui/shadcn`）から出ている', () => {
    const index = readFileSync(path.join(uiDir, 'index.ts'), 'utf8');
    const exported = [...index.matchAll(/export \* from '\.\/([a-z-]+)';/g)].map((m) => m[1]);
    const expected = componentFiles()
      .map((file) => file.replace(/\.tsx$/, ''))
      .sort();
    expect([...exported].sort()).toEqual(expected);
  });

  /**
   * `"style"` を消すと shadcn 4.x は既定（Base UI）へ倒れ、次の `add` から静かに別物が来る
   * （`.claude/skills/apps-web/SKILL.md`）。aliases は `@/` の別名の対応
   * （`tsconfig.json` / `.storybook/main.ts` / apps/web / 根の vitest）と揃っている必要がある。
   */
  it('components.json が radix-nova と `@/` の aliases を指し、utils の実体が在る', () => {
    const config = JSON.parse(readFileSync(path.join(packageDir, 'components.json'), 'utf8')) as {
      style: string;
      aliases: Record<string, string>;
    };
    expect(config.style).toBe('radix-nova');
    expect(config.aliases.utils).toBe('@/lib/utils');
    expect(config.aliases.ui).toBe('@/components/ui');
    expect(existsSync(path.join(packageDir, 'src/lib/utils.ts'))).toBe(true);
  });
});
