import type { Stores } from './store.js';

// 呼び出し側に reset の対象を選ばせない: 選べる形にすると CLI と Web UI とで消えるものがずれるため。tokens / credentials / auth は触らない
export interface WorkspaceResetSummary {
  memory: number;
  journal: number;
  jobs: number;
  approvals: number;
  schedules: number;
  schedulePhases: number;
  inbox: number;
  commitments: number;
  practices: number;
  archive: number;
  sessions: number;
  profile: number;
  usageDaily: number;
  usageBaseline: number;
  usageLedger: number;
  usageTurns: number;
  sessionLog?: number;
}

export const RESET_CONFIRM_GROUPS: { label: string; keys: (keyof WorkspaceResetSummary)[] }[] = [
  { label: '記憶', keys: ['memory'] },
  { label: '日誌', keys: ['journal'] },
  { label: 'ジョブ', keys: ['jobs'] },
  { label: '承認待ち', keys: ['approvals'] },
  { label: '継続中の依頼', keys: ['schedules', 'schedulePhases'] },
  { label: '受信箱', keys: ['inbox'] },
  { label: '引き受けた仕事', keys: ['commitments'] },
  { label: '仕事のやり方', keys: ['practices'] },
  { label: 'アーカイブ', keys: ['archive'] },
  { label: 'セッション', keys: ['sessions'] },
  { label: '実行環境プロファイル', keys: ['profile'] },
  {
    label: '利用状況の台帳',
    keys: ['usageDaily', 'usageBaseline', 'usageLedger', 'usageTurns', 'sessionLog'],
  },
];

export function describeResetTargets(): string {
  return RESET_CONFIRM_GROUPS.map((group) => group.label).join('・');
}

export interface ResetWorkspaceStateOptions {
  clearSessionLog?: () => Promise<number>;
}

export async function resetWorkspaceState(
  stores: Stores,
  options: ResetWorkspaceStateOptions = {},
): Promise<WorkspaceResetSummary> {
  const memory = await stores.persona.clear();
  const journal = await stores.journal.clear();
  await stores.conversationReads.clearOutboundIndex();
  const jobsResult = await stores.jobs.clear();
  const schedulesResult = await stores.schedules.clear();
  const inbox = await stores.inbox.clear();
  const commitments = await stores.commitments.clear();
  const practices = await stores.practices.clear();
  const archive = await stores.archive.clear();
  const sessions = await stores.sessions.clear();
  const profile = await stores.profile.clear();
  const usageResult = await stores.usage.clear();
  const sessionLog =
    options.clearSessionLog === undefined ? undefined : await options.clearSessionLog();

  return {
    memory,
    journal,
    jobs: jobsResult.jobs,
    approvals: jobsResult.approvals,
    schedules: schedulesResult.schedules,
    schedulePhases: schedulesResult.phases,
    inbox,
    commitments,
    practices,
    archive,
    sessions,
    profile,
    usageDaily: usageResult.daily,
    usageBaseline: usageResult.baseline,
    usageLedger: usageResult.ledger,
    usageTurns: usageResult.turns,
    ...(sessionLog === undefined ? {} : { sessionLog }),
  };
}
