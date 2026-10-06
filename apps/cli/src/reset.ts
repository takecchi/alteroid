import { stdout } from 'node:process';

import { RESET_CONFIRM_GROUPS } from '@alteroid/core/cli-light';

import { describeAuthFailure, forbiddenKindOf, resolveTarget, type Target } from './target.js';
import { confirmIrreversible, type ConfirmIo } from './confirm.js';
import { redactError } from './redact.js';

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
 *
 * **確認の扱いは `confirmIrreversible`（`confirm.ts`）に揃えてある（Issue #3200）。**
 * 端末でなく `--yes` も無ければ、標準入力に `yes` が流れていても実行せずに断る
 * （例外＝非 0。何も変更しない）。以前は端末かどうかを見ずに標準入力から `yes` を
 * 読んでいたので、`echo yes | alteroid reset` が `--yes` 無しで通っていた。
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
  practices: number;
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

export async function resetCommand(
  options: { yes?: boolean } = {},
  io?: ConfirmIo,
): Promise<void> {
  // 「取り消せません」「取り消しました」は `confirmIrreversible` が出す（二重にしない）。
  if (!(await confirmIrreversible(buildConfirmMessage(), options, io))) return;

  const target = await resolveTarget();
  const view = (await post(target)) as { cleared: ResetSummary };
  report(view.cleared);
}

/**
 * 確認の文の並び。**`@alteroid/core` の `RESET_CONFIRM_GROUPS`
 * （`packages/core/src/workspace-reset.ts`）が正本——issue #2224 で、
 * ここ（CLI）にだけ在った一覧を `POST /reset` の OpenAPI description と
 * 共有できる形へ core 側へ寄せた。並び・語は1文字も変えていない。**
 *
 * 1つの日本語ラベルが複数の `ResetSummary` キーをまとめて指すことがある
 * （例: 「利用状況の台帳」が `usageDaily` / `usageBaseline` / `usageLedger` /
 * `usageTurns` / `sessionLog` をまとめて指す。「継続中の依頼」が `schedules` /
 * `schedulePhases` をまとめて指す）。
 *
 * **`confirm-coverage.test.ts` 相当の歯（`reset.test.ts` 内）が、
 * `SUMMARY_LABELS` の全キーがどこかの group に載っていることを測る。** 新しい
 * キーを `ResetSummary` / `SUMMARY_LABELS` へ足したのに、core 側の一覧へ
 * 足し忘れるとその歯が落ちる——issue #2196 で `practices` を消した後の報告に
 * だけ足して確認の文に足し忘れたのが、まさにこの抜けである（core 側の
 * `workspace-reset.test.ts` にも、`WorkspaceResetSummary` の全キーを覆っている
 * ことを測る同種の歯を置いてある）。
 */
const CONFIRM_GROUPS = RESET_CONFIRM_GROUPS;

/** テスト（`reset.test.ts`）が group と `SUMMARY_LABELS` の対応を検算するために読む。 */
export const RESET_CONFIRM_GROUPS_FOR_TEST = CONFIRM_GROUPS;

/**
 * 確認の文（何が消えるか）。`confirmIrreversible` の `summary` に渡す。テストから直接読める。
 * 末尾の改行と「取り消せません。」は `confirmIrreversible` が足すので、ここには持たない。
 */
export function buildConfirmMessage(): string {
  const list = CONFIRM_GROUPS.map((group) => group.label).join('・');
  return (
    '本当に削除しますか？\n' +
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
  ['sessionLog', 'セッションの生ログ'],
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
    if (typeof body.error === 'string') throw new Error(redactError(body.error));
    throw new Error(`/reset が失敗しました (${String(response.status)})`);
  }
  return response.json();
}
