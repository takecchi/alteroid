/**
 * CLI の起動を軽くする口（issue #2860。`@alteroid/core/cli-light`）。
 *
 * `@alteroid/core` 本体は Claude Agent SDK・zod・croner などを評価するので、
 * 値を1つ取るだけで起動が約 250ms 延びる（`alteroid --version` でも）。ここは
 * CLI が起動時・読み取りコマンドで要る**定数と純粋な関数だけ**を再 export する。
 *
 * **この口が読むファイルは、zod・SDK・`schema.ts` の値を推移的に読まない**
 * （Node の組み込みだけ）。足すときもこの線を守ること——`cli-light.test.ts` が
 * 推移的な import を数えて壊れたら落ちる。zod のスキーマ（`usageLayerSchema` 等）
 * を要るものは入れず、呼び出し側が実行時に動的 import する。
 * `@alteroid/core`（`index.ts`）の中身は変えない。
 */
export { formatElapsedAgo } from './format-elapsed.js';
export { describeProgress } from './progress-describe.js';
export { describeGithubCi } from './progress-github.js';
export { ARCHIVE_REMOVED_BYTES_UNIT_NOTE } from './archive-removed-bytes.js';
export { RESET_CONFIRM_GROUPS } from './workspace-reset.js';
export { REMOVE_MANY_LIMIT_DEFAULT, REMOVE_MANY_LIMIT_MAX } from './remove-many-limit.js';
export { codePointBoundary } from './excerpt.js';
export { JOURNAL_SEARCH_UNCOVERED_LIST, matchesJournalSearch } from './journal-search.js';
export {
  describeSelectionsViolation,
  foldSelections,
  describeQuestionLines,
  summarizeQuestions,
} from './approval-choices.js';
export {
  assessPermissionGrantStaleness,
  PERMISSION_GRANT_STALE_DAYS,
} from './permission-staleness.js';
export { describePermissionRuleBreadth } from './permission-rule.js';
export { describeRevisionStatus } from './revision-format.js';
export {
  describeDroppedTraceEmpty,
  describeDroppedTraceOrigin,
  describeDroppedTraceRetention,
} from './dropped-record.js';
export {
  ACCOUNT_USAGE_TITLE,
  describeAccountUsage,
  describeUnmeteredUsage,
  describeUnreadableUsage,
  describeUnreadableUsageRows,
  describeUnrecordedManagers,
  describeUsageDateOrder,
  describeWebSearchRequests,
  formatUsd,
  summarizeUsage,
} from './usage-format.js';
export type { BuildRevision } from './revision-format.js';
export { reportRunnerRevision, resolveBuildRevision } from './revision-resolve.js';
export { CREDENTIAL_NAME } from './credentials.js';
export { MEMORY_SLUG_RULE, PRACTICE_SLUG_RULE, describeSlugViolation } from './slug-rule.js';
