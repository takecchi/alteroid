import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// 「クローンの道具の実装ソースを文字列で読む試験」の入口を1つに揃える。
// `tools.ts` を族ごとのファイルへ分けても、読む対象が自動で増えるようにするため:
//   - `tools.ts` 本体
//   - `clone-tools-<族>.ts`（道具の族のファイル。命名規則はこの1本が持つ）
// 数えないもの: テスト（`*.test.ts`）・この種の補助（`*.test-support.ts`）、そして道具の実装ではない
// `clone-tools-transport.ts`（子プロセスへ道具を中継する配線）。
// 空振りさせない: 対象が1本も無い・`tools.ts` が入っていない・読んだ本文が空のときは、黙って通さず投げる。

const SRC_DIR = fileURLToPath(new URL('.', import.meta.url));
const SRC_REL = 'packages/core/src/';

export const CLONE_TOOLS_ENTRY_FILE = 'tools.ts';

const FAMILY_FILE = /^clone-tools-[a-z0-9-]+\.ts$/;
const NOT_A_FAMILY_FILE = new Set(['clone-tools-transport.ts']);

/** ファイル名（ディレクトリを含まない）が、道具の実装ソースか。 */
export function isCloneToolsSourceName(name: string): boolean {
  return (
    name === CLONE_TOOLS_ENTRY_FILE || (FAMILY_FILE.test(name) && !NOT_A_FAMILY_FILE.has(name))
  );
}

/** リポジトリの根からの相対パス（`packages/core/src/...`）が、道具の実装ソースか。 */
export function isCloneToolsSourceRelPath(rel: string): boolean {
  if (!rel.startsWith(SRC_REL)) return false;
  const name = rel.slice(SRC_REL.length);
  return !name.includes('/') && isCloneToolsSourceName(name);
}

export interface CloneToolsSource {
  /** `packages/core/src` からのファイル名。 */
  readonly name: string;
  readonly source: string;
}

/** 道具の実装ソースをすべて読む（名前順。`tools.ts` を含む）。 */
export function readCloneToolsSources(dir: string = SRC_DIR): readonly CloneToolsSource[] {
  const names = readdirSync(dir).filter(isCloneToolsSourceName).sort();
  if (names.length === 0) {
    throw new Error('道具の実装ソースが1本も見つからない。この歯は何も測っていない');
  }
  if (!names.includes(CLONE_TOOLS_ENTRY_FILE)) {
    throw new Error(`${CLONE_TOOLS_ENTRY_FILE} が対象に入っていない。この歯は何も測っていない`);
  }
  return names.map((name) => {
    const source = readFileSync(join(dir, name), 'utf8');
    if (source.trim().length === 0) {
      throw new Error(`${name} の本文が空である。この歯は何も測っていない`);
    }
    return { name, source };
  });
}

/** 道具の実装ソースを1つの文字列に繋げて返す（「どこにも無い」を確かめる試験向け）。 */
export function readCloneToolsSource(dir: string = SRC_DIR): string {
  return readCloneToolsSources(dir)
    .map((entry) => entry.source)
    .join('\n');
}
