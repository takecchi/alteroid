import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { collectRepoFiles } from './repo-scan-files.js';

// `grep` を使わず、Node の `fs` で読んだ文字列に正規表現を通す: `grep` の取りこぼし（終了コード・識別子の一部・NUL・改行跨ぎ）を踏まないため。

const ROOT = fileURLToPath(new URL('..', import.meta.url));

const EXCLUDE_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.react-router', '.vite']);

// `journal-with-contract.ts` は窓を組み立ててよい場所に含める: `JournalStore` の `with` 契約を測る道具で、`readConversationWindow` を経由させると契約の他の分岐（`with` を渡さない・空配列）を直接呼べないため。
const ALLOWED_FILES = new Set([
  'packages/core/src/conversation.ts',
  'packages/core/src/journal-with-contract.ts',
]);

// 前後 240 文字ずつを許容する: 呼び出しごとに `types` の位置が違い、`limit` や `since` / `until` が前後に来るため。
// `.list(` の直前に識別子を要求する: 文字列中の "types: ['exchange']"（`clone.ts` の案内文言）を除くため。
const HAND_BUILT_WINDOW =
  /[A-Za-z_$][\w$]*\.list\(\s*\{[\s\S]{0,240}?types:\s*\[\s*(['"])exchange\1\s*\][\s\S]{0,240}?\}\s*\)/g;

export interface HandBuiltWindowHit {
  file: string;
  snippet: string;
}

export function findHandBuiltConversationWindows(files: readonly string[]): HandBuiltWindowHit[] {
  const hits: HandBuiltWindowHit[] = [];
  for (const file of files) {
    if (!file.endsWith('.ts') && !file.endsWith('.tsx')) continue;
    if (file.endsWith('.test.ts') || file.endsWith('.test.tsx')) continue;
    if (ALLOWED_FILES.has(file)) continue;
    const text = readFileSync(path.join(ROOT, file), 'utf8');
    for (const m of text.matchAll(HAND_BUILT_WINDOW)) {
      hits.push({ file, snippet: m[0].replace(/\s+/g, ' ').slice(0, 160) });
    }
  }
  return hits;
}

const allFiles = collectRepoFiles(ROOT, EXCLUDE_DIRS);

describe('会話の走査窓は conversation.ts の readConversationWindow 1か所でだけ組み立てる（issue #418 再発防止）', () => {
  it('前提: 少なくとも1つのソースファイルを見つけている', () => {
    expect(allFiles.length).toBeGreaterThan(0);
  });

  it('前提: 検出パターンは conversation.ts 自身の readConversationWindow に当たる（検出できることの確認）', () => {
    const text = readFileSync(path.join(ROOT, 'packages/core/src/conversation.ts'), 'utf8');
    const matches = [...text.matchAll(HAND_BUILT_WINDOW)];
    expect(
      matches.length,
      'readConversationWindow の呼び出し形が変わり、この歯の検出パターンが当たらなくなっている疑いがある',
    ).toBeGreaterThan(0);
  });

  it("conversation.ts 以外に types:['exchange'] を持つ journal.list(...) の手組みが無い", () => {
    const hits = findHandBuiltConversationWindows(allFiles);
    expect(
      hits,
      hits.length === 0
        ? ''
        : `会話の窓を手組みしている箇所が見つかった。readConversationWindow を経由すること:\n${hits
            .map((h) => `  ${h.file}: ${h.snippet}`)
            .join('\n')}`,
    ).toEqual([]);
  });
});
