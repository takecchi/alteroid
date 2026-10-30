import { TaskBreakdownReader } from '@alteroid/runner';

// `createRunnerApp` は読み手とモデルの既定を持たない（runner の起動の側が必ず渡す）。試験はこれを渡す。
// 読み手は呼ぶたびに新しく作る: 走査の結果の控えを、別の試験の app と共有しないため。
export function runnerAppDefaults(): {
  taskBreakdownReader: TaskBreakdownReader;
  managerModel: string;
  workerModel: string;
} {
  return {
    taskBreakdownReader: new TaskBreakdownReader(),
    managerModel: 'opus',
    workerModel: 'sonnet',
  };
}
