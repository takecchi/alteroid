/**
 * 軽い口（issue #2860。`@alteroid/storage-fs/light`）。
 *
 * 本体（`index.ts`）は `@alteroid/core` のバレルを読むので、CLI が
 * `writeFileAtomic` / `withPathLock` を取るだけで起動のたびに core 全体
 * （SDK・zod）を評価していた。ここは Node の組み込みだけを読む2つのファイルを
 * 再 export する。`index.ts` の中身は変えない。
 */
export { writeFileAtomic } from './atomic.js';
export { LockTimeoutError, withPathLock } from './file-lock.js';
