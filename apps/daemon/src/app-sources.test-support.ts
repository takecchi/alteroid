import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// 「HTTP の口（`app.ts`）のソースを文字列で読む試験」の入口を1つに揃える。
// `app.ts` を族ごとのファイルへ分けても、読む対象が自動で増えるようにするため:
//   - `app.ts` 本体
//   - `app-routes-<族>.ts`（経路の族のファイル。命名規則はこの1本が持つ）
// 数えないもの: テスト（`*.test.ts`）・この種の補助（`*.test-support.ts`）・JSON。
// 空振りさせない: 対象が1本も無い・`app.ts` が入っていない・読んだ本文が空のときは、黙って通さず投げる。

const SRC_DIR = fileURLToPath(new URL('.', import.meta.url));
const SRC_REL = 'apps/daemon/src/';

export const APP_ENTRY_FILE = 'app.ts';

const FAMILY_FILE = /^app-routes-[a-z0-9-]+\.ts$/;

/** ファイル名（ディレクトリを含まない）が、HTTP の口のソースか。 */
export function isAppSourceName(name: string): boolean {
  return name === APP_ENTRY_FILE || FAMILY_FILE.test(name);
}

/** リポジトリの根からの相対パス（`apps/daemon/src/...`）が、HTTP の口のソースか。 */
export function isAppSourceRelPath(rel: string): boolean {
  if (!rel.startsWith(SRC_REL)) return false;
  const name = rel.slice(SRC_REL.length);
  return !name.includes('/') && isAppSourceName(name);
}

export interface AppSource {
  /** `apps/daemon/src` からのファイル名。 */
  readonly name: string;
  readonly source: string;
}

/** HTTP の口のソースをすべて読む（名前順。`app.ts` を含む）。 */
export function readAppSources(dir: string = SRC_DIR): readonly AppSource[] {
  const names = readdirSync(dir).filter(isAppSourceName).sort();
  if (names.length === 0) {
    throw new Error('HTTP の口のソースが1本も見つからない。この歯は何も測っていない');
  }
  if (!names.includes(APP_ENTRY_FILE)) {
    throw new Error(`${APP_ENTRY_FILE} が対象に入っていない。この歯は何も測っていない`);
  }
  return names.map((name) => {
    const source = readFileSync(join(dir, name), 'utf8');
    if (source.trim().length === 0) {
      throw new Error(`${name} の本文が空である。この歯は何も測っていない`);
    }
    return { name, source };
  });
}

/** HTTP の口のソースを1つの文字列に繋げて返す（「どこにも無い」を確かめる試験向け）。 */
export function readAppSource(dir: string = SRC_DIR): string {
  return readAppSources(dir)
    .map((entry) => entry.source)
    .join('\n');
}
