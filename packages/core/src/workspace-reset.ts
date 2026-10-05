import type { Stores } from './store.js';

/**
 * ワークスペースのリセット — 「トークン情報以外を全部消す」の唯一の正本。
 *
 * **由来**: takeaki.kobayashi さんの依頼で、本番（Railway、`alteroid` プロジェクト）
 * の Postgres に対して1度、`railway connect Postgres` 経由で手作業の
 * `TRUNCATE` を行った（2026-09-14）。ここはその「同条件」を alteroid 自身の
 * 機能として持たせたもので、消す範囲・残す範囲はそのときの人間の決定と同じに
 * してある。
 *
 * ## 何を残すか（`Stores` のうち触らない3つ）
 *
 * - `stores.tokens`（Claude Code の認証トークンのプール）
 * - `stores.credentials`（マネージャーへ降ろす環境変数の正本。GH_TOKEN 等）
 * - `stores.auth`（Web UI のログインアカウント・アクセストークン）
 *
 * **これは「reset の対象を選ぶ設定」ではなく、この関数の本体そのものである。**
 * 呼び出し側（`apps/daemon` の `POST /reset`）はこの3つのフィールドに触れる
 * 手段を持たない——選べる形にすると、CLI と Web UI とで「何が消えるか」が
 * ずれる余地が生まれる。1箇所（ここ）だけが「何を消すか」を知っていて、
 * 呼び出し側は「消せ」と言うだけである。
 *
 * ## 何を消すか（残り11ストア）
 *
 * `persona`（記憶） / `journal`（日誌） / `jobs`（ジョブ・承認待ち） /
 * `schedules`（継続中の依頼・既定の仕込みの位相） / `inbox`（受信箱） /
 * `commitments`（引き受けたまま終わっていない仕事） / `practices`（仕事の
 * やり方。#1055 段3） / `archive`（セッション
 * 生ログの退避先） / `sessions`（`SessionRegistry`。クローンのセッション id・
 * 墓標） / `profile`（実行環境プロファイル） / `usage`（利用状況の台帳）。
 *
 * ## ⚠️ まだ決めていないもの: `mcpServers`（人間の MCP 連携の登録。#325 段1）
 *
 * **いまは消さない（上の3つと同じく触らない）。** 2026-09-14 の決定は「トークン
 * 情報以外を全部消す」で、登録は `env` / `headers` に鍵を持ちうる**接続の設定**
 * —— `credentials` に近いが、`profile`（消す側）にも近い。どちらへ倒すかは人間の
 * 判断であり、消す側へ倒すなら `WorkspaceResetSummary` に欄を足し、CLI・Web UI の
 * 表示（`reset-summary-shape.test.ts` が突き合わせる）まで同じ PR で揃えること。
 *
 * pg 構成では、これに加えて SDK が使う生ログの預け先（`session_entries` /
 * `sessions` テーブル。fs 構成には無い）も消える——`options.clearSessionLog`
 * を渡した場合のみ（`apps/daemon/src/storage.ts` の doc）。
 */
export interface WorkspaceResetSummary {
  memory: number;
  journal: number;
  jobs: number;
  approvals: number;
  schedules: number;
  schedulePhases: number;
  inbox: number;
  commitments: number;
  /**
   * 消したやり方の件数（#1055 段3）。
   *
   * **消したのに申告へ出ない形を作らないこと。** リセットで静かに消える器が
   * 1つでもあると、`WorkspaceResetSummary` は「何が消えたか」の正本でなくなる。
   */
  practices: number;
  archive: number;
  sessions: number;
  profile: number;
  usageDaily: number;
  usageBaseline: number;
  usageLedger: number;
  usageTurns: number;
  /**
   * SDK のセッション生ログ（`session_entries` / `sessions` テーブル）を
   * 消した件数。**pg 構成でだけ付く** — fs 構成では SDK 自身がローカル
   * ディスクへ直接書いており、`Stores` から触れる預け先そのものが無い
   * （`Stores.sessionStore` の doc「pg 構成でだけ付く」と同じ非対称）。
   */
  sessionLog?: number;
}

/**
 * 確認の文の並び。**CLI の対話確認（`apps/cli/src/reset.ts` の
 * `buildConfirmMessage`）と `POST /reset` の OpenAPI description
 * （`apps/daemon/src/app.ts`）の両方が、ここから組み立てる**（issue #2224 で
 * 1か所に寄せた——元は `apps/cli/src/reset.ts` の `CONFIRM_GROUPS` として
 * issue #2196／#2199 で作られたもので、内容・順序は1文字も変えていない）。
 *
 * 1つの日本語ラベルが複数の `WorkspaceResetSummary` キーをまとめて指すことが
 * ある（例: 「利用状況の台帳」が `usageDaily` / `usageBaseline` / `usageLedger` /
 * `usageTurns` / `sessionLog` をまとめて指す。「継続中の依頼」が `schedules` /
 * `schedulePhases` をまとめて指す）。
 *
 * **`workspace-reset.test.ts` の網羅の歯が、この一覧の keys が
 * `WorkspaceResetSummary` の全キーを重複や漏れ無く覆っていることを測る。**
 * 新しいストアを足したのに、ここへ足し忘れるとその歯が落ちる——issue #2196
 * で `practices` を足した後、確認の文にだけ足し忘れたのがまさにこの抜けである
 * （issue #2224 は同じ抜けの3か所目、`POST /reset` の description で見つかった。
 * `apps/cli/src/reset.ts` と `apps/web/app/routes/settings.tsx` の2か所は
 * #2199 で直っている）。
 *
 * **`apps/cli/src/reset.test.ts` の既存の歯が、CLI の確認の文（見出しの並び・
 * 語そのもの）を1文字も変えていないことを固定する。**
 */
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

/**
 * `RESET_CONFIRM_GROUPS` のラベルを「・」区切りで並べた文字列。
 * `POST /reset` の OpenAPI description（`apps/daemon/src/app.ts`）が使う——
 * CLI の確認の文（`buildConfirmMessage`）と同じ並び・同じ語になる。
 */
export function describeResetTargets(): string {
  return RESET_CONFIRM_GROUPS.map((group) => group.label).join('・');
}

export interface ResetWorkspaceStateOptions {
  /**
   * pg 構成でだけ渡す。`PgSessionStore#clearAll()` を渡し値として使う想定
   * （`apps/daemon/src/storage.ts` の `Storage.clearSessionLog` の doc）。
   */
  clearSessionLog?: () => Promise<number>;
}

/**
 * `stores` のうち `tokens` / `credentials` / `auth` を除く全部を空にする。
 *
 * **呼び出す順序に意味は無い**（各ストアの `clear()` は独立している——
 * 相互に参照する外部キーの類を持たない）。1つが失敗すれば例外がそのまま
 * 上へ抜け、それ以降のストアには触れない——「途中まで消えた」状態を
 * `WorkspaceResetSummary` として申告することはできないので、呼び出し側
 * （HTTP の口）は例外を握り潰さず、そのまま 500 として返すこと。
 */
export async function resetWorkspaceState(
  stores: Stores,
  options: ResetWorkspaceStateOptions = {},
): Promise<WorkspaceResetSummary> {
  const memory = await stores.persona.clear();
  const journal = await stores.journal.clear();
  // 会話の既読の索引は日誌の写し。日誌が消えたら写しも消す（位置と基準時刻は残す）。
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
