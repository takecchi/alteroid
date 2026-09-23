/**
 * 画面が使う型。**すべて生成 spec から導出する。**
 *
 * 手で書き写した型を置くと `apps/daemon/openapi.json` と二重管理になり、必ずずれる
 * （api-client がそうしないのと同じ理由）。経路が変われば、ここが壊れて気づく。
 */
import type { JournalEntry, paths } from '@alteroid/api-client';

type Json<T> = T extends { content: { 'application/json': infer B } } ? B : never;
type Ok<T> = T extends { responses: { 200: infer R } } ? Json<R> : never;

export type { ChatStreamEvent, JournalEntry } from '@alteroid/api-client';

export type JournalEntryType = JournalEntry['type'];

export type ManagerSummary = Ok<paths['/managers']['get']>['managers'][number];
export type ManagerStatus = ManagerSummary['status'];
/**
 * 確認へ上がらず止められた道具と件数。
 *
 * **`denials` が無いのと `[]` は別である。** spec 上 optional なのは「拒否を観測
 * していない」を「0 件だった」と読ませないためで、画面もその区別を潰さない
 * （無いときは何も描かない）。
 */
export type ManagerDenial = NonNullable<ManagerSummary['denials']>[number];

export type PendingApproval = Ok<paths['/approvals']['get']>['approvals'][number];

/**
 * 引き受けたまま終わっていない仕事の台帳の1行（`GET /commitments`）。
 *
 * **`respondedAt`（issue #1003）を含む。** サーバ（`apps/daemon/src/openapi.ts`
 * の `commitmentListResponseSchema`）が `commitmentSchema` へ `updatedAt` /
 * `respondedAt` を加算した形で返すので、ここも生成 spec からそのまま導く
 * ——手で複製すると、サーバ側の形が変わったときに画面側だけ古いまま残り、
 * かつ「古いままである」ことがどこにも現れない（この文書の冒頭が言う
 * 二重管理そのもの）。
 */
export type Commitment = Ok<paths['/commitments']['get']>['entries'][number];
/**
 * 台帳の行が読めなかったもの（issue #296）。「無い」でも「片付いた」でもない
 * 第3の状態——`GET /commitments` の `unreadable` をそのまま導く。
 */
export type UnreadableCommitment = Ok<paths['/commitments']['get']>['unreadable'][number];

/**
 * まとめて答えたときの1件ぶんの結果（`POST /approvals/answer`）。
 *
 * **1件が駄目でも残りは進む設計なので、`ok` を畳んで成功件数だけにしない。**
 * どの id が通らなかったかが見えないと、まとめて送った瞬間に取りこぼしが
 * 静かに起きる。
 */
export type ApprovalAnswerResult = Ok<paths['/approvals/answer']['post']>['results'][number];

export type DailyReport = Ok<paths['/reports']['get']>['reports'][number];

export type ScheduleEntry = Ok<paths['/schedule']['get']>['entries'][number];
/**
 * 周期そのもの（#496）。仕込まれた依頼だけが持つので `entry.spec` は
 * optional — 編集画面はここが無いデーモン（この画面より古い版）と話すことが
 * あるので、`undefined` を握り潰さないこと（`schedule.tsx` の doc）。
 */
export type ScheduleSpec = NonNullable<ScheduleEntry['spec']>;

export type MemorySummary = Ok<paths['/memory']['get']>['documents'][number];
export type MemoryDocument = Ok<paths['/memory/{slug}']['get']>['document'];

/**
 * 仕事のやり方（#1055 段3③）。`PracticeStore` の3入口（クローンの道具・
 * HTTP・Web UI）のうち、これは Web UI 側が使う型——サーバの
 * `practiceMetaSchema` / `practiceSchema`（`packages/core/src/schema.ts`）から
 * 生成 spec 経由で導く。手で複製しない（この冒頭の doc と同じ理由）。
 */
export type PracticeSummary = Ok<paths['/practices']['get']>['practices'][number];
export type Practice = Ok<paths['/practices/{slug}']['get']>['practice'];

export type ConversationSummary = Ok<paths['/conversations']['get']>['conversations'][number];
export type ConversationDetail = Ok<paths['/conversations/{id}']['get']>;
export type ConversationMessage = ConversationDetail['messages'][number];

