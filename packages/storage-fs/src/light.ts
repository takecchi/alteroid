// `index.ts` から取らせない: 本体は `@alteroid/core` のバレルを読むので、取るだけで core 全体（SDK・zod）を評価してしまうため
export { writeFileAtomic } from './atomic.js';
export { LockTimeoutError, withPathLock } from './file-lock.js';
