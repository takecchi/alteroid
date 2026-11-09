import { codePointBoundary } from './excerpt.js';

// `runner.ts` の中にあった、背景処理の 1 行（SDK の `BackgroundTaskSummary`）を読む小さな関数と、note の長さの上限をつける関数。
// `#onSubagentStop` 側（`runner.ts`）と Stop の観測（`runner-stop-observer.ts`）の両方が引くので、循環にならないよう葉のモジュールへ移した。
// 本体は一字も変えていない（コメントも）。`runner.ts` は `OWNER_RECORDABLE_TASK_TYPES` を再 export している（既存の import の行き先を動かさないため）。

/**
 * [sdk-verbatim BackgroundTaskSummary.type]
 * > Friendly task-type label (e.g. 'shell', 'subagent', 'monitor', 'workflow'). Falls back to the raw discriminant for unknown types.
 *
 * [sdk-verbatim BashOutput.backgroundTaskId]
 * > ID of the background task if command is running in background
 *
 * [sdk-verbatim MonitorOutput.taskId]
 * > ID of the background monitor task.
 *
 * [sdk-verbatim WorkflowOutput.taskType]
 * > TaskType of the registered background task — 'local_workflow' for in-process runs, 'remote_agent' when remote:true dispatches to CCR. Set on all new writes; absent only on transcripts written before this field existed.
 */
// `type !== 'subagent'` で除外しない: 所有者を引けないのが正常かは出力が `backgroundTaskId` を持つかという性質で決まり、monitor / workflow を起こしただけで誤診断が出るため
// 「引けなかった種類」を足さない: これは引ける側の名簿で、増えるのは `#recordBackgroundTaskOwner` が読むキーを増やしたときだけのため
export const OWNER_RECORDABLE_TASK_TYPES: ReadonlySet<string> = new Set(['shell']);

// `#noteOwnerLookupFailure` と `#stopTaskOwnerKind` の両方から引く: 片方だけ直すと同じ問いに2つの答えが出るため
export function isOwnerRecordableTaskType(type: unknown): boolean {
  return typeof type === 'string' && OWNER_RECORDABLE_TASK_TYPES.has(type);
}

/**
 * [sdk-verbatim SDKTaskUpdatedMessage.patch.status]
 * > status?: 'pending' | 'running' | 'completed' | 'failed' | 'killed' | 'paused';
 */
const SETTLED_BACKGROUND_TASK_STATUSES: ReadonlySet<string> = new Set([
  'completed',
  'failed',
  'killed',
]);

// `paused` を settled に入れない: 止まっているだけで、畳めば置き去りになるため
const LIVE_BACKGROUND_TASK_STATUSES: ReadonlySet<string> = new Set([
  'pending',
  'running',
  'paused',
]);

// 分からない status を `'settled'` へ倒さない: 起こし直しが黙って効かなくなるため
export function classifyBackgroundTaskStatus(status: unknown): 'live' | 'settled' | 'unknown' {
  if (typeof status !== 'string') return 'unknown';
  if (SETTLED_BACKGROUND_TASK_STATUSES.has(status)) return 'settled';
  if (LIVE_BACKGROUND_TASK_STATUSES.has(status)) return 'live';
  return 'unknown';
}

/** SDK の背景処理の1行（`unknown`）から、文字列の欄だけを読む。文字列でない欄は `undefined`（読み手が既定を決める）。 */
export interface BackgroundTaskRow {
  id?: string;
  type?: string;
  status?: string;
  description?: string;
  command?: string;
}

export function taskRow(task: unknown): BackgroundTaskRow {
  const t = task as Record<keyof BackgroundTaskRow, unknown>;
  const str = (value: unknown): string | undefined =>
    typeof value === 'string' ? value : undefined;
  return {
    id: str(t.id),
    type: str(t.type),
    status: str(t.status),
    description: str(t.description),
    command: str(t.command),
  };
}

// 黙って落とさない: 超えたら切り、切ったこと自体を末尾に書く（AGENTS.md「静かに失敗する道具」）
export function truncateWithNote(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return text.slice(0, codePointBoundary(text, limit)) + `…（上限 ${limit} 文字で切った）`;
}