export type RunnerSummary = Ok<paths['/runners']['get']>['runners'][number];
/**
 * デーモン自身の版。**runner の版（`RunnerSummary['revision']`）とは状態の数が違う。**
 *
 * こちらは2値（`known` / `unknown`）で、`unheard`（名乗りをまだ聞けていない）が
 * 無い——自分のことなので訊きに行く経路がそもそも無い
 * （`packages/core/src/manager.ts` の `RunnerFleetOverview.daemonRevision`）。
 */
export type DaemonRevision = Ok<paths['/runners']['get']>['daemonRevision'];

/**
 * runner ごとの押し込み（push）の直近結果（`RunnerSummary['pushHealth']`）。
 *
 * **`profile` / `credentials` / `agentToken` は独立の3欄。**1つの成否へ畳まない
 * （`packages/core/src/manager.ts` の `RunnerPushHealth` の doc）。**`pushHealth`
 * 自体が無い行もある**——一度も押し込みを試みていない runner で、`{}` のような
 * 値を作らず欄そのものが無い（AGENTS.md「取れない軸に0の行を作らない」）。
 */
export type RunnerPushHealth = NonNullable<RunnerSummary['pushHealth']>;
export type RunnerPushOutcome = NonNullable<RunnerPushHealth['profile']>;

export type Health = Ok<paths['/health']['get']>;

/**
 * 利用状況。**`rows` / `since` / `layersSince` / `beforeLedger` / `beforeLayers` /
 * `notice` を1つも落とさないこと。**
 *
 * 台帳が無かった期間を 0 に見せない・まだ記録が無いのを $0.00 に見せない・層と
 * 場所が既定値でしかない期間を観測に見せない。どれも、これらを画面が読んで初めて
 * 言える（`apps/cli/src/usage.ts` と同じ形）。
 */
export type UsageAggregate = Ok<paths['/usage']['get']>;
export type UsageRow = UsageAggregate['rows'][number];
/**
 * 「起きた回数」の行。**`model` を鍵に持たない別会計**
 * （`@alteroid/core` の `usageTurnRowSchema` の doc）。
 */
export type UsageTurnRow = UsageAggregate['turnRows'][number];
/**
 * 層と場所の値。**API の型から導く**（画面に書き写さない）。
 * 選択肢の並びは `@alteroid/core/usage` の `USAGE_LAYERS` / `USAGE_SITES` が持つ。
 */
export type UsageLayer = UsageRow['layer'];
export type UsageSite = UsageRow['site'];
/**
 * アカウント全体の残り（claude.ai 側の値）。**台帳と混ぜない。**
 *
 * `state` が `ok` 以外は「取れなかった」であって「0」ではない。その区別は
 * この型が持っている（`unknown` / `failed` / `unavailable` / `ok` の4つ）ので、
 * 画面で `null` へ潰さないこと。
 */
export type AccountUsageState = UsageAggregate['account'];
/**
 * 台帳に1行も無い委譲（Issue #98）。**全期間で判定する**——`from` / `to` などの
 * 絞り込みには影響されない（`apps/daemon/src/openapi.ts` の
 * `unrecordedManagerSchema` の doc）。
 */
export type UnrecordedManager = UsageAggregate['unrecordedManagers'][number];

/**
 * 認証トークンのプールと、回す契機・冷却の設定（`GET /tokens`）。
 *
 * **`value`（本体）は型に無い。** サーバ側（`AgentTokenView`）が最初から
 * 持たない列なので、画面側で「消し忘れて出す」形がそもそも作れない。
 */
export type TokensState = Ok<paths['/tokens']['get']>;
export type AgentTokenView = TokensState['tokens'][number];
export type TokenRotationSettings = TokensState['settings'];
/** `disabled` > `invalidated` > `cooling` > `ready` の4値。3値に潰さないこと。 */
export type TokenAvailability = 'disabled' | 'invalidated' | 'cooling' | 'ready';
/**
 * 拒否の文言が時間で戻るか（`time` / `action` / `unknown`）。
 *
 * `lastRejectedReason` が無い行にはこの項目自体が無い——「拒否されていない」と
 * 「拒否されたが分類できない（`unknown`）」を同じ表示に潰さないこと
 * （`.claude/skills/token-pool/SKILL.md`）。
 */
