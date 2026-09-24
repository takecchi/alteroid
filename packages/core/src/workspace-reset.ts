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
