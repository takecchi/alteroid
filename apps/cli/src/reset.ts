import { stdout } from './terminal-out.js';

import { RESET_CONFIRM_GROUPS } from '@alteroid/core/cli-light';

import { describeAuthFailure, forbiddenKindOf, resolveTarget, type Target } from './target.js';
import { confirmIrreversible, type ConfirmIo } from './confirm.js';
import { redactError } from './redact.js';

interface ResetSummary {
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
  attachments: number;
  sessionLog?: number;
}

export async function resetCommand(options: { yes?: boolean } = {}, io?: ConfirmIo): Promise<void> {
  const target = await resolveTarget();
  if (target.note !== null) throw new Error(target.note);
  await confirmIrreversible(buildConfirmMessage(target.baseUrl), options, io);

  const view = (await post(target)) as { cleared: ResetSummary };
  report(view.cleared);
}

const CONFIRM_GROUPS = RESET_CONFIRM_GROUPS;

export const RESET_CONFIRM_GROUPS_FOR_TEST = CONFIRM_GROUPS;

// userinfo（`user:pass@`）を出さない: 秘密を画面に出さないため
export function displayBaseUrl(baseUrl: string): string {
  try {
    const url = new URL(baseUrl);
    url.username = '';
    url.password = '';
    return url.href.replace(/\/$/, '');
  } catch {
    return baseUrl.replace(/\/\/[^/]*@/, '//');
  }
}

export function buildConfirmMessage(baseUrl: string): string {
  const list = CONFIRM_GROUPS.map((group) => group.label).join('・');
  return (
    '本当に削除しますか？\n' +
    `接続先: ${displayBaseUrl(baseUrl)}\n` +
    `${list}を全部消します。\n` +
    '認証トークンのプール・マネージャーへ降ろす環境変数・Web UI のログイン' +
    'アカウントは消しません。'
  );
}

export const SUMMARY_LABELS: [keyof ResetSummary, string][] = [
  ['memory', '記憶'],
  ['journal', '日誌'],
  ['jobs', 'ジョブ'],
  ['approvals', '承認待ち'],
  ['schedules', '継続中の依頼'],
  ['schedulePhases', '既定の仕込みの位相'],
  ['inbox', '受信箱'],
  ['commitments', '引き受けたまま終わっていない仕事'],
  ['practices', '仕事のやり方'],
  ['archive', 'アーカイブ'],
  ['sessions', 'セッション登録簿'],
  ['profile', '実行環境プロファイル'],
  ['usageDaily', '利用状況（日次）'],
  ['usageBaseline', '利用状況（基準）'],
  ['usageLedger', '利用状況（記録の開始時刻）'],
  ['usageTurns', '利用状況（回数）'],
  ['attachments', '添付（保存したファイルを含む）'],
  ['sessionLog', 'セッションの生ログ'],
];

function report(cleared: ResetSummary): void {
  stdout.write('リセットしました。消した件数:\n');
  for (const [key, label] of SUMMARY_LABELS) {
    const value = cleared[key];
    if (value === undefined) continue;
    stdout.write(`  ${label}: ${value}\n`);
  }
  stdout.write(
    '\n認証トークンのプール・マネージャーへ降ろす環境変数・Web UI のログイン' +
      'アカウントには触れていません。\n',
  );
}

async function post(target: Target): Promise<unknown> {
  const response = await fetch(`${target.baseUrl}/reset`, {
    method: 'POST',
    headers: { ...target.headers, 'content-type': 'application/json' },
    body: JSON.stringify({ confirm: true }),
  });

  if (!response.ok) {
    if (response.status === 403) {
      const body = await response.json().catch(() => ({}));
      const kind = forbiddenKindOf(body);
      if (kind === 'not_declared_owner') {
        throw new Error(
          describeAuthFailure(403, target, kind) ??
            '実行環境の持ち主として宣言されたアカウントだけが操作できます。',
        );
      }
      if (kind === 'not_granted') {
        throw new Error(
          describeAuthFailure(403, target, kind) ??
            'このアカウントには alteroid を使う許可がありません。',
        );
      }
      throw new Error(
        'ワークスペースのリセットへのアクセスが拒否されました（403）。' +
          '理由を判別できなかったため、次にすべきことは案内しません。',
      );
    }
    const described = describeAuthFailure(response.status, target);
    if (described !== null) throw new Error(described);
    const body = (await response.json().catch(() => ({}))) as { error?: unknown };
    if (typeof body.error === 'string') throw new Error(redactError(body.error));
    throw new Error(`/reset が失敗しました (${String(response.status)})`);
  }
  return response.json();
}