export type TokenRecovery = NonNullable<AgentTokenView['recovery']>;
/** 日誌の `token_rotation` 種別1件。`event` の5値を潰さずに読むこと。 */
export type TokenRotationEntry = Extract<JournalEntry, { type: 'token_rotation' }>;

/**
 * ログインしたアカウントと許可の一覧（`GET /access`）。CLI の
 * `alteroid access list` と同じもの。
 *
 * **`apps/web/app/routes/access.tsx` は読み取り専用**——`grant` / `revoke`
 * はこの画面には無い（Issue #213。理由はその画面の doc）。
 */
export type AccessState = Ok<paths['/access']['get']>;
export type AccessAccount = AccessState['accounts'][number];

/**
 * 環境変数の袋（`GET /credentials`。旧「マネージャーへ降ろす環境変数」）。
 *
 * **`value` は `secret === false` の行だけに載る。** サーバ側（`credentialsResponseSchema`）
 * が secret な行では欄自体を返さないので、画面側で「消し忘れて出す」形は作れない。
 */
export type CredentialsState = Ok<paths['/credentials']['get']>;
export type EnvVarView = CredentialsState['credentials'][number];
/** 撒く先。`'all'`=共通 / `'app'`=clone だけ / `'runner'`=manager だけ。 */
export type EnvVarScope = EnvVarView['scope'];

/**
 * 握り潰しの跡（`GET /dropped`）。CLI（`alteroid dropped`）・クローンの MCP
 * 道具 `self_dropped` と同じ帳面を読む（`packages/core/src/dropped-record.ts`）。
 *
 * **`origin` は `apps/web/app/routes/dropped.tsx` が字面を複製している**
 * （`apps/web` は `@alteroid/core` の値 import が禁止されているため）。
 */
export type DroppedState = Ok<paths['/dropped']['get']>;

/**
 * セッション生ログの退避（`GET /archive`）。可観測性の最下段——CLI の
 * `/archive` / `/archive <id>` / `/archive sessions` / `/archive remove <id>`
 * と同じ口（#698 / #776）。
 */
export type ArchiveListState = Ok<paths['/archive']['get']>;
export type ArchiveEntry = ArchiveListState['entries'][number];
export type ArchiveSessionsState = Ok<paths['/archive/sessions']['get']>;
export type ArchiveSessionSummary = ArchiveSessionsState['sessions'][number];
/**
 * `DELETE /archive/:id` が消せたときの応答。**走行中のマネージャーの退避を
 * override で消したときだけ `override` が載る**（`archiveRemoveResponseSchema`
 * の doc）。
 */
export type ArchiveRemoveResult = Ok<paths['/archive/{id}']['delete']>;

/**
 * 受信箱（`inbox_events`）の絞り込み一括削除（`POST /inbox/remove`。issue #972）。
 * CLI の `alteroid inbox remove` と同じ口——人間の入口なので、クローンの道具
 * `inbox_remove_many` が構造的に除く `human_message` / `human_answer` も含めて
 * 7種類すべてを選べる（`apps/daemon/src/openapi.ts` の
 * `inboxRemoveManyRequestSchema` の doc）。
 */
export type InboxRemoveManyRequestBody = NonNullable<
  paths['/inbox/remove']['post']['requestBody']
>['content']['application/json'];
/** `types` に渡せる7種類（`InboxEvent['type']` と同じ）。 */
export type InboxEventType = InboxRemoveManyRequestBody['types'][number];
export type InboxRemoveManyResult = Ok<paths['/inbox/remove']['post']>;

/**
 * 受信箱の滞留の内訳（`GET /inbox`。issue #783 段0）。クローンの道具
 * `manager_list` の中にしか出ていなかった内訳を、人間の入口（Web UI）から
 * 読む——`@alteroid/core` の `InboxBacklogBreakdown` を JSON へ写したもの
 * （`apps/daemon/src/openapi.ts` の `inboxBacklogResponseSchema`）。
 */
export type InboxBacklog = Ok<paths['/inbox']['get']>;
