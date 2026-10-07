/**
 * 承認待ちの設問の要約・詳細の行（一覧・詳細・CLI で同じ文言を使うため）。
 *
 * 定義は `packages/core/src/approval-questions-format.ts`（`@alteroid/core/approval-questions-format`）
 * に在る（core の道具も同じ定義を使うので、logic へは移せない——logic が core に依存している）。
 * ここは `apps/web` が読むための再 export で、`journal-summary.ts` と同じ形。
 */
export {
  describeQuestionLines,
  summarizeQuestions,
} from '@alteroid/core/approval-questions-format';
