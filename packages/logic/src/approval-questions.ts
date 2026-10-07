// 定義を logic へ移さない: core の道具も同じ定義を使い、logic が core に依存しているため。
export {
  describeQuestionLines,
  summarizeQuestions,
} from '@alteroid/core/approval-questions-format';
