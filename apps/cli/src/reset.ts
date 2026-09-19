import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

import { describeAuthFailure, forbiddenKindOf, resolveTarget, type Target } from './target.js';

/**
 * `alteroid reset` — ワークスペースのリセット（「トークン情報以外を全部消す」）。
 *
 * **由来**: 本番（Railway）の Postgres に対して人間の依頼で1度、`railway
 * connect Postgres` 経由の手作業 `TRUNCATE` を行った（2026-09-14）。ここは
 * その「同条件」を alteroid 自身の機能として持たせたもの。何を残し何を消すかは
 * `POST /reset`（`apps/daemon/src/app.ts`）・`resetWorkspaceState`
 * （`@alteroid/core`）が正本——ここには書き写さない。
 *
 * **取り消せない操作なので、既定では対話で確認する。** `--yes` を渡すと
 * 確認を飛ばす（スクリプト・CI から呼ぶ用途）。
 */
interface ResetSummary {
  memory: number;
  journal: number;
  jobs: number;
  approvals: number;
  schedules: number;
  schedulePhases: number;
  inbox: number;
  commitments: number;
  archive: number;
  sessions: number;
  profile: number;
  usageDaily: number;
  usageBaseline: number;
  usageLedger: number;
  usageTurns: number;
  /** pg 構成でだけ付く。 */
  sessionLog?: number;
}

export async function resetCommand(options: { yes?: boolean } = {}): Promise<void> {
  if (options.yes !== true && !(await confirm())) {
    stdout.write('取り消しました。何も変更していません。\n');
    return;
  }

  const target = await resolveTarget();
  const view = (await post(target)) as { cleared: ResetSummary };
  report(view.cleared);
}

/**
 * **`y` / `Y` ではなく `yes` の全文を要求する。** 1文字の誤打（他の質問への
 * 反射的な `y`）で取り返しのつかない操作が通らないようにするため。
 */
async function confirm(): Promise<boolean> {
  stdout.write(
    '本当に削除しますか？\n' +
      '記憶・日誌・ジョブ・承認待ち・継続中の依頼・受信箱・引き受けた仕事・' +
      'アーカイブ・セッション・実行環境プロファイル・利用状況の台帳を全部消します。\n' +
      '認証トークンのプール・マネージャーへ降ろす環境変数・Web UI のログイン' +
      'アカウントは消しません。\n' +
      '取り消せません。\n',
  );
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    const answer = await rl.question('続けるなら yes と入力してください: ');
    return answer.trim().toLowerCase() === 'yes';
  } finally {
    rl.close();
  }
}

const SUMMARY_LABELS: [keyof ResetSummary, string][] = [
  ['memory', '記憶'],
  ['journal', '日誌'],
  ['jobs', 'ジョブ'],
  ['approvals', '承認待ち'],
  ['schedules', '継続中の依頼'],
  ['schedulePhases', '既定の仕込みの位相'],
  ['inbox', '受信箱'],
  ['commitments', '引き受けたまま終わっていない仕事'],
  ['archive', 'アーカイブ'],
  ['sessions', 'セッション登録簿'],
  ['profile', '実行環境プロファイル'],
  ['usageDaily', '利用状況（日次）'],
  ['usageBaseline', '利用状況（基準）'],
  ['usageLedger', '利用状況（台帳の開始時刻）'],
  ['usageTurns', '利用状況（回数）'],
  ['sessionLog', 'SDK セッション生ログ'],
];

function report(cleared: ResetSummary): void {
  stdout.write('リセットしました。消した件数:\n');
  for (const [key, label] of SUMMARY_LABELS) {
    const value = cleared[key];
    // `sessionLog` は pg 構成でだけ付く。fs 構成では出さない（`WorkspaceResetSummary` の doc）。
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
      /**
       * **`POST /reset` は宣言済み owner だけである**（`requireOwner`。
       * `PUT /credentials` と同じ強さ）。403 の理由を本文から判別する
       * （`apps/cli/src/credential.ts` の同じ分岐と同じ理由）。
       *
       * **⚠️ 2026-09-18、`requireOwner`（issue #1198。本来の形）へ置き換えた。**
       * 2026-09-17〜18 の間は近似（issue #1195。`grantedBy === 'operator'`）で
       * 通していたが、いまは `ownerDeclaredAt` の宣言を見る——立てるのは
       * `alteroid access owner <id>`。この経路の門も `requireOwner` なので、
       * `not_operator` の本文が返ることは無い（`credential.ts` の同じ doc）。
       */
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
      // `not_operator`（この経路では実際には来ない）と `unknown` は同じ扱い。
      throw new Error(
        'ワークスペースのリセットへのアクセスが拒否されました（403）。' +
          '理由を判別できなかったため、次にすべきことは案内しません。',
      );
    }
    const described = describeAuthFailure(response.status, target);
    if (described !== null) throw new Error(described);
    const body = (await response.json().catch(() => ({}))) as { error?: unknown };
    if (typeof body.error === 'string') throw new Error(body.error);
    throw new Error(`/reset が失敗しました (${String(response.status)})`);
  }
  return response.json();
}
