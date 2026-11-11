import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// `memory.ts` と `memory-*.ts`（`.test.ts` と `.test-support.ts` を除く）の全てから、
// `export const MEMORY_*_BUDGET = <数>;` を字面で読む。
// 分割で予算が複数ファイルへ散っても、読み漏らして兄弟検査が静かに弱まらないようにするため。
export function scanMemoryBudgetConstants(): Map<string, number> {
  const dir = fileURLToPath(new URL('.', import.meta.url));
  const files = readdirSync(dir)
    .filter(
      (name) =>
        /^memory(-[\w-]+)?\.ts$/.test(name) &&
        !name.endsWith('.test.ts') &&
        !name.endsWith('.test-support.ts'),
    )
    .sort();
  const byName = new Map<string, number>();
  for (const file of files) {
    const source = readFileSync(`${dir}${file}`, 'utf8');
    for (const match of source.matchAll(/export const (MEMORY_\w*_BUDGET) = ([\d_]+);/g)) {
      byName.set(match[1] as string, Number((match[2] as string).replace(/_/g, '')));
    }
  }
  return byName;
}
