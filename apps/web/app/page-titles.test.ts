/**
 * 全 route がタブの題名を持つこと（#2754）。`routes.ts` の一覧と突き合わせる。
 *
 * 題名は h1 を描く部品（`Page` / `ScreenState` / `ChatHeader`）か、login の `DocumentTitle` が出す。
 * root の meta に固定の題名が戻ると全画面が同じ題名に戻るので、それも落とす。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const APP = resolve(__dirname);
const read = (rel: string) => readFileSync(resolve(APP, rel), 'utf8');

const routeFiles = [
  ...read('routes.ts').matchAll(/(?:route|index|layout)\([^)]*?'(routes\/[\w.-]+\.tsx)'/g),
].map((m) => m[1]!);
// shell は枠で、題名は中の画面が出す（接続できないときの ScreenState だけ自前）。
const FRAME = 'routes/shell.tsx';

describe('全 route が題名を持つ', () => {
  it('routes.ts から route を拾えている（拾えなければ下の確認が空振りする）', () => {
    expect(routeFiles.length).toBeGreaterThanOrEqual(25);
    expect(routeFiles).toContain('routes/not-found.tsx');
  });

  for (const file of routeFiles.filter((f) => f !== FRAME)) {
    it(`${file}: Page か DocumentTitle か ChatPane（ChatHeader）を描く`, () => {
      const src = read(file);
      expect(/<Page\b|<DocumentTitle\b|<ChatPane\b/.test(src)).toBe(true);
    });

    it(`${file}: Page の title が部品なら documentTitle を渡している`, () => {
      const src = read(file);
      let from = 0;
      for (;;) {
        const start = src.indexOf('<Page', from);
        if (start === -1) break;
        from = start + 5;
        const rest = src.slice(start);
        const titleAt = rest.search(/\btitle=/);
        if (titleAt === -1) continue;
        if (rest[titleAt + 6] === '{') {
          expect(
            rest.slice(0, titleAt),
            `${file}: title が部品の <Page> に documentTitle が無い`,
          ).toContain('documentTitle=');
        }
      }
    });
  }

  it('root の meta は固定の題名を持たない', () => {
    const meta = read('root.tsx').match(/export function meta\(\) \{[\s\S]*?\n\}/)![0];
    expect(meta).not.toMatch(/\btitle:/);
  });

  it('404 の h1 は「ページが見つかりません」', () => {
    expect(read('routes/not-found.tsx')).toContain('title="ページが見つかりません"');
  });
});
