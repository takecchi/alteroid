import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

// `JournalFoldWindow` を使う（＝日誌の行を畳む）ファイルの許可リスト。
// 新しい経路を足すときは、畳むのが「機構が自分で合成した、同一本文の反復」だけで、
// 人間・クローン・マネージャーの発話（exchange）、decision / escalation / memory_update、tool_use、context_usage を
// 畳まないことを確かめ直してから、ここと docs/architecture.md「日誌の守る線と畳める線」へ足す（#1311）。
const ALLOWED = [
  'apps/daemon/src/runner-event-journal-fold.ts',
  'apps/daemon/src/token-rotation-journal-fold.ts',
  'packages/core/src/index.ts',
  'packages/core/src/journal-fold.ts',
  'packages/core/src/manager.ts',
];

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    // generated は焼き込みの出力（`write-canon`。docs の文言を含む）で、畳む経路の実装ではない。
    if (['node_modules', 'dist', 'generated'].includes(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

describe('JournalFoldWindow を使うファイルの集合（守る側を畳まない線の再確認）', () => {
  it('許可リストと一致する。増えたら「守る側を畳まない」ことを確かめ直す', () => {
    const found = ['packages', 'apps']
      .flatMap((d) => sourceFiles(join(ROOT, d)))
      .filter((f) => readFileSync(f, 'utf8').includes('JournalFoldWindow'))
      .map((f) => relative(ROOT, f).split('\\').join('/'))
      .sort();
    expect(
      found,
      '日誌を畳む経路が増減した。畳んでよいのは「機構が自分で合成した、同一本文の反復」だけで、' +
        '人間・クローン・マネージャーの発話（exchange）・decision・escalation・memory_update・tool_use・context_usage は畳まない。' +
        'それを確かめ直したうえで、この許可リストと docs/architecture.md「日誌の守る線と畳める線」を更新すること（#1311）。',
    ).toEqual([...ALLOWED].sort());
  });
});
