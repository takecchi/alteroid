/**
 * 軽い口（`@alteroid/storage-fs/light`）。
 *
 * 本体（`index.ts`）は `@alteroid/core` のバレルを読むので、CLI が
 * `writeFileAtomic` / `withPathLock` を取るだけで起動のたびに core 全体
 * （SDK・zod）を評価してしまう。ここは Node の組み込みだけを読む2つのファイルを
 * 再 export する。
 */
export { writeFileAtomic } from './atomic.js';
export { LockTimeoutError, withPathLock } from './file-lock.js';
