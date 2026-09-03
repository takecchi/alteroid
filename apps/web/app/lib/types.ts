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
 * 握り潰しの跡（`GET /dropped`）。CLI（`alteroid dropped`）・クローンの MCP
 * 道具 `self_dropped` と同じ帳面を読む（`packages/core/src/dropped-record.ts`）。
 *
 * **`origin` は `apps/web/app/routes/dropped.tsx` が字面を複製している**
 * （`apps/web` は `@alteroid/core` の値 import が禁止されているため）。
 */
export type DroppedState = Ok<paths['/dropped']['get']>;
