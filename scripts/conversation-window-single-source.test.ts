import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * **会話の走査窓を組み立てる場所が1つに保たれているかを測る歯（issue #418 の
 * 再発防止 (i)）。**
 *
 * #418 は、`GET /conversations` / `GET /conversations/:id`（`apps/daemon/src/app.ts`）
 * とクローンの道具 `conversation_read`（`packages/core/src/tools.ts`）が、それぞれ
 * `journal.list({ limit: scan, types: ['exchange'] })` を手で組み立てていたために
 * 起きた。`with`（誰との往復か）を絞る場所が3か所に散っていたので、1か所（当時は
 * どこも）で `with` を `limit` より前へ効かせる直しを入れても、残りの箇所が古いまま
 * 取り残されうる形になっていた。
 *
 * 直しは `packages/core/src/conversation.ts` の `readConversationWindow` へ窓の
 * 組み立てを1つに閉じることだった。**この歯が測るのは、その1か所が保たれている
 * ことである** — 本番のソース（テストを除く）を走査し、`conversation.ts` 以外の
 * 場所が `types: ['exchange']` を持つ `journal.list` 呼び出しを新しく手組みしたら
 * 落ちる。
 *
 * **`grep` を使わない。** `AGENTS.md`「静かに失敗する道具」の `grep` の4つの
 * 取りこぼし（終了コードが嘘をつく／識別子の一部に一致しない／NUL でバイナリ判定
 * される／改行を跨ぐ）を踏まないよう、Node の `fs` で読んだ生の文字列に対して
 * 自前の正規表現を通す（`scripts/agents-md-references.test.ts` と同じ作法）。
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** 変異試験・生成物・依存を対象から外す。 */
const EXCLUDE_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.react-router', '.vite']);

/**
 * 窓を組み立ててよい場所。
 *
 * - `conversation.ts` — `readConversationWindow` 自身（この歯が守る当のもの）
 * - `journal-with-contract.ts` — **会話の窓ではなく、`JournalStore` 自体の
 *   `with` 契約を測る道具**（`verifyJournalStoreWithContract`）。ここは
 *   `types` / `with` / `limit` の生の組み合わせを直接叩いて検査するのが仕事
 *   そのものなので、`readConversationWindow` を経由させる対象ではない
 *   （経由させると、契約4「`limit` より前に効く」を測れなくなる——
 *   `readConversationWindow` は常に `with: ['human']` を渡すので、`with` を
 *   渡さない／空配列にする、といった契約の他の分岐を直接は呼べない）。
 */
const ALLOWED_FILES = new Set([
  'packages/core/src/conversation.ts',
  'packages/core/src/journal-with-contract.ts',
]);

/** repo 全体をファイル単位で読み、リポジトリ根からの相対パス（`/` 区切り）で返す。 */
function collectFiles(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (EXCLUDE_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectFiles(full, out);
    } else if (entry.isFile()) {
      out.push(path.relative(ROOT, full).split(path.sep).join('/'));
    }
  }
}

/**
 * `<何か>.list({ ... types: ['exchange'] または ["exchange"] ... })` の形を
 * 探す。前後 240 文字ずつを許容するのは、実際の呼び出しがオブジェクトリテラルの
 * 途中で改行し、`limit` や `since` / `until` が `types` の前後に来る形（順序は
 * 呼び出しごとに違う）を広く拾うためである——実際にこれまでの3箇所
 * （`app.ts` ×2、`tools.ts` ×1）はどれも `types` の位置が違った。
 *
 * **`.list(` の直前に何らかの識別子を要求する**（`journal.list(` /
 * `stores.journal.list(` のどちらにも当たる）ことで、無関係な `.list(` 呼び出し
 * （このリポジトリには無いが）や、単なる文字列中の "types: ['exchange']" の
 * 混入（`clone.ts` がクローンへ案内する文言としてこの文字列を持つ——`journal_read`
 * の使い方であって `journal.list` の呼び出しではない）を除く。
 */
const HAND_BUILT_WINDOW =
  /[A-Za-z_$][\w$]*\.list\(\s*\{[\s\S]{0,240}?types:\s*\[\s*(['"])exchange\1\s*\][\s\S]{0,240}?\}\s*\)/g;

export interface HandBuiltWindowHit {
  file: string;
  snippet: string;
}

/** 本番ソースの中から、窓を手組みしている箇所を探す。テストファイル自身は除く。 */
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

const allFiles: string[] = [];
collectFiles(ROOT, allFiles);

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
