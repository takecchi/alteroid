import { z } from 'zod';

import type { AnsweredViaLike } from './answered-via.js';
import type { CgroupEventsDeltaLike } from './cgroup-events-format.js';
import { cgroupEventsDeltaSchema, type CgroupEventsDelta } from './cgroup-events.js';
import { CRON_EXPRESSION_MAX, isCronExpression } from './cron.js';
import type { JobStatusLike } from './job-status-running.js';
import type { JournalDiagnosticsEntryLike } from './journal-diagnostics-format.js';
import { stripNul } from './nul-guard.js';
import type { SystemErrorFactsLike } from './system-error-format.js';
import { systemErrorFactsSchema, type SystemErrorFacts } from './system-error.js';
import type { TraceActionLike } from './trace-action.js';
import type {
  UnpushedWorkObservationIncompletenessLike,
  UnpushedWorkObservationSourceLike,
} from './unpushed-work-observation-format.js';
// 書き写さず `usage.js` から読む: 日誌の `turn_usage.layer` / `.site` / `.models` は台帳（`UsageStore`）の同名の列と同じ値であるべきなため
import { MEMORY_SLUG_RULE, PRACTICE_SLUG_RULE } from './slug-rule.js';
import { usageLayerSchema, usageSiteSchema, usageTotalsSchema } from './usage.js';

const isoDateTime = z.string().datetime({ offset: true });

export const memorySlugSchema = z
  .string()
  .min(1)
  .max(MEMORY_SLUG_RULE.maxLength)
  .regex(MEMORY_SLUG_RULE.pattern, MEMORY_SLUG_RULE.message);

export const memoryFrontmatterStateSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('none') }),
  // `none` に畳まない: 人間が textarea で編集する以上 frontmatter は壊れ、壊れたときに文書ごと記憶から消えるのが最悪の形なため
  z.object({ kind: z.literal('malformed') }),
  z.object({
    kind: z.literal('parsed'),
    description: z.string().optional(),
    type: z.string().optional(),
    parent: z.string().optional(),
  }),
]);
export type MemoryFrontmatterState = z.infer<typeof memoryFrontmatterStateSchema>;

// `fact` や `indexed` を既定にしない: 区分の判定を誤ると文書が黙って縮み、クローンが気づけないため
export const memoryDocKindSchema = z.enum(['premise', 'fact', 'indexed']);
export type MemoryDocKind = z.infer<typeof memoryDocKindSchema>;

export const memoryDescriptionDriftSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('measured'),
    describedBytes: z.number().int().nonnegative(),
    currentBytes: z.number().int().nonnegative(),
    // 符号つきにする: 本文が縮んだ文書を「変わっていない」と混ぜないため
    deltaBytes: z.number().int(),
  }),
  z.object({
    kind: z.literal('at-least'),
    // `measured` と同じ言葉で語らない: 基準点は「要旨を書いた時点」ではなく書き込みの直前の値で、真の変化量は下限でしか言えないため
    baselineBytes: z.number().int().nonnegative(),
    // 表示側では刷らない: クローンのプロンプトへ毎ターン焼かれ、恒久的なトークン肥大化になるため
    baselineAt: isoDateTime,
    currentBytes: z.number().int().nonnegative(),
    deltaBytes: z.number().int(),
  }),
  // `deltaBytes: 0` と同じ言葉にしない: 「取れなかった」を「変化なし」に見せると欠測が「手を入れなくてよい」側に化けるため
  z.object({ kind: z.literal('unrecorded') }),
]);
export type MemoryDescriptionDrift = z.infer<typeof memoryDescriptionDriftSchema>;

export const memoryDescriptionFreshnessSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('fresh') }),
  z.object({
    kind: z.literal('stale'),
    // 閾値で `stale` / `fresh` を切り直さない: 根拠の無い閾値は同じ「常時真」をその閾値の内側で作り直すだけなため
    staleForMs: z.number().int().nonnegative(),
    drift: memoryDescriptionDriftSchema,
  }),
  // `fresh` にも `stale` にも畳まない: 畳むと、索引を失った瞬間に「全部新鮮」か「全部古い」の嘘になるため
  z.object({ kind: z.literal('unknown') }),
  z.object({ kind: z.literal('absent') }),
]);
export type MemoryDescriptionFreshness = z.infer<typeof memoryDescriptionFreshnessSchema>;

export const memoryCreatedAtSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('known'), at: isoDateTime }),
  // `reason` を持たせない: 分からない理由は「日誌にその slug の `memory_update` が無い」の1つだけなため
  z.object({ kind: z.literal('unknown') }),
]);
export type MemoryCreatedAt = z.infer<typeof memoryCreatedAtSchema>;

export const memoryDocumentMetaSchema = z.object({
  slug: memorySlugSchema,
  title: z.string(),
  updatedAt: isoDateTime,
  // `mtime` / `birthtime` から作成時刻を作らない: 作成を観測していない文書の時刻を捏造することになるため
  createdAt: memoryCreatedAtSchema,
  bytes: z.number().int().nonnegative(),
  frontmatter: memoryFrontmatterStateSchema,
  kind: memoryDocKindSchema,
  description: z.string().optional(),
  parent: z.string().optional(),
  descriptionFreshness: memoryDescriptionFreshnessSchema,
});

export const memoryDocumentSchema = memoryDocumentMetaSchema.extend({
  content: z.string(),
});

export type MemorySlug = z.infer<typeof memorySlugSchema>;
export type MemoryDocumentMeta = z.infer<typeof memoryDocumentMetaSchema>;
export type MemoryDocument = z.infer<typeof memoryDocumentSchema>;

// `unknown` を `clone-only` に畳まない: 履歴を失った瞬間に「人間は書いていない」という嘘になるため
export type MemoryProtectionStatus =
  { kind: 'human' } | { kind: 'clone-only' } | { kind: 'unknown' };

// 確信が無い箇所には `'markdown'` も `'none'` も立てず `undefined` のままにする: 取れない軸に値を作ることになるため
export const textMarkupSchema = z.enum(['markdown', 'none']);
export type TextMarkup = z.infer<typeof textMarkupSchema>;

// ここ（ファイル冒頭寄り）へ置く: `inboxEventSchema` の `human_answer` が使うので、後方の宣言を先に参照すると TDZ で落ちるため
export const answeredViaSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('operator'), auth: z.enum(['disabled', 'operator-token']) }),
  z.object({ kind: z.literal('account'), accountId: z.string() }),
]);

export type AnsweredVia = z.infer<typeof answeredViaSchema>;

export { describeAnsweredVia } from './answered-via.js';

type AssertTrue<T extends true> = T;

// `AnsweredVia` をそのまま使わず手で写す: 軽い口（`answered-via.ts`）は zod を import できないため
export type _AssertAnsweredViaMatchesLikeType = AssertTrue<
  [AnsweredVia] extends [AnsweredViaLike]
    ? [AnsweredViaLike] extends [AnsweredVia]
      ? true
      : false
    : false
>;

export const approvalOptionSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  description: z.string().optional(),
  recommended: z.boolean().optional(),
});

export type ApprovalOption = z.infer<typeof approvalOptionSchema>;

export const approvalQuestionSchema = z.object({
  id: z.string().min(1),
  prompt: z.string().min(1),
  options: z.array(approvalOptionSchema).min(1),
  multiple: z.boolean().optional(),
  allowOther: z.boolean().optional(),
});

export type ApprovalQuestion = z.infer<typeof approvalQuestionSchema>;

export const approvalSelectionSchema = z.object({
  questionId: z.string().min(1),
  optionIds: z.array(z.string().min(1)),
  other: z.string().optional(),
});

export type ApprovalSelection = z.infer<typeof approvalSelectionSchema>;

export const clientMessageIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,128}$/, 'clientMessageId は英数字・_ - の1〜128字');

// 中身（bytes）は持たない: 中身は `stores.attachments` に在り、受信箱・日誌・記憶のどこにも書かないため
export const attachmentRefSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  mediaType: z.string(),
  size: z.number().int().nonnegative(),
  sha256: z.string(),
});

export type AttachmentRef = z.infer<typeof attachmentRefSchema>;

export const inboxEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('human_message'),
    id: z.string(),
    at: isoDateTime,
    text: z.string(),
    conversationId: z.string(),
    // 受信箱と日誌の両方に持たせる: どちらか片方だけが知っている状態を作らないため
    supersedes: z.string().optional(),
    attachments: z.array(attachmentRefSchema).optional(),
    clientMessageId: z.string().optional(),
  }),
  z.object({
    type: z.literal('human_answer'),
    id: z.string(),
    at: isoDateTime,
    approvalId: z.string(),
    answer: z.string(),
    selections: z.array(approvalSelectionSchema).optional(),
    conversationId: z.string().optional(),
    answeredVia: answeredViaSchema.optional(),
  }),
  z.object({
    type: z.literal('distill'),
    id: z.string(),
    at: isoDateTime,
    reason: z.enum(['conversation_end', 'shutdown', 'scheduled']),
  }),
  z.object({
    type: z.literal('timer'),
    id: z.string(),
    at: isoDateTime,
    kind: z.string(),
    // 発火時刻から逆算させない: デーモンが止まっていた日の日報を後から作るとき、発火時刻はその日ではないため
    target: z.string().optional(),
    // `manual` で定期の予定の基準を動かさない: 受け取った側が基準を手動実行の時刻へ動かすと、再起動後に位相がずれるため
    cause: z.enum(['schedule', 'schedule_catchup', 'manual']).optional(),
    heldForUsage: z.boolean().optional(),
  }),
  z.object({
    type: z.literal('external'),
    id: z.string(),
    at: isoDateTime,
    source: z.string(),
    payload: z.unknown().optional(),
    // `payload` 丸ごとを畳み込みの鍵にしない: 同じ出来事でも畳んだ件数が違うだけで別の鍵になり、畳み込みが効かなくなるため
    identity: z.string().optional(),
    via: z.object({ keyId: z.string(), name: z.string() }).optional(),
    attachments: z.array(attachmentRefSchema).optional(),
  }),
  z.object({
    type: z.literal('self_initiative'),
    id: z.string(),
    at: isoDateTime,
    reason: z.string(),
    cause: z.enum(['schedule', 'schedule_catchup', 'manual']).optional(),
  }),
  z.object({
    type: z.literal('manager_message'),
    id: z.string(),
    at: isoDateTime,
    managerId: z.string(),
    kind: z.enum(['report', 'question', 'permission']),
    text: z.string(),
    requestId: z.string().optional(),
    // 欄そのものには `z.enum` を置かない: 未知の値が1つ入るだけで台帳の一覧が丸ごと落ちるため（書き込み側は `TextMarkup` の型で縛る）
    markup: z.string().optional(),
    // `status` という名前にしない: 合図が作られた時点ではなく配る瞬間の値で、同じ名前だと読む側が「合図が名乗った値」として照合に誤用するため
    // `z.lazy` で包む: `jobStatusSchema` は下で定義されており、直接参照すると TDZ の `ReferenceError` になるため
    // 配り直しでも新しい値に差し替えない: `#restoreUnread` は積まれた当時の値のまま残り、issue #879 の述語がその差を使っているため
    statusAtDelivery: z.lazy(() => jobStatusSchema).optional(),
    synthesized: z.literal(true).optional(),
    // 本文の文言で判定しない: 判定は構造化された印で行い、文言は表示にだけ使うため（立っていない回はキーごと書かない）
    foldedTurn: z.literal(true).optional(),
  }),
]);

export type InboxEvent = z.infer<typeof inboxEventSchema>;
export type InboxEventType = InboxEvent['type'];

// 本文（`event` の中身）を載せない: 人間の発言がそのまま入りうるため
export const unreadableInboxEventSchema = z.object({
  id: z.string().optional(),
  at: z.string().optional(),
  reason: z.string(),
});
export type UnreadableInboxEvent = z.infer<typeof unreadableInboxEventSchema>;

// `inboxEventSchema` の判別子を手で列挙する: 機械的に導出すると `InboxEvent['type']` との対応を静的に保証できないため
const inboxFlowByTypeCountSchema = z.object({
  total: z.number().int().nonnegative(),
  byType: z.array(
    z.object({
      type: z.enum([
        'human_message',
        'human_answer',
        'distill',
        'timer',
        'external',
        'self_initiative',
        'manager_message',
      ]) satisfies z.ZodType<InboxEvent['type']>,
      count: z.number().int().nonnegative(),
    }),
  ),
});

export const contextUsageObservationSchema = z.object({
  durationMs: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative().optional(),
  rawMaxTokens: z.number().int().nonnegative().optional(),
  percentage: z.number().nonnegative().optional(),
  autoCompactThreshold: z.number().nonnegative().optional(),
  isAutoCompactEnabled: z.boolean().optional(),
  // > [sdk-verbatim Query.getContextUsage]
  // > `detail: 'full'` counts each category with the token-count API;
  // > [sdk-verbatim SDKControlGetContextUsageResponse.categories]
  // > without the per-category token-count calls. Defaults to `'full'`.
  // 件数に上限を持つ: 版が上がって軸が増えたとき、日誌の1行が黙って伸びないため
  categories: z
    .array(
      z.object({
        // `name` で分類しない: SDK の表示名は版が上がれば変わり、変わっても赤くならないため
        name: z.string(),
        tokens: z.number().int().nonnegative(),
        // > [sdk-verbatim SDKControlGetContextUsageResponse.categories.kind]
        // > Classify on this, never on the English name.
        // `.optional()` にして `default` で埋めない: この欄が増える前に書かれた `turn_usage` の行が読み出しで落ちるため、無いことは「観測していない」であって「`used` だった」ではない
        // `z.enum` にしない: SDK が `kind` を足すと書き込み時の `parse` が例外を投げ、`turn_usage` の行そのものが書けなくなるため
        kind: z.string().optional(),
      }),
    )
    .optional(),
  categoriesOmitted: z.number().int().positive().optional(),
  mcpToolTokens: z.number().int().nonnegative().optional(),
  mcpToolCount: z.number().int().nonnegative().optional(),
  memoryFileTokens: z.number().int().nonnegative().optional(),
  memoryFileCount: z.number().int().nonnegative().optional(),
  systemPromptTokens: z.number().int().nonnegative().optional(),
  systemPromptSectionCount: z.number().int().nonnegative().optional(),
  error: z.string().optional(),
});

export type ContextUsageObservation = z.infer<typeof contextUsageObservationSchema>;

export const journalEntrySchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('exchange'),
    id: z.string(),
    at: isoDateTime,
    with: z.enum(['human', 'manager', 'self']),
    role: z.enum(['inbound', 'outbound']),
    text: z.string(),
    conversationId: z.string().optional(),
    // `text` の先頭の `[managerId]` を機械が読む鍵にしない: 接頭辞の形は書き手ごとに違い、文言の変更で静かに壊れるため
    managerId: z.string().optional(),
    // 旧発言の行は消さず書き換えず、`supersedes` を持つ新しい `exchange` を追記する: 日誌は追記専用のため
    supersedes: z.string().optional(),
    // 中身（bytes）は日誌に書かない: メタデータだけを持つため
    attachments: z.array(attachmentRefSchema).optional(),
    clientMessageId: z.string().optional(),
    // 文面で照合しない: 文面を直した瞬間に黙って外れるため、印を付ける
    turnFailure: z.enum(['failed', 'held']).optional(),
    // `conversationId` では結ばない: 同じ会話で近接した時刻に複数の承認へ回答すると、どの outbound がどの承認への返答か見分けられないため
    approvalId: z.string().optional(),
    answeredApprovalId: z.string().optional(),
  }),
  z.object({
    type: z.literal('decision'),
    id: z.string(),
    at: isoDateTime,
    decision: z.string(),
    grounds: z.string(),
    answeredApprovalId: z.string().optional(),
  }),
  // `exchange` に混ぜず種別を分ける: 雑多入れだと `journal_read` の `types` で絞れず、クローンが出どころの混ざった中を漁ることになるため
  // 値（`value`）を入れない: 日誌は Web にもクローンにも流れるため
  z.object({
    type: z.literal('token_rotation'),
    id: z.string(),
    at: isoDateTime,
    // `event` の値を潰さない（数もここに書かない）: `not_rotated` と `exhausted`、`sweep_stopped` と `exhausted`、`reopened` と `recovered` は別の事実で、数え上げの持ち主は直下の `z.enum` のため
    event: z.enum([
      'rotated',
      'not_rotated',
      'exhausted',
      'restored',
      'restore_failed',
      'sweep_stopped',
      'parked',
      'recovered',
      'reopened',
    ]),
    signal: z
      .enum([
        'reached',
        'quota_rejected',
        'overage_closed',
        'entered_overage',
        'org_policy',
        'warning',
        'none',
        'stranded',
        'settings_unreadable',
      ])
      .optional(),
    // `signal` に畳まない: 「冷却が明けたので見直した」と「記録の上で現役が通らない」が同じ顔になるため
    reason: z
      .enum([
        'pool_changed',
        'settings_changed',
        'tick',
        'runner_connected',
        'account_probe',
        'startup',
        'turn_succeeded',
        'trial_succeeded',
      ])
      .optional(),
    // `unknown` を `stale` にしない: 身元を運べない検知点から来た観測のため
    freshness: z.enum(['current', 'stale', 'unknown']).optional(),
    tokenId: z.string().optional(),
    label: z.string().optional(),
    fromTokenId: z.string().optional(),
    generation: z.number().int().nonnegative().optional(),
    // 省略可能にする: 無いことと「すぐ戻る」を混ぜないため
    earliestAt: isoDateTime.optional(),
    // `default` で埋めない: 無いことは「推測ではない」ではなく、出所を持たない行（この欄を書かない版・以前の行）のため
    cooldownSource: z.enum(['quota_reset', 'overage_reset', 'notice_text', 'default']).optional(),
    recoveredSource: z.enum(['account_probe', 'turn_success']).optional(),
    noticeText: z.string().optional(),
    text: z.string(),
  }),
  // `exchange` に混ぜず種別を分ける: 雑多入れだと数えるのに自然文を正規表現で舐めるしかなくなるため
  // この種別が0件でも「空転が無かった」とは読まない: `SubagentStop` フックは作業者が畳んだ瞬間に親のターンが開いていたときにしか発火しないため
  z.object({
    type: z.literal('subagent_stall'),
    id: z.string(),
    at: isoDateTime,
    agentId: z.string(),
    agentType: z.string().optional(),
    ownedTaskCount: z.number().int().nonnegative(),
    sessionTaskCount: z.number().int().nonnegative(),
    wakeupCount: z.number().int().nonnegative(),
    // 2値を潰さない: `woken` はまだ進む見込みがある空転、`limit_reached` は自動では再開しない空転のため
    outcome: z.enum(['woken', 'limit_reached']),
    text: z.string(),
  }),
  z.object({
    type: z.literal('escalation'),
    id: z.string(),
    at: isoDateTime,
    question: z.string(),
    approvalId: z.string(),
    managerId: z.string().optional(),
    answeredAt: isoDateTime.optional(),
    answer: z.string().optional(),
    answeredVia: answeredViaSchema.optional(),
    // 行は消さず、終端は別の新しい行として積む: `commitment_close` と同じ形にするため
    withdrawnAt: isoDateTime.optional(),
    withdrawnReason: z.string().optional(),
  }),
  z.object({
    type: z.literal('tool_use'),
    id: z.string(),
    at: isoDateTime,
    // 層を `=== 'clone'` と書き写して数え上げない: 判定は `isCloneActor`（`usage.ts`）の1本だけで、書き写すとサブエージェントぶんが委譲した量の側へ落ちるため
    actor: z.string(),
    tool: z.string(),
    // `.optional()` を外さない: `input` は `undefined` でありうり、JSON 直列化でキーごと消えて、zod 4 は読み出しでキーの不在を `invalid_type` として日誌の行ごと落とすため（`runner-protocol.ts` 側の同名の欄と同時に緩めてある）
    input: z.unknown().optional(),
    // `failed` と `interrupted` を潰さない: 失敗は確定、中断はどこまで進んだか分からないで、監査の意味が違うため
    outcome: z.enum(['failed', 'interrupted']).optional(),
    // 書き込み側で切り詰める: 外部（道具・MCP サーバ）が書く無制限長の自由文のため
    error: z.string().optional(),
    answeredApprovalId: z.string().optional(),
  }),
  z.object({
    type: z.literal('memory_update'),
    id: z.string(),
    at: isoDateTime,
    slug: memorySlugSchema,
    /**
     * 蒸留・人間の直接編集・クローンの書き込みのどれか。
     *
     * - **`'distill'`** — 蒸留のターンが書いた。**本セッションの蒸留ターン
     *   （`conversation_end` / `shutdown`）と `pre_compact` のサイドクエリの
     *   両方を含む**（`clone.ts` の `#toolContext` / `#distillFromTranscript`
     *   の `memoryCause`）。
     * - **`'clone'`** — **本セッションのクローンが書いた**（蒸留のターンでは
     *   ない、人間の発言などに応じた通常のターン）。**この配線が入る前は
     *   「クローン層が書いた」の意味で蒸留も含んでいた。** `optional` にした
     *   `action` と同じ形の理由で、**既存のエントリは書き換えていない** —
     *   だからこの配線より前の `cause: 'clone'` エントリは、蒸留か通常の
     *   ターンかの区別を持たない。
     * - **`'human'`** — 人間が API / CLI から直接書いた。書いているのは
     *   `app.ts` の `PUT` / `DELETE /memory/:slug` の2箇所だけである。
     *
     * **この `cause: 'distill'` は台帳（`usage.ts`）の `site: 'distill'` と
     * 同じ軸ではない。** `site` は `query()` 呼び出しごとの軸で、
     * `usageSiteSchema` の doc が明言しているとおり `pre_compact` の
     * サイドクエリだけを指す（本セッションの蒸留ターンの消費は `site:
     * 'session'` に合算されて分離できない）。`cause` は本セッションの蒸留
     * ターンも含むので、**この2つを突き合わせて数えても一致しない**
     * （片方が壊れているわけではない）。
     */
    cause: z.enum(['distill', 'clone', 'human']),
    /**
     * 「書いた」か「消した」かの機械可読な区別。
     *
     * **`optional` にしてあるのは、既存の日誌エントリを1件も壊さないため。**
     * これが無いエントリは「この区別が導入される前の古いエントリ」を意味する
     * （PR #144 と同じ形 — 機械可読な面が持たない区別を自由文の `summary` だけに
     * 持たせると、日誌を辿って「消した記録」を数えたい側が文言に一致させる
     * しかなくなる）。**`summary` の自由文は削らない**（人が読む説明を減らす
     * ことと機械可読な区別を足すことは別である）。
     *
     * **`'describe'`** — `memory_frontmatter_set`（#318 案 (a)）が frontmatter
     * のキー（`description` / `type` / `parent`）だけを差し替えたときに書く。
     * **`'write'` に畳まない** — `write` に畳むと「本文を全文置換した」と
     * 「frontmatter のキーだけ直した」の区別が `summary` の自由文だけに
     * 落ち、ここまでの3値がそうしてきたのと同じ理由で数え上げにくくなる
     * （このコメント自身がその理由を書いている）。この値を読むのは3箇所
     * だけである——`deriveHumanTouchedAtFromJournal`（`memory.ts`。`remove`
     * だけ除外するので `describe` は対象に含まれる。`memory_frontmatter_set`
     * は `cause:'human'` を書ける経路ではないので実際には影響しない）、
     * `deriveMemoryCreatedAtFromJournal`（`memory.ts`。`write` だけを対象に
     * するので `describe` は自動で対象外——`memory_frontmatter_set` は
     * 文書を作らない口なので、これは正しい）、`dropped-record.ts`（文字列に
     * 混ぜるだけ）。網羅的に分岐する `switch` は無い。
     *
     * **`'move_in'` / `'move_out'`** — `memory_section_move`（#318 案 (b)）が
     * 節を1つ、別の文書へ移したときに書く。**1回の移動で2件のエントリが
     * 出る**（`memory_update` は slug ごとの記録なので、2文書が動けば2件で
     * ある）。移し先が `move_in`、出どころが `move_out`。
     *
     * - **`'write'` / `'remove'` に畳まない。** 畳むと「全文置換した」と
     *   「節を1つ移した」、「文書ごと消した」と「節を1つ出した」の区別が
     *   `summary` の自由文だけに落ちる（上の `describe` と同じ理由）
     * - **2つに分ける（`'move'` 1つにしない）。** 1つにすると、2件のうち
     *   どちらが「増えた側」でどちらが「減った側」かを `bytesBefore` /
     *   `bytesAfter` の大小から**推測する**ことになる。推測が要らない形に
     *   しておく（節が空に近ければ大小はほとんど動かない）
     * - **⚠️ `deriveMemoryCreatedAtFromJournal` は `write` だけを見るので、
     *   `move_in` で新しく生まれた文書の `createdAt` の根拠は日誌に残らない。
     *   それで足りる**——`createdAt` の**第一の出所は日誌ではなくストアの
     *   書き込み経路そのもの**であり（`PersonaStore.markCreatedAt` の doc:
     *   「`createdAt` の第一の出所はこのメソッドではない」）、3実装とも
     *   `append` が文書を作った瞬間に値を立てる（実装を引いて確かめた:
     *   `testing.ts` の `append` は `write` へ委譲し `before === undefined`
     *   で set、`storage-fs` の `append` は `#writeNow` へ委譲し
     *   `before === null` で set、`storage-pg` の `append` は
     *   `ON CONFLICT` の `set` に `created_at` を含めないので新規挿入時
     *   だけ入る）。`deriveMemoryCreatedAtFromJournal` が担うのは
     *   **その配線より前に作られた昔の行の後始末だけ**である
     * - `deriveHumanTouchedAtFromJournal` は `remove` 以外を含めるので
     *   `move_in` / `move_out` は対象に入るが、`memory_section_move` は
     *   `cause:'human'` を書ける経路ではないので実際には影響しない
     *   （`describe` と同じ）
     */
    action: z.enum(['write', 'append', 'remove', 'describe', 'move_in', 'move_out']).optional(),
    /**
     * 「どれだけ失ったか」の機械可読な面。バイト数（`Buffer.byteLength` 相当）。
     *
     * **`optional` にしてあるのは、既存の日誌エントリを1件も壊さないため**
     * （`action` と完全に同じ形・同じ理由）。これが無いエントリは「この区別が
     * 導入される前の古いエントリ」を意味する。
     *
     * **`memory_delete`（`action: 'remove'`）は既に文字数を `summary` の自由文
     * （「削除直前 N 文字」）へ埋め込んでいたが、機械可読な面には出ていなかった**
     * — `action` の doc が警告している形そのもの（PR #144 と同じ形 — 機械可読な
     * 面が持たない区別を自由文の `summary` だけに持たせると、日誌を辿って
     * 「どれだけ失ったか」を数えたい側が文言に一致させるしかなくなる）。
     * **`summary` の自由文からは既存の「（削除直前 N 文字）」を消さない** —
     * 人が読む説明を減らすことと機械可読な区別を足すことは別である。
     *
     * - `write`: 置き換え前の文書のバイト数（無ければ新規作成なので `0`）
     * - `append`: 追記前の文書のバイト数（無ければ `0`）
     * - `remove`: 消す直前のバイト数
     * - `describe`: frontmatter を差し替える前の文書のバイト数
     *   （`memory_frontmatter_set` は既存文書にしか使えないので、新規作成は
     *   起こらない）
     * - `move_in`: 節を足す前の移し先の文書のバイト数（無ければ `0`）
     * - `move_out`: 節を切り取る前の出どころの文書のバイト数
     */
    bytesBefore: z.number().int().nonnegative().optional(),
    /**
     * 書き込み後のバイト数。
     *
     * - `write` / `append`: 書き込み後の文書のバイト数
     * - `remove`: 常に `0`（実体が無くなるため）
     * - `move_in`: 節を足した後の移し先の文書のバイト数
     * - `move_out`: 節を切り取った後の出どころの文書のバイト数
     * - `describe`: frontmatter を差し替えた後の文書のバイト数
     */
    bytesAfter: z.number().int().nonnegative().optional(),
    summary: z.string(),
    /**
     * 承認への回答（`human_answer`）から起きたターンの中で書いた行なら、その
     * 承認の id（issue #847 の案B）。意味と読み方は `exchange.answeredApprovalId`
     * の doc に在る——ここに写さない。
     */
    answeredApprovalId: z.string().optional(),
  }),
  z.object({
    type: z.literal('daily_report'),
    id: z.string(),
    at: isoDateTime,
    date: z.string(),
    body: z.string(),
    /**
     * **この行は日報の代わりに置いた印であって、日報ではない。** 入っているのは
     * 「なぜ書けなかったか」である。
     *
     * ## なぜ印が必要か（印が無いと再試行が死ぬ）
     *
     * 日報を作るターンが上限で死ぬと、`clone.ts` の `#dailyReport` は本文なしで
     * 1件書いていた。その1件が**2か所で「日報がある日」として数えられる**:
     *
     * - `clone.ts` の `#dailyReport`（同じ日付の日報があれば早期 return）
     * - `schedule.ts` の `missingDailyReportDates`（起動時の後追いの対象から外す）
     *
     * 上限に当たった合図は保持され、枠が開いたら配り直される（`clone.ts` の
     * `#pump` の `finally`）。**つまり再試行は来る。** ところが来たときには
     * 代替文の行が既にあるので、どちらの経路も「もう書いた」と判断して
     * **本物の日報が永久に書かれない**。プレースホルダが再試行を殺していた。
     *
     * この印があると、人間には「その日に何かあった」ことが見えたまま、機構は
     * 「まだ書けていない」と数えられる。**両方を同時に満たす唯一の形**である
     * （書かなければ人間から消え、印なしで書けば再試行が死ぬ）。
     *
     * **`body` を空にして代用しないこと。** 空文字は「書けなかった」と
     * 「クローンが空文字を書いた」を区別しない。
     */
    unavailable: z.string().optional(),
  }),
  z.object({
    type: z.literal('external_event'),
    id: z.string(),
    at: isoDateTime,
    /** どこから届いたか（webhook の呼び出し元が名乗る名前）。 */
    source: z.string(),
    /** 連携の鍵経由で届いたとき、その鍵の id と名前（#3113）。鍵の値は書かない。 */
    via: z.object({ keyId: z.string(), name: z.string() }).optional(),
    /** この出来事に添えた添付の参照（#3113 段3。**メタデータだけで、中身は日誌に書かない**）。 */
    attachments: z.array(attachmentRefSchema).optional(),
    /**
     * 届いた中身。長いものは切って入る。
     *
     * 要約ではなく中身を落とすのは、日誌が「何かあったときに掘る」層だからである
     * （PRD「可観測性」）。何が届いたのか分からない記録は掘る役に立たない。
     */
    summary: z.string(),
  }),
  /**
   * 委譲1区間ぶんの集計。**フィールドの意味と doc は `runner-protocol.ts` の
   * `worker_wait` イベントに書いてある（二重管理を避けるためここには書き写さ
   * ない）。** `id` / `at` はストア側が埋める（`at` は区間が閉じた時刻、
   * `openedAt` が開いた時刻なので、区間の長さも後から出せる）。
   */
  z.object({
    type: z.literal('worker_wait'),
    id: z.string(),
    at: isoDateTime,
    openedAt: isoDateTime,
    tasks: z.number().int().nonnegative(),
    turns: z.number().int().nonnegative(),
    byCause: z.object({
      input: z.number().int().nonnegative(),
      notification: z.number().int().nonnegative(),
      continuation: z.number().int().nonnegative(),
    }),
    toolless: z.number().int().nonnegative(),
    notifications: z.number().int().nonnegative(),
    submits: z.number().int().nonnegative(),
    sources: z.record(z.string(), z.number().int().nonnegative()).optional(),
    settled: z.boolean(),
  }),
  /**
   * **ターン1回ぶんの消費の増分**（`usage.ts` の `UsageFold.delta`）。
   *
   * 台帳（`UsageStore`）は日 × actor × モデル × 層 × 場所の5軸に畳むので、
   * 「今日いくら使ったか」は言えるが「**どのターンが高かったか**」は言えない
   * （台帳の行は日単位でしか閉じない）。ここへ1ターン1行で残す。
   *
   * **なぜ台帳の軸を増やさずに日誌へ置いたかは PR 本文にある。** ここに書くのは
   * この行1件が何を言えて何を言えないかだけである — 日誌を読む者はこの PR を
   * 読んでいない。
   *
   * ## 「行が無い」理由は3つある。取り違えないこと
   *
   * 1. **増分が空**（`delta` が `{}`）。同じ累積の再送などで実際に増分が
   *    無かった回（`clone.ts` の `#recordUsage` / `manager.ts` の
   *    `case 'usage'` が書かない）。
   * 2. **台帳へ積めなかった**（記録の失敗）。**両層とも日誌に跡が残る**
   *    （非対称を事実として書いたのは #131、解消したのは #133。経緯は
   *    #133 の PR 本文にある） —
   *    マネージャー層は `case 'usage'` の `catch` が `exchange with=manager`
   *    として日誌に残し、クローン層は `#recordUsage` の `catch` が
   *    `exchange with=self` として日誌に残す（どちらも文言は
   *    「消費を台帳へ記録できなかった（この分は集計に出ない）」で揃えてある）。
   *    クローン層は stderr（`noteDroppedRecord`）も併せて残す — 台帳の
   *    失敗そのものを名指しする跡は stderr 側にしか無い（日誌への追記も
   *    失敗した場合、`exchange` の行自体も書かれず、`#journal` のフォール
   *    バックが別の文言で stderr に残るため）。**つまりこの2番の回でも、
   *    日誌への追記そのものがさらに失敗した稀な場合を除き、`turn_usage` は
   *    無いが `exchange with=self`（クローン層）／`with=manager`
   *    （マネージャー層）は残る。**
   * 3. **ターンが失敗して終わった**（`isSuccessResult` が偽）。`models` の
   *    doc を見よ — これが最も誤読を招きやすい形である。
   *
   * これで全て。`#recordUsage` の早期 return（1・3）と `case 'usage'` の
   * `try`/`catch`（2）を読めば数え上げが閉じる。
   *
   * **これは「行が無い」理由であって、「行の中の欄が無い」理由ではない。**
   * `contextUsage` / `compactions` / `mainLoopUsage` は行が在っても個別に
   * 無いことがある —— それぞれの doc に理由がある（取り違えないこと）。
   *
   * - `id` / `at` はストアが埋める（他の型と同じ）。
   */
  z.object({
    type: z.literal('turn_usage'),
    id: z.string(),
    at: isoDateTime,
    /** どの層か。台帳と同じ語を使う（モデル id で代用しない。`usage.ts` の `usageLayerSchema`）。 */
    layer: usageLayerSchema,
    /**
     * どの `query()` 呼び出しか。**起点（`cause`）とは別の軸である。** 発意
     * tick を契機に回ったターンも、人間との会話のターンも、同じ
     * `site: 'session'` に入る。「どの起点が高かったか」を言うには別の軸が
     * 要るが、この PR では足していない（測って要るかを判断する。PR 本文）。
     */
    site: usageSiteSchema,
    /** 誰の分か（マネージャーの id か `CLONE_ACTOR_ID`）。台帳の `managerId` と同じ値。 */
    managerId: z.string(),
    /** SDK のセッション id（取れたときだけ）。生ログへ降りる鍵。 */
    sessionId: z.string().optional(),
    /**
     * モデル別の増分。**合計に潰さないこと。**
     *
     * **これはそのターンの「請求額」ではない。** `usage.ts` の
     * `usageSiteSchema` の doc（「## どの層にも出てこない消費がある」）が言う
     * とおり、`modelUsage` には compaction など内部の呼び出しが混ざっており
     * 分離できない。逆に permission classifier / token-count probe のような、
     * **台帳のどの層にも出てこない消費もある**（同 doc）。
     *
     * ## これは「このターンの消費」ではなく「前回成功した result からの増分」である
     *
     * `#recordUsage` と `case 'usage'` はどちらも `isSuccessResult(message)`
     * が偽の result を無条件に捨てる（`runner.ts` の既存コメント —
     * 「絞っても取りこぼさない。値は累積なので、失敗した回のぶんも次の成功が
     * 運んでくる」）。**これは台帳（合計）については正しいが、1ターン1行の
     * 増分にとっては意味が変わる** — 失敗して終わったターン（上限に当たって
     * 落ちた回を含む）は行を1件も作らず、**その消費は次に成功したターンの
     * `models` へ合算されて現れる。**
     *
     * つまり `turn_usage` の1行が高いのを見たとき、それは「そのターンだけが
     * 高かった」ではなく「直前に失敗したターンが無かったか」を確かめないと
     * 判断できない。突き合わせ先は日誌の `exchange`（クローン層は
     * `with: 'self'` / `with: 'human'` で `#reportFailure` が書く。マネージャー
     * 層は `with: 'manager'` に加え `ManagerSummary.lastFailure` — 報告の本文
     * だけでは失敗と判定できない回があるため）。**この注意は下の `reset` の
     * 注意と同じ種類である。** どちらも「この行の `models` を素朴に合計すると
     * 間違える」という形をしている。
     *
     * `cacheReadInputTokens` と `cacheCreationInputTokens` を分けたまま持つ
     * ことで、「キャッシュの書き直しに払っているのか」が推測ではなく事実として
     * 分かる。ここを合計に潰すと、その区別が消える。
     */
    models: z.record(z.string(), usageTotalsSchema),
    /**
     * 数え直し（resume / `/clear` で SDK 側の累積が0から始まった）を挟んだ
     * ターンの印。
     *
     * **これが付いた行の `models` は差分ではなく、新しい累積の先頭である**
     * （`usage.ts` の `foldUsageSnapshot` — 「数え直しを検知したときの増分は
     * スナップショットの全量」）。他の行と同じ扱いで合計へ足すと、記録済みの
     * 分を二重に数える。**`models` の doc の「前回成功した result からの増分」
     * の注意と同じ種類 — どちらも素朴に合計すると間違える。**
     *
     * **付いていないことは「数え直しが起きなかった」ではない。** 検知は
     * `usage.ts` の `detectReset` の2条件（モデルの値が減った／基準にあった
     * モデルが消えた）に基づく判定であって、この2条件に当たらない数え直しは
     * 検出されない。「このターンでは検出されなかった」であって「起きなかった」
     * ではない。
     */
    reset: z
      .object({
        fromCostUsd: z.number().nonnegative(),
        toCostUsd: z.number().nonnegative(),
      })
      .optional(),
    /**
     * ターンの境界で聞いた文脈窓の占有。形と各欄の doc は
     * {@link contextUsageObservationSchema}（このファイルの上のほう。
     * `#967` でクローン層とマネージャー／ランナー層の共有スキーマへ
     * 括り出した）を見よ——二重に書かない。
     *
     * **⚠️ Issue #976 以降、これはもう文脈占有の唯一の置き場ではない。**
     * `turn_usage` の行は消費の増分がある回（＝ターンが成功し、`fold.delta`
     * が非空の回）にしか書かれないため、ここへ相乗りさせている限り、
     * 増分が無い回（失敗したターン・増分がゼロだった回）は文脈占有も
     * ろとも落ちていた——それが #976 の欠陥である。**独立の
     * `context_usage`（このファイルの下のほう）が、観測できた回すべてを
     * 無条件に残す。** この欄は既存の読み手（`journal_read`・Web の日誌
     * フィード）との互換のため、「成功して増分もあった回」に限り従来どおり
     * 書き続ける——2つの型のうち `context_usage` のほうが完全な記録で、
     * こちらはその部分集合（重複あり）だと考えてよい。
     */
    contextUsage: contextUsageObservationSchema.optional(),
    /**
     * このターンの中で起きた compaction（SDK の
     * `SDKCompactBoundaryMessage.compact_metadata` の写し）。
     *
     * **`turn_ended` は1ターンに1回だが、compaction はターンの途中で届く
     * 別のメッセージ（`system`/`compact_boundary`）である。** だから
     * `foldSystemMessage`（`claude-provider.ts`）で中立イベント
     * （`agent-events.ts` の `AgentCompactionEvent`）へ写し、`clone.ts` が
     * ターンの間だけ `Turn.compactions` として保持して、ここへまとめて
     * 載せる。
     *
     * **`foldSystemMessage` は元々これを見ていなかった**（`return []` で
     * 落としていた）。`task_progress` 等の「見ないと決めてある」種類とは
     * 違い、これは判断ではなく単純な抜けである — compaction はターンの
     * 途中でトークンを大きく動かすので、消費の増分（`models`）だけを見て
     * いると「このターンは何もしていないのに高い」という行が説明なく
     * 現れうる。
     *
     * **配列にしてあるのは「1ターンに複数回」を否定できないからである**
     * （manual と auto が同じターンで両方起きる形を排除する根拠が無い）。
     * **空配列は作らない** —— 起きなければキーごと省く（AGENTS.md 地雷表
     * 「取れない軸に0の行を作る」と同じ理由）。「compaction が0回だった」と
     * 「compaction を見ていない」を区別する必要はここには無い —— 見た上で
     * 0件なら、それは単に起きなかったという事実である（`contextUsage` の
     * ような能動的な probe ではなく、provider が出した合図を受け取るだけの
     * 受動的な観測なので、「試したが失敗した」という第3の状態が無い）。
     *
     * **ターンの外で起きた分は拾えない。** `clone.ts` の `#apply` は
     * `this.#turn` が `null` のとき（人間ともクローン自身とも話していない
     * 窓）に届いた `compaction` イベントを静かに捨てる —— 対応する
     * `turn_usage` の行そのものが無いので、持ち帰る先が無い。実機でこの窓に
     * compaction が実際に起きるかは確かめていない。
     *
     * `postTokens` が無い行は、SDK が `post_tokens` を省いた回
     * （`SDKCompactBoundaryMessage.compact_metadata.post_tokens` は
     * optional）。
     */
    compactions: z
      .array(
        z.object({
          trigger: z.enum(['manual', 'auto']),
          preTokens: z.number().int().nonnegative(),
          postTokens: z.number().int().nonnegative().optional(),
        }),
      )
      .optional(),
    /**
     * `result.usage`（`NonNullableUsage`）の写し。**`modelUsage` とは別物で、
     * 台帳には使わない**（`usage.ts` の `modelUsageOf` の doc「`result.usage`
     * は使わない」）。
     *
     * ## これは何のために置いたか、いつ消してよいか
     *
     * SDK の型コメント（`@anthropic-ai/claude-agent-sdk@0.3.261` の
     * `sdk.d.ts` の `SDKResultSuccess.usage`）はこう言う（逐語）——
     *
     * **「MAIN AGENT LOOP ONLY — excludes Task subagent, sidechain, and auxiliary model calls, and is per-turn in streaming-input sessions. Prefer modelUsage for token/cost accounting」** [sdk-verbatim SDKResultSuccess.usage]
     *
     * **「メインループだけ」は分かるが、「streaming-input セッションで
     * per-turn」が (i) そのターンの API 呼び出しを合計した値なのか (ii)
     * 直近1回ぶんだけなのかを、この文言は決めていない。** `modelUsageOf`
     * の doc が言うとおり、台帳には `modelUsage`（作業者・compaction を
     * 含む「正しい」側）を使っており、`result.usage` は使っていない ——
     * ここへ運ぶのは台帳の代わりではなく、**この問いに決着を付けるための
     * 観測**である。
     *
     * **決着したら、この欄は落とす。** (i)（累積合計）だと分かった時点で、
     * `models`（`modelUsage` の差分）と重複するだけの欄になる —— 消す判断は
     * 実測を見た者に委ねる。この PR 自身はどちらであるかを実機で確かめて
     * いない（型とコメントだけを根拠にした暫定の観測である）。
     *
     * **モデル別ではなく1本**（`result.usage` 自体がモデルを跨がない単一の
     * 形のため）。`costUsd` を持たない —— `NonNullableUsage` はコストの欄を
     * 持たない。
     */
    mainLoopUsage: z
      .object({
        inputTokens: z.number().int().nonnegative(),
        outputTokens: z.number().int().nonnegative(),
        cacheReadInputTokens: z.number().int().nonnegative(),
        cacheCreationInputTokens: z.number().int().nonnegative(),
      })
      .optional(),
  }),
  /**
   * ターンの境界で聞いた文脈窓の占有を、**消費（`turn_usage`）とは独立に**
   * 必ず残す記録（Issue #976）。
   *
   * ## なぜ `turn_usage` に相乗りさせないか
   *
   * `turn_usage` の行は消費の増分が実際にある回にしか書かれない
   * （上の `models` の doc「行が無い理由は3つある」）。文脈占有は消費とは
   * 別の観測軸なので、消費の行に相乗りしている限り、消費が無い回
   * （ターンが失敗して終わった回・増分がゼロだった回）で文脈占有もろとも
   * 落ちる——それが #976 の欠陥そのものである。
   *
   * ## いつ書くか
   *
   * `#observeContextUsage()` が値を返した回（`error` 付きの「試して失敗
   * した」を含む）は、**ターンの成否にも消費の増分の有無にも関係なく必ず
   * 書く。** 書かないのは観測そのものが `undefined`（`Query` が既に無かった
   * 等）の回だけである（`contextUsageObservationSchema` の doc の3値と
   * 同じ区別）。
   *
   * ## 既存の `turn_usage.contextUsage` との関係
   *
   * **この型は `turn_usage.contextUsage` を置き換えない。追加である。**
   * ターンが成功して増分もあった回（＝ `turn_usage` の行が書かれる回）は、
   * 引き続き `turn_usage.contextUsage` にも同じ値が載る——既存の読み手
   * （`journal_read`・Web の日誌フィード）を壊さないため。**この型が
   * 実際に増やすのは、そこから漏れていた2つの回**（ターンが失敗した回・
   * 増分がゼロだった回）だけである。1ターンで両方の行が書かれることは
   * あるが（成功して増分もあった回）、それは意図した重複であって欠陥では
   * ない——`turn_usage` 側は「消費と一緒に見たいとき」、この型は
   * 「文脈占有だけを取りこぼしなく辿りたいとき」に使う。
   */
  z.object({
    type: z.literal('context_usage'),
    id: z.string(),
    at: isoDateTime,
    /** どの層か。`turn_usage` と同じ語を使う（`usage.ts` の `usageLayerSchema`）。 */
    layer: usageLayerSchema,
    /** どの `query()` 呼び出しか。`turn_usage.site` と同じ軸。 */
    site: usageSiteSchema,
    /** 誰の分か（マネージャーの id か `CLONE_ACTOR_ID`）。台帳・`turn_usage` と同じ値。 */
    managerId: z.string(),
    /** SDK のセッション id（取れたときだけ）。生ログへ降りる鍵。 */
    sessionId: z.string().optional(),
    /**
     * そのターンが成功したか（`usage.ts` の `isSuccessResult`）。
     *
     * **`false` の行こそがこの型の存在理由である。** #976 が直すまで、
     * 失敗したターンの文脈占有はどこにも残らなかった——#931 が必要として
     * いるのは、まさにこの `false` の行である。
     */
    turnSucceeded: z.boolean(),
    /** 形と各欄の doc は {@link contextUsageObservationSchema} を見よ。二重に書かない。 */
    contextUsage: contextUsageObservationSchema,
  }),
  /**
   * 受信箱（`InboxStore` / `Inbox`）の到着・配達・消し込み・滞留を、ターンの
   * 境界で1行にして日誌へ残す（Issue #783 段0「測るだけ」）。
   *
   * ## なぜ在るか
   *
   * #783 が名指しした穴はこうである——**#703 が着地した後に受信箱の重複が
   * 実際に減ったか**、推移を測る経路がどこにも無い。`describeInboxBacklog`
   * （`inbox-backlog.ts`）が出す内訳は**その1ターンでクローンが見るだけの
   * 一過性の文字列**で、どこにも残らない——日誌の `tool_use` 行は `input`
   * しか持たず、道具の出力を1文字も書かない。⟹ いま在るのはスナップショット
   * だけで、`journal_read` で辿れる**推移**がどこにも無かった。
   *
   * この型は1行が1つの窓（前回この型の行を書いてから今回まで）を語る。
   * 複数行を時系列に辿れば、到着・配達・消し込みの推移になる。
   *
   * ## 4つの軸は、別のものを数えている——食い違いは欠陥ではない
   *
   * - **`arrived`** — この窓に `Clone#post` が**受理**した数
   *   （`clone.ts` の `#remember` ＝ `InboxStore.put` を呼んだ回数）。
   *   **「受理した瞬間」であって「書けた時刻」ではない**（`post()` の doc
   *   「受理した時点で未読として書き出す」——書き込み自体は非同期で、失敗
   *   しても post は落とさない。受理と永続化の成功の間には窓が残る）。
   * - **`delivered`** — この窓に**メモリ上の待ち行列（`Inbox`）へ実際に
   *   載った**数（`#inbox.push` の呼び出し回数）。クローンのターンを
   *   起こしうる数、という意味で `arrived` とは別の軸である。
   * - **`settled`** — この窓に `#forget`（＝ `InboxStore.remove` が成功した
   *   回）を通った数。**「ターンが処理し終えて消した」だけを数えていない**
   *   ——`#forget` は同じ tick の重複を畳んで吸収したとき・拾い直した合図が
   *   もう意味を持たないと判定して捨てたとき（`inbox-staleness.ts` の
   *   `restoredInboxEventVerdict`）にも呼ばれる。この欄が答えるのは
   *   「ストアから消えた回数」であって「ターンで処理された回数」ではない。
   * - **`pending`** — 窓の**終わりの1点**（`InboxStore.pending()` の戻り値
   *   そのまま）。窓の中の最大でも平均でもない。
   *
   * ## `delivered` が `arrived` / `pending` と食い違う理由（Issue #1049）
   *
   * 3つは別のものを数えているので、一致しないことがある。既知の経路:
   *
   * - `#restoreUnread`（器の入れ替えを跨いだ拾い直し）が配る分は、**この窓に
   *   `arrived` していない**のに `delivered` には入る——受理は前の器（か、
   *   もっと前）の窓で既に数えられていて、いま数えられるのは配達だけである。
   * - `redeliveryGate` が「いま配る意味が無い」と畳んだ分は `delivered` に
   *   **入らない**（`#inbox.push` を呼ばない ＝ ターンを起こさない。
   *   `#foldGatedRedelivery` が跡を残す側）。
   * - `inbox_remove_many`（`POST /inbox/remove`。`InboxStore.removeMany` を
   *   直接呼ぶ一括削除）で消えた行が、消えた後もメモリ上の待ち行列に残って
   *   いれば、**ストアには無いのに `delivered` には数えられる**——Issue
   *   #1049 はこの経路そのものを疑っている（実測: 02:54:59Z に27件を
   *   `inbox_remove_many` で消した16分後、そのうち2件に対応する合図が
   *   「配り直しである（1回目の配達）」として届いた。その間ずっと
   *   `pending` は「未処理1件」のままだった）。
   * - **受信箱の畳み込み（Issue #954 の受信箱側。`clone.ts` の
   *   `#foldIntoPendingCollapse`）が畳んだ分は `arrived` に入らない**——
   *   `#remember` を呼ばないからである（この欄の定義が「`#remember` を
   *   通った回数」である以上、これは欠陥ではなく定義どおりの挙動である）。
   *   **⚠️ そのうえで、畳み先が2つに分かれることを読む側は知っている必要が
   *   ある**（`clone.ts` の `PendingCollapseVerdict`）:
   *   - `manager_message`（429 の連投など）は**行もターンも畳む**ので、
   *     `arrived` にも `delivered` にも入らない。⟹ **この族の連投は、この
   *     行からは丸ごと見えない。**見えるのは畳んだ旨を1件ずつ残す日誌の
   *     `exchange` 行のほうである。
   *   - デーモン自身の `external`（`token-pool` の復帰通知など）は**行だけ
   *     畳んで待ち行列へは入れる**（issue #841 の束ね読みを残すため）ので、
   *     **`arrived` に入らないのに `delivered` には入る。**
   *   **⛔ ⟹ 下の「読み方」を、この経路と取り違えないこと。** `delivered`
   *   が `arrived` を上回る形は #1049（ストアと待ち行列の食い違い）でも
   *   この畳み込みでも出るが、**意味は正反対である**——#1049 は「消したのに
   *   配っている」（壊れている）、こちらは「器に積まずに配っている」
   *   （意図どおり働いている）。**2つを見分ける材料はこの行の中には無い。**
   *   見分けるなら日誌の `exchange` 行（畳んだ旨を1件ずつ残している）を
   *   同じ窓で引くこと。
   *
   * ⟹ **読み方**: `delivered` が `arrived` を継続して上回り、かつ `pending`
   * が小さいままなら、待ち行列（`Inbox`）とストア（`InboxStore`）が食い違って
   * いる疑いがある（#1049）。**ただしこの行だけでは断定できない**——配達
   * された行が本当にストアから消えていたか（＝#1049 の核心）は、この行は
   * 見ていない。見ているのは「メモリ上の待ち行列へ何回載せたか」という数
   * だけである。
   *
   * ## `settled` を数える場所は1箇所（`#forget` の内側）だが、呼び出し元は3箇所ある
   *
   * `clone.ts` の `#forget` はここでは唯一の消し込み経路で、そこで1回だけ
   * 数える（呼び出し元ごとに数えると、1箇所でも足し忘れれば静かに過小評価
   * になる）。呼び出し元は3つ——同じ tick の重複を畳んで吸収したとき／
   * ターンが処理し終えたとき（`#settleInboxEvent`）／拾い直した合図が
   * `stale` と判定されたとき（`#restoreUnread`）。**このうち実際に1ターン
   * 分の処理をして消したと言えるのは2番目だけである**——それでも欄の名前を
   * 割らずに1本の `settled` で持たせているのは、この型の目的が「受信箱
   * ストアの滞留がどれだけ減ったか」であって「ターンが何を処理したか」では
   * ないため。後者を測る型は別に要るなら、それはこの型の役目ではない。
   *
   * ## `delivered` を数える場所は `#inbox.push` の3箇所（`Inbox#unshift` は数えない）
   *
   * `post()`（通常の受理経路）／`#postAndWait`（蒸留の割り込み）／
   * `#restoreUnread`（器を跨いだ拾い直し）。**`Inbox#unshift`（枠の解除で
   * 保持分を待ち行列の先頭へ戻す経路）は数えに入れない**——戻される合図は
   * 保持される前に既に一度 `push` で数えられているので、数え直すと枠で
   * 保持されて後から解除された分だけ二重に計上される。
   *
   * ## 窓は永続化しない
   *
   * `arrived` / `delivered` / `settled` のカウンタはクローンのインメモリ
   * 状態で、**器が入れ替わると0から始まる。** だから `windowStartedAt` を
   * 必ず持たせる——無いと、写した先で「いつからの数か」が消え、器の入れ替え
   * を跨いだ比較が壊れる。
   *
   * ## いつ書くか
   *
   * ターンの境界（`case 'turn_ended'`）で毎回1行書く——`context_usage` と
   * 同じ境界を使う。別の境界を選ぶと、2つの型を突き合わせて読みたいときに
   * 窓がずれる。**`InboxStore.pending()` が読めなければこの窓は書かない**
   * （カウンタも戻さない——次のターンへ持ち越せば、この窓ぶんの到着・配達・
   * 消し込みは失わずに済む。跡は `noteDroppedRecord` が残す）。
   */
  z.object({
    type: z.literal('inbox_flow'),
    id: z.string(),
    at: isoDateTime,
    /** この行が数えた窓の始まり。前回この行を書いた時刻（器が入れ替わった
     * 直後は器が立ち上がった時刻）。 */
    windowStartedAt: isoDateTime,
    /** この窓に `Clone#post` が受理した数（`#remember`）。種類別。 */
    arrived: inboxFlowByTypeCountSchema,
    /** この窓にメモリ上の待ち行列（`Inbox`）へ実際に載った数（`#inbox.push`）。種類別。 */
    delivered: inboxFlowByTypeCountSchema,
    /** この窓に `#forget`（＝ `InboxStore.remove` の成功）を通った数。種類別。 */
    settled: inboxFlowByTypeCountSchema,
    /** 窓の終わりの1点（`InboxStore.pending()` の戻り値そのまま）。 */
    pending: z.object({
      count: z.number().int().nonnegative(),
      oldestAt: isoDateTime.optional(),
    }),
    /**
     * 窓の終わりの1点——メモリ上の4つの索引（`Clone` の private field）の
     * 残数（`Map.size`）。Issue #1264（案1a）。
     *
     * - `unread`: `#unread`（まだ `#forget` していない合図の集合）の残数
     * - `redelivered`: `#redelivered`（起動時に拾い直した合図）の残数
     * - `redeliveredClosed`: `#redeliveredClosed`（拾い直した合図のうち、
     *   台帳が既に片付いていると言っているもの）の残数
     * - `pendingCollapse`: `#pendingCollapse`（`manager_message` /
     *   デーモン自身の `external` を畳むための代表の索引）の残数
     *
     * ## `pending` との違い —— あちらはストア側、こちらはメモリ側
     *
     * `pending`（直上）は `InboxStore.pending()` を経由して**ストア**（fs /
     * pg）へ問い合わせた値で、器が入れ替わっても消えない。この欄はどれも
     * `Clone` インスタンスが持つメモリ上の `Map` の残数で、**器が入れ替わると
     * 0から始まる**（`#pendingCollapse` の doc「器の入れ替えを跨ぐと空に
     * なる」と同じ性質）。2つは別の層を見ているので、片方だけで他方を
     * 代替できない。
     *
     * ## `arrived` / `delivered` / `settled` と違って窓ごとに0へ戻さない
     *
     * 上の3つは**増分**（この窓で何回起きたか）で、`#writeInboxFlow` が
     * 書いた直後に `.clear()` して次の窓へ持ち越さない。この欄は逆に
     * **時点の値**（いまその `Map` に何件残っているか）であって、増分では
     * ない——書いた直後にクリアすると「残っている件数」という意味そのもの
     * が壊れる。`pending` と同じ「窓の終わりの1点」側に属する。
     *
     * ## なぜ在るか（Issue #1264）
     *
     * `#forget`（と、それを一括化した `#removeStaleRedeliveryChunk`）が行う
     * 5つの後始末のうち、この4つの `Map` からの削除は**外から観測する出口が
     * 無かった**——3つ（`#unread` / `#redelivered` / `#redeliveredClosed`）は
     * 読み手が「配り直しの断り文を組む3箇所だけ」で、削除を止めても出力が
     * 1文字も変わらないので歯が書けなかった（Issue #1264 の「なぜ測れない
     * のか」）。この欄が、その出口になる。
     *
     * ## ⚠️ `.optional()` にする理由 —— 既存の行を壊さないため
     *
     * この欄が増える**前**に書かれた `inbox_flow` の行には無い。必須にすると、
     * **読み出し時にも** `journalEntrySchema.safeParse` を通る既存の行が
     * 丸ごと `unknown-shape` として扱われ、`list()` の結果から消える
     * （`packages/storage-fs/src/journal.ts` の `parseLine` /
     * `packages/storage-pg/src/journal.ts` の `list`。`journal_read`・日報・
     * 蒸留の全経路がここを経由する）。**`default` で埋めない** ——
     * `turn_usage.contextUsage.categories[].kind` の doc（#804）と同じ規律で、
     * 無いことは「観測していない」であって「0件だった」ではない。
     */
    retained: z
      .object({
        unread: z.number().int().nonnegative(),
        redelivered: z.number().int().nonnegative(),
        redeliveredClosed: z.number().int().nonnegative(),
        pendingCollapse: z.number().int().nonnegative(),
      })
      .optional(),
  }),
  /**
   * **誰かが GitHub を見て数えた結果の記録**（Issue #2245）。`GET /progress` の `github` が
   * これを読んで返す。**デーモン自身は GitHub を見に行かない**（`JobStatus` の doc の
   * 「デーモンは PR もブランチも見に行かない」）——この行は「観測した側が名乗った申告」を
   * 日誌へ置くだけで、デーモンは値を確かめられない。だから `observedBy` を必須にし、
   * 読み手へも「誰の観測か」を必ず出す。
   *
   * - `repo`: 観測した側が名乗る `owner/name`。デーモンは repo を決めない。
   * - `query` / `limit`: 母集合をどう切ったか（`gh issue list --state open --limit N` の
   *   引数など）。**数は母集合の切り方とセットでしか読めない。**
   * - `result`: **`status` で判別する。** `ok` のときだけ数を持つ。`failed`（取れなかった回）は
   *   数の欄そのものが無い——0 を作ると「0 件だった」と読める（取れないことが出力から消える）。
   *   `truncated` が真なら `limit` に達しており、実数はもっと多い（数は下限）。
   *
   * **古さは判定しない。** `at`（デーモンが受けた時刻）をそのまま返し、新しさの判断は読み手に任せる。
   * CI の状態は `ok` の枝の `ci`（取れなければ `ciUnavailable`。排他）が持つ（#2549）。
   */
  z.object({
    type: z.literal('github_observation'),
    id: z.string(),
    at: isoDateTime,
    observedBy: z.string().min(1).max(200),
    repo: z.string().min(1).max(200),
    query: z.string().max(1000),
    limit: z.number().int().positive().optional(),
    result: z.discriminatedUnion('status', [
      z
        .object({
          status: z.literal('ok'),
          openIssues: z.number().int().nonnegative(),
          openPulls: z.number().int().nonnegative(),
          truncated: z.boolean(),
          /**
           * **PR の CI の状態の軸**（Issue #2549。#2245 の後続）。**任意**——この欄が増える前に書かれた
           * 行には無く、必須にすると既存の行が読み出し時に丸ごと落ちる（`inbox_flow.retained` と同じ
           * 理由）。**無いことは「CI を観測していない」であって「0 件だった」ではない。`default` で
           * 埋めない。**
           *
           * - `pulls`: CI を見た PR の数（open PR の総数 `openPulls` とは別。見ていない PR がありうる）
           * - `success` / `failure` / `pending`: その PR を CI の状態で分けた数。**1つの PR は高々1つの
           *   欄に数える**（チェックが1件も無い PR はどれにも数えない）ので、3つの和は `pulls` 以下
           * - `checks`: **何を数えたか**（例「必須チェックだけ」・check の名前の列挙）。これが無いと
           *   数は読めない（`query` が母集合の切り方を持つのと同じ）。上限付き
           * - `truncated`: 真なら上限で打ち切っており、数は下限
           */
          ci: z
            .object({
              pulls: z.number().int().nonnegative(),
              success: z.number().int().nonnegative(),
              failure: z.number().int().nonnegative(),
              pending: z.number().int().nonnegative(),
              checks: z.string().min(1).max(500),
              truncated: z.boolean().optional(),
            })
            .refine((ci) => ci.success + ci.failure + ci.pending <= ci.pulls, {
              message: 'success + failure + pending は pulls 以下でなければならない',
            })
            .optional(),
          /**
           * CI を取れなかった理由（観測した側の申告）。**`ci` と排他**——取れなかったのに数を置くと
           * 0 を作ることになり、両方あれば読み手はどちらを信じるか決められない。
           */
          ciUnavailable: z.string().min(1).max(1000).optional(),
        })
        .refine((result) => result.ci === undefined || result.ciUnavailable === undefined, {
          message: '`ci` と `ciUnavailable` は同時に置けない',
          path: ['ciUnavailable'],
        }),
      z.object({ status: z.literal('failed'), reason: z.string().min(1).max(1000) }),
    ]),
  }),
]);

export type JournalEntry = z.infer<typeof journalEntrySchema>;

/**
 * `github_observation` の入力（`type` / `id` / `at` を除いた形。Issue #2245）。**日誌の枝そのものから
 * 導く**——`POST /github-observations`（daemon）と道具 `github_observation_record` が同じ検証を
 * 通るように、手で書き直さない。
 */
export const githubObservationInputSchema = (
  journalEntrySchema.options.find(
    (option) => option.shape.type.value === 'github_observation',
  ) as Extract<
    (typeof journalEntrySchema.options)[number],
    { shape: { type: { value: 'github_observation' } } }
  >
).omit({ type: true, id: true, at: true });
export type JournalEntryType = JournalEntry['type'];

/**
 * `trace-action.ts` の {@link TraceActionLike}（手書き）が、この zod
 * スキーマから推論した {@link JournalEntry}（13種の判別可能ユニオン）を
 * 構造的に受け付けることの強制（issue #1528）。
 *
 * 軽い口（`trace-action.ts`）は zod を import できないので、
 * `describeTraceAction` が実際に読む4種（`decision` / `memory_update` /
 * `tool_use` / `exchange`）の欄だけを手で書き写し、残り9種は型の名前
 * だけで受けている（そちらの doc）。**ここが崩れると、`describeTraceAction`
 * へ実際の `JournalEntry` を渡す呼び出し（`approval-trace.ts` の
 * `renderApprovalTrace`）自体が `typecheck` で落ちるはずだが、その落ち方は
 * 「どの欄がずれたか」を言わない**——この宣言はずれを名指しで捕まえる場所
 * として置いてある。
 *
 * **`_AssertAnsweredViaMatchesLikeType` と違い、双方向の完全一致ではなく
 * 片方向**（`JournalEntry extends TraceActionLike`）。`TraceActionLike` は
 * 意図して「`describeTraceAction` が読む欄だけの最小の型」であって
 * `JournalEntry` の完全な写しではないので、双方向にすると
 * `TraceActionLike` が持たない欄（`id` / `at` / `actor` など）のぶんで
 * 必ず落ちる（`trace-action.ts` 冒頭の doc）。
 */
export type _AssertTraceActionMatchesLikeType = AssertTrue<
  JournalEntry extends TraceActionLike ? true : false
>;

/**
 * `journal-diagnostics-format.ts` の {@link JournalDiagnosticsEntryLike}
 * （手書き）が、この zod スキーマから推論した {@link JournalEntry} の4種
 * （`worker_wait` / `turn_usage` / `context_usage` / `inbox_flow`）を
 * 構造的に受け付けることの強制（issue #2016）。**`_AssertTraceActionMatchesLikeType`
 * と同じ形**——軽い口（`journal-diagnostics-format.ts`）は zod を import
 * できないので、`summarizeJournalDiagnosticsEntry` が実際に読む欄だけを
 * 手で書き写している。
 *
 * **双方向の完全一致ではなく片方向**（この4種 `extends`
 * `JournalDiagnosticsEntryLike`）。`JournalDiagnosticsEntryLike` は意図して
 * 「実際に読む欄だけの最小の型」であって4種の完全な写しではないので、
 * 双方向にすると `id` / `at` などのぶんで必ず落ちる
 * （`journal-diagnostics-format.ts` 冒頭の doc）。
 */
export type _AssertJournalDiagnosticsMatchesLikeType = AssertTrue<
  Extract<
    JournalEntry,
    { type: 'worker_wait' | 'turn_usage' | 'context_usage' | 'inbox_flow' }
  > extends JournalDiagnosticsEntryLike
    ? true
    : false
>;

export type DailyReport = Extract<JournalEntry, { type: 'daily_report' }>;

/**
 * 日報の行か（**印の行も含む**）。人間へ出す一覧はこちらを使う — 書けなかった
 * ことも人間には見えていなければならない。
 */
export function isDailyReport(entry: JournalEntry): entry is DailyReport {
  return entry.type === 'daily_report';
}

/**
 * **実際に書かれた**日報か（`unavailable` の印が付いた行を除く）。
 *
 * **「その日の日報はもうあるか」を数える側は必ずこちらを使うこと。** 印の行を
 * 数えてしまうと、後から本物を書き直す道が閉じる（`unavailable` の doc に経緯）。
 * 数える側は2か所ある — `clone.ts` の `#dailyReport` と `schedule.ts` の
 * `missingDailyReportDates` で、**片方だけ直すと片方の経路だけが死ぬ**。
 */
export function isWrittenDailyReport(entry: JournalEntry): entry is DailyReport {
  return isDailyReport(entry) && entry.unavailable === undefined;
}

/**
 * 日誌の種別の一覧（絞り込みの選択肢として外へ出す口）。
 *
 * **`satisfies Record<JournalEntryType, true>` で縛ってある。** 種別を足して
 * ここを足し忘れると型で落ちる — 一覧が黙って古びると、増えた種別だけが
 * 絞り込みから漏れて「あるのに見えない」が静かに生まれる。
 */
const journalEntryTypeNames = {
  exchange: true,
  decision: true,
  escalation: true,
  tool_use: true,
  memory_update: true,
  daily_report: true,
  external_event: true,
  worker_wait: true,
  turn_usage: true,
  token_rotation: true,
  subagent_stall: true,
  context_usage: true,
  inbox_flow: true,
  github_observation: true,
} satisfies Record<JournalEntryType, true>;

export const JOURNAL_ENTRY_TYPES = Object.keys(journalEntryTypeNames) as [
  JournalEntryType,
  ...JournalEntryType[],
];
/** 追記時に id / at はストアが埋める。 */
export type JournalEntryInput = DistributiveOmit<JournalEntry, 'id' | 'at'>;

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

// ---------------------------------------------------------------------------
// 定期の依頼（時間起点の器）
// ---------------------------------------------------------------------------

/**
 * 定期の依頼の名前。`kind` は受信箱の `timer` イベントに載り、人間が
 * `/schedule` や HTTP から手で起こすときの識別子にもなる。
 */
export const scheduleKindSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9._-]*$/, 'kind は英小文字・数字・. _ - のみ');

/**
 * `every` の分数の上限。1年 = 525600 分（365 日 × 24 時間 × 60 分）。
 *
 * **なぜ上限が要るか。** 上限が無いと `Date` の範囲（約 1.44e11 分）を超える値が保存でき、次の予定が
 * Invalid Date になる。スケジューラは 1ms 周期で `timer` を積み続け、`list()` は投げ、行は保存済みなので
 * 再起動しても直らない（#3533）。
 *
 * **なぜ1年か。** 1年より長い周期は、人間も `every` ではなく cron 式か単発の予定で書く。なので
 * 能力の欠落にならない（PRD「周期の書き方で人間に負けないこと」）。値は人間の決定（2026-10-06）。
 */
export const SCHEDULE_EVERY_MINUTES_MAX = 525_600;

/** `every` が上限を超えたときの断りの文。HTTP の 400 は値を混ぜない決まりなので、この文を `where` の後ろへ足して返す（`POST /schedule`）。 */
export const SCHEDULE_EVERY_MINUTES_MAX_MESSAGE = `every の分数は 1以上${SCHEDULE_EVERY_MINUTES_MAX}（1年）以下の整数のみ。それより長い周期は cron 式か単発の予定で書く`;

/**
 * 周期。
 *
 * **これは方針であって抑止装置ではない**（north_star 禁止2）。「何回まで」を
 * 表す形をここへ足さないこと。表すのは「いつ起こすか」だけである。
 */
export const scheduleSpecSchema = z.discriminatedUnion('type', [
  /**
   * 毎日この時刻（ローカル時刻）。
   *
   * **時刻の範囲までここで見る。** 形だけ見て通すと `25:99` が保存でき、一覧には
   * 「毎日 25:99」と出るのに実際は 00:00 に発火する（人間が読んで矛盾する状態を
   * 作れてしまう）。検査を経路ごとに置くと、どれか1本を通り忘れた時点で穴になる。
   */
  z.object({
    type: z.literal('daily'),
    at: z.string().regex(/^(?:[01]?\d|2[0-3]):[0-5]\d$/, 'HH:MM（00:00〜23:59）で書く'),
  }),
  /** この分数ごと。 */
  z.object({
    type: z.literal('every'),
    minutes: z
      .number()
      .int()
      .min(1)
      .max(SCHEDULE_EVERY_MINUTES_MAX, SCHEDULE_EVERY_MINUTES_MAX_MESSAGE),
  }),
  /**
   * cron 式（ローカル時刻）。
   *
   * **人間が cron で書けることは、この階層でも書けるべきである**（north_star 禁止1）。
   * 「毎週月曜の朝」を `daily` で表そうとすると「毎日起きて曜日を見て何もしない」に
   * なり、7回に6回は上位モデルのターンを空焼きする。
   *
   * 読める式かどうかまでここで見る。読めない式を保存できると、一覧には出るのに
   * 発火しない仕込みが作れてしまう。
   */
  z.object({
    type: z.literal('cron'),
    expression: z
      .string()
      .max(CRON_EXPRESSION_MAX)
      .refine(
        isCronExpression,
        'cron 式として読めない（分 時 日 月 曜の5欄だけ。秒つきは使えない。例: 毎週月曜 10:00 なら `0 10 * * 1`）',
      ),
  }),
]);

/**
 * 継続中の依頼1件（PRD「自律」の起点②を、記憶とは別に器として持つ）。
 *
 * **なぜ記憶だけでは足りないか。** 「毎朝 issue を見て進めておいて」は、記憶に
 * 書けば根拠として残るが、時刻が来たことを誰も教えてくれない。発意 tick で
 * 思い出せるかはそのときの判断に委ねられ、取りこぼしても誰も気づかない。
 * ここに置いた依頼は時刻が来れば必ずクローンの受信箱へ届く。
 *
 * 逆に、**判断の根拠は依然として記憶側にある**。ここに持つのは「いつ起こすか」と
 * 「何を頼まれたか」だけで、やるかやらないか・どうやるかはクローンが決める。
 */
export const scheduledRequestSchema = z.object({
  kind: scheduleKindSchema,
  spec: scheduleSpecSchema,
  /** 依頼の全文。時刻が来たらそのままクローンへ渡る。 */
  request: z.string().min(1),
  createdAt: isoDateTime,
  updatedAt: isoDateTime,
  /**
   * 前回この依頼で動いた時刻（定期の予定でも、人間が手で起こした分でも動く）。
   *
   * 「前にいつ見たか」が分からないと、同じ仕事を毎回まっさらから起こすことになる
   * （＝同じ issue に何本もマネージャーが立つ）。重複を数の上限で止めるのは
   * 禁止2に触るので、材料として渡して判断に使わせる。
   *
   * **これは観測用であって、次の予定を数える基準ではない**（下の
   * `lastScheduledRunAt` がその役）。
   */
  lastRunAt: isoDateTime.optional(),
  /**
   * 前回**定期の予定で**動いた時刻。次の予定を数える基準。
   *
   * `lastRunAt` と分けてあるのは、**手で起こした1回で位相を動かさない**ためである。
   * 人間が `POST /schedule/:kind/run` で余分に1回起こすのは「予定に代えて割り込む」
   * ことではない（`Scheduler.run` の契約）。ここを一緒にすると、手動実行の時刻が
   * 基準になり、再起動した瞬間に定期の予定がその分ずれる。
   */
  lastScheduledRunAt: isoDateTime.optional(),
  /**
   * 「この発火を引き受けたが、まだ終わっていない」印。
   *
   * **確定（claim）と完了を分けるためにある。** 引き受けた時点で印を付け、ターンが
   * 終わってから消す。器を作り直したときにこの印が残っていれば、その回は
   * **モデルに届かないまま失われた可能性がある**ので、依頼の本文つきで配り直す。
   *
   * 印が無く基準（`lastScheduledRunAt`）だけが進んでいると、claim の直後に落ちた
   * 発火は「もう動いた」と見えて、日次なら翌日・週次なら翌週まで消える。逆に印だけで
   * 基準を持たないと、動いた後に落ちたときの二重実行を止められない。**両方要る。**
   */
  pendingRun: z.object({ at: isoDateTime, cause: z.enum(['schedule', 'manual']) }).optional(),
});

export type ScheduleKind = z.infer<typeof scheduleKindSchema>;
export type ScheduleSpec = z.infer<typeof scheduleSpecSchema>;
export type ScheduledRequest = z.infer<typeof scheduledRequestSchema>;

/**
 * 継続中の依頼の1行が `scheduledRequestSchema` として読めなかったときに、その行の
 * 代わりに一覧へ載せるもの（issue #2343。`unreadableApprovalSchema` と同じ形）。
 *
 * **「無い」でも「消された」でもない第3の状態。** 一覧が読めない行を黙って飛ばすと、
 * クローンも人間も、読めない依頼が在ること自体に気づけず「依頼は無い」と言い切る
 * （単票の `schedule_list kind=` は `UnreadableScheduleError` で言い分けている）。
 *
 * **⚠️ 本文（`request`）を載せないこと。** 依頼の欄には人間の依頼文がそのまま入りうる。
 * `reason` は「どの欄が不正か」だけにする。
 */
export const unreadableScheduleSchema = z.object({
  /** 行から取れた kind。取れないこともある（fs 版で行そのものが kind を持たない形のとき）。 */
  kind: z.string().optional(),
  /** なぜ読めなかったか（不正な欄名だけ。値は載せない）。 */
  reason: z.string(),
});
export type UnreadableSchedule = z.infer<typeof unreadableScheduleSchema>;

/**
 * 既定の仕込み（日報・発意 tick）の位相。
 *
 * **これは「依頼」ではない。** 継続中の依頼（`ScheduledRequest`）は人間かクローンが
 * 書いた本文と周期を持ち、`schedule_list` / `GET /schedule` に現れて外せるものである。
 * こちらが持つのは「前回いつ動いたか」だけで、本文も周期も持たない（周期は環境変数、
 * やることを決めるのはクローンである）。
 *
 * **同じ行として持たないのは、既定の仕込みがクローンから「継続中の依頼」に見えて
 * `schedule_remove` で消せてしまうからである。** `tools.ts` の `schedule_list` は
 * ストアの `list()` を直に読み、説明文で「既定の定期ジョブはここには出ない」と
 * 約束している。器を1つにまとめると、その約束が静かに破れる。
 *
 * ⚠️ **ここに既定の仕込みの名前を書き写さないこと（#756）。** 数え上げを持つのは
 * `RESERVED_SCHEDULE_KINDS`（`schedule.ts`）だけで、`schedule_list` の説明文も
 * そこから導出している。ここは #756 以前「日報・発意 tick」の2つを書き写していて、
 * `memory_tidy` が足された後もそのまま取り残されていた。
 *
 * **これが無いと、器を作り直すたびに位相が捨てられる。** `schedule.ts` の `start()` は
 * 既定の仕込みへ `now + 周期` を置くだけなので、周期より短い間隔で再デプロイが続けば
 * 発意 tick は**一度も発火しない**（継続中の依頼について `#firstDue` が書いている穴と
 * まったく同じもの。実測: 2026-08-19 の本番の再デプロイで、動いていた発意 tick の
 * 次回が1時間先へずれた）。
 */
export const schedulePhaseSchema = z.object({
  kind: z.string().min(1),
  /**
   * 前回**定期の予定で**発火した時刻。次の予定を数える基準。
   *
   * `ScheduledRequest` の同名フィールドと同じ役だが、あちらは「引き受けた印
   * （`pendingRun`）を消すとき」に進む。こちらは**発火の瞬間**に進む — 既定の仕込みには
   * 引き受けの印が無いため。失敗の向きが違うので、同じものとして読まないこと
   * （`schedule.ts` の `#recordPhase` にその差を書いてある）。
   */
  lastScheduledRunAt: isoDateTime.optional(),
  /**
   * 手で起こした分も動く観測用の時刻。
   *
   * 分けてあるのは `ScheduledRequest` と同じ理由である（手で起こした1回で位相を
   * 動かさない）。人間が `/run self_initiative` を叩くたびに定期の予定がずれるのは、
   * `Scheduler.run` の「予定に代えて割り込むのではなく、余分に1回起こす」に反する。
   */
  lastRunAt: isoDateTime.optional(),
});

export type SchedulePhase = z.infer<typeof schedulePhaseSchema>;

// ---------------------------------------------------------------------------
// 引き受けたまま終わっていない仕事（未了の器）
// ---------------------------------------------------------------------------

/**
 * その未了が何から生まれたか。
 *
 * **「誰が言ったか」ではなく「どの起点から来たか」である。** 起点を落とすと、
 * 一覧を見たクローンが「これは人間との約束か、自分で思い立ったことか」を
 * 区別できない。取り返しのつかなさも急ぎ方もそこで変わる。
 */
export const commitmentOriginSchema = z.enum(['human', 'manager', 'external', 'self']);

/**
 * `closedReason`（どう片付いたか）を**誰が書いたか**。
 *
 * **`origin` とは別の軸である。** `origin` は「開いたときの起点」であって、
 * 閉じた主体ではない — 人間が積んだ仕事（`origin: 'human'`）をクローンが
 * 片付けることも、クローンが立てた仕事（`origin: 'self'`）を人間が片付ける
 * こともある。`origin` から `closedBy` を導出することはできない（issue #286）。
 *
 * 語彙は既存の2つに揃えてある — `journalEntry.memory_update.cause`
 * （`'distill' | 'clone' | 'human'`、本ファイル）と `ManagerStopActor`
 * （`'human' | 'clone'`、`packages/core/src/manager.ts`）。
 *
 * **`'human'` の意味は `memory_update.cause` の `'human'` と同じ — HTTP の口
 * （`POST /commitments/:id/close`）から入ったもの、という意味であって、
 * 「その瞬間に人間が居たことをデーモンが確かめた」ではない。** AGENTS.md
 * 「git / GitHub の actor から層を推定しないこと」と同じ限界がここにも在る
 * — HTTP を叩いたのが本当に人間かどうかを、この値は保証しない。
 *
 * **これは書き込み側を縛るための型であって、`commitmentSchema.closedBy` の
 * 欄の型ではない。** `CommitmentStore.close(id, at, reason, by:
 * CommitmentClosedBy)` の `by` はこの enum で縛ってあるので、**この器が
 * 書く値はここに挙げた2つに限られる。** それでも保存された行を読む側
 * （`commitmentSchema`）はこの enum を直接使わない — 理由は次のフィールドの
 * doc に書いてある。
 */
export const commitmentClosedBySchema = z.enum(['clone', 'human']);

/**
 * `body` を後から直したときの主体を**誰が書いたか**。
 *
 * **既知の値は `commitmentClosedBySchema` と同じ2つ（`'clone' | 'human'`）
 * である。** 書き手ごとに、直せる行が `origin` で分かれている：
 *
 * - `'human'` — `PATCH /commitments/:id`（`apps/daemon/src/app.ts`）が書く。
 *   直せるのは `origin: 'human'` かつ未了の行だけである
 * - `'clone'` — `commitment_edit`（`packages/core/src/tools.ts`）が書く。
 *   直せるのは `origin: 'self'` かつ未了の行だけである（issue #580 の (B)）
 *
 * **⚠️ かつてここには「クローン向けの編集ツールは無い——人間だけが直せれば
 * よい」と書いてあった。issue #580 でそれが偽になった** — 人間がチャットで
 * クローンに頼んで積まれた行は `origin: 'self'` になるので、人間の主観では
 * 「自分が登録した仕事」なのに誰も直せなかった。線は「人間だけが直せる」
 * ではなく**「書き換えられるのは常に自分自身の言葉だけ」**であり、
 * `commitment_edit` はそれを人間側とクローン側で対称にしただけである
 * （`commitmentSchema.editedAt` の doc）。
 *
 * **それでも `commitmentSchema.editedBy` の型はこの enum ではなく
 * `z.string()` で緩く持つ。** 理由は `commitmentClosedBySchema` と全く同じ
 * である（そちらの doc を見よ）——保存層（`parseCommitment`、
 * `packages/storage-pg/src/commitments.ts`）は未知の enum 値1つで台帳の
 * 一覧を丸ごと読めなくするので、書き込み側をこの enum で縛りつつ読み出し側
 * は緩くする、という同じ非対称をここでも採る。
 */
export const commitmentEditedBySchema = z.enum(['clone', 'human']);

/**
 * 引き受けたまま終わっていない仕事1件（PRD「自律」の器を、単発の依頼へ広げたもの）。
 *
 * **なぜ受信箱と日誌だけでは足りないか。** 受信箱の未読はプロセスが死んでも残るが、
 * **ターンが終われば消える**（`clone.ts` の `#forget`）。消す根拠は「失敗が記録
 * された」ことであって「仕事が終わった」ことではない。したがって「受け取って、
 * 返事はしたが、まだ着手していない」依頼はターンの終了と同時にどの器からも消え、
 * 残るのは日誌の散文だけになる。**日誌は追記専用で状態を持たない**ので、そこから
 * 「まだ終わっていないもの」を数え上げる手立ては誰にも無い。
 *
 * これは PRD「自律」が継続する依頼について既に書いている理由そのものである —
 * 「記憶に書くだけでは足りない。記憶は時計を持たないので、そこにだけ書いた依頼は
 * 思い出せるかどうかの賭けになり、取りこぼしても誰も気づかない」。**単発の依頼にも
 * 同じことが起きる。** 器を持つのは `manager_start` した仕事（JobStore）と
 * `schedule_create` した定期の依頼（ScheduleStore）だけで、その間が空いていた。
 *
 * **ここに持つのは「何を頼まれたか」と「まだ片付いていない」の2値だけである。**
 * 順序も優先度も締切も持たない — それらは PRD「自律」が器に持たせてはいけないと
 * 書いている「やることの一覧」の側であり、判断はクローンに残す。器がするのは
 * **忘れさせないこと**だけで、何を先にやるか・そもそもやるかは毎回クローンが
 * 記憶に照らして決め直す。
 */
export const commitmentSchema = z.object({
  id: z.string(),
  /**
   * 受け取った（あるいはクローンが自分で立てた）時刻。
   *
   * **これが「齢」の出所である。** 優先度のフィールドを持たない代わりに、
   * どれだけ放置されているかを見て判断できるようにしてある。
   */
  at: isoDateTime,
  origin: commitmentOriginSchema,
  /**
   * どこから来たか（会話 id / マネージャー id / webhook の source）。
   *
   * 自分で立てたもの（`self`）には無い。
   */
  source: z.string().optional(),
  /**
   * 何を頼まれたか（全文）。
   *
   * **要約にしないこと。** 一覧で切るのは表示側の仕事で、器が要約を持つと
   * 「頼まれた内容そのもの」が二度と取れなくなる。
   */
  body: z.string(),
  /** 片付いた時刻。無ければ未了。 */
  closedAt: isoDateTime.optional(),
  /**
   * どう片付いたか（閉じた側が書く1行）。
   *
   * **「閉じた」だけを残さない。** 人間が後から否定できることが最終承認の実体で
   * あり（north_star）、何をもって終わりとしたのかが無いと否定のしようがない。
   */
  closedReason: z.string().optional(),
  /**
   * `closedReason` を誰が書いたか。
   *
   * **`undefined` は「不明」でも「未決」でもなく「そもそも無い」である。**
   * この欄が入る前に閉じられた行にはこの情報が存在しない —
   * **既定へ倒さないこと**（`'clone'` や `'human'` のどちらかへ倒した側が、
   * 黙って化ける／黙って化けないを引き受けることになる。表示側は3値目の
   * 「無い」を独立した状態として扱う。`apps/web/app/routes/commitments.tsx`）。
   *
   * **型は `commitmentClosedBySchema`（`z.enum`）ではなく `z.string()` で
   * 緩く持つ。3点、意図して緩めてある:**
   *
   * 1. **既知の値は `commitmentClosedBySchema`（`'clone' | 'human'`）だけ
   *    である。** 書き込み側は `CommitmentStore.close` の `by` 引数の型で
   *    縛ってあるので、**この器が実際に書く値はこの2つに限られる。** ここが
   *    緩いのは読み出し側の耐性のためであって、書き込み側の規律を諦めた
   *    わけではない
   * 2. **ここを `z.enum` にしないこと。** `packages/storage-pg/src/
   *    commitments.ts` の `parseCommitment` は読めない行で throw し、
   *    `list()` はそれを try/catch 無しで map する — **未知の値が1つ
   *    入っただけで、その行ではなく台帳の一覧が丸ごと読めなくなる。**
   *    `closedBy` は由来の注記であって、台帳の完全性（「何を引き受けたか」
   *    が読めること）を担ってはいない。失敗の非対称で決めている —
   *    **寛容にして間違えば次の PR で直せるが、厳密にして間違えば台帳が
   *    読めなくなる**
   * 3. **`undefined`（そもそも無い）と、未知の値は別物である。** 未知の値
   *    （将来の書き手が増えた・外部から直接書かれた等）は**そのまま
   *    保持する**（`undefined` へ潰さない）。潰すと「この欄が入る前の行」
   *    と区別が付かなくなり、この欄を持たせた主旨そのものが壊れる。
   *    表示側（`apps/web/app/routes/commitments.tsx`）は
   *    `commitmentClosedBySchema.safeParse` で狭めてから分岐し、
   *    未知の値は `undefined` と別の倒れ先（`console.warn` 付き）へ倒す
   */
  closedBy: z
    .string()
    .optional()
    .describe(
      "既知の値は 'clone' | 'human'（commitmentClosedBySchema）。無いこともある" +
        '（この欄が入る前の行）。台帳の完全性より由来の注記の厳密さを優先しないため、' +
        '型としては任意の文字列を許す。',
    ),
  /**
   * `body` の**接頭辞を除いた本体**がどの記法で書かれているか
   * （`textMarkupSchema`。issue #287）。
   *
   * **`origin: 'manager'` の `body` は `` `[${event.kind}] ${event.text}` ``
   * の形で、接頭辞（`[report] ` 等）が前置されている**
   * （`packages/core/src/clone.ts` の `commitmentFor`）。この欄が指すのは
   * `event.text`（＝ `manager_message.markup` の指す文字列）であって、
   * 接頭辞を含む `body` 全体ではない。表示側（
   * `apps/web/app/routes/commitments.tsx`）は接頭辞を剥がしてから
   * `bodyMarkup` を当てる、という前提が両側で一致している必要がある。
   *
   * **ここも `z.enum` を置かない。** `closedBy` と同じ理由で、こちらは
   * `parseCommitment`（`packages/storage-pg/src/commitments.ts`）の射程に
   * 直接入る — 未知の値が1つ入るだけで台帳の一覧が丸ごと読めなくなる
   * （issue #296）ことを避けるため、保存層は寛容にし、既知の値の網羅性は
   * 書き込み側の型（`TextMarkup`）と表示側の narrow（`textMarkupSchema.
   * safeParse` ＋ `switch` ＋ `never` の網羅性チェック）で保つ。
   *
   * **`origin: 'manager'` 以外では立たない。** `commitmentFor` の他の
   * `case` は `bodyMarkup` を書かないので、`undefined` のままである。
   */
  bodyMarkup: z.string().optional(),
  /**
   * `body` を最後に直した時刻。編集していなければ無い。
   *
   * **なぜ本文を後から直せるようにするか。** 人間が積んだ依頼
   * （`origin: 'human'`）は、Web UI や API から一度送った後に誤字や
   * 言葉足らずに気づくことがある。台帳の目的は「頼まれたことを忘れさせない
   * こと」であって「一字一句を凍結すること」ではないので、まだ片付いて
   * いない行の `body` だけは直せるようにする（`CommitmentStore.editBody`）。
   *
   * **線は「書き換えられるのは常に自分自身の言葉だけ」である。** 直せる
   * 主体と `origin` の対応は2つだけで、どちらも「自分が書いた行を自分で
   * 直す」形になっている：
   *
   * - 人間（`PATCH /commitments/:id`、`apps/daemon/src/app.ts`）は
   *   `origin: 'human'` の行だけ。`POST /commitments` は `origin` を
   *   `'human'` に固定しているので、Web UI や API から積まれたものは必ず
   *   `human` である
   * - クローン（`commitment_edit`、`packages/core/src/tools.ts`）は
   *   `origin: 'self'` の行だけ。`commitment_open` が `origin` を
   *   `'self'` に固定しているので、クローンが自分で立てた行はここに入る
   *
   * **⚠️ かつてここには「クローンが自分で立てた行（`self`）やマネージャーの
   * 報告（`manager`）は誰にも書き換えられない」と書いてあった。`self` に
   * ついては issue #580 でそれが偽になった** — 人間がチャットでクローンに
   * 頼んで積まれた行が `self` なので、人間の主観では「自分が登録した仕事」
   * なのに誰も直せなかった。
   *
   * **`origin: 'manager'` の行はいまも誰も直せない。** `bodyMarkup`
   * （接頭辞の記法）が `origin: 'manager'` のときだけ立ち、`body` は
   * `` `[${event.kind}] ${event.text}` `` の形で接頭辞を含む
   * （`bodyMarkup` の doc）——本文を書き換えると、表示側が接頭辞を剥がして
   * `bodyMarkup` を当てるという両側の前提が壊れる。
   *
   * **それでも守っているものは変わらない。台帳は「クローンが何を引き受けたか」
   * の記録であり、そこが _静かに_ 書き換わるとクローンが過去の自分を
   * 追えなくなる** — 害として名指されているのは追跡不能であって、不変性
   * そのものではない（すぐ下の「原文は消えない」がその条件を持つ）。
   *
   * **原文は消えない。これは任意の付け足しではなく、上の線が成り立つための
   * 条件である。** `PATCH /commitments/:id` も `commitment_edit` も、編集の
   * 前後の本文を日誌（`journal.append`。追記専用）へ逐語で残す。だから
   * この欄が上書きされても、直す前の本文は日誌から読み戻せる——「静かに
   * 書き換わる」にならない。**日誌へ前後を残さない編集の口を足さないこと。**
   */
  editedAt: isoDateTime.optional(),
  /**
   * `body` を誰が直したか。**既知の値は `commitmentEditedBySchema`
   * （`'clone' | 'human'`）だが、ここは `closedBy` と同じ理由で `z.string()` に
   * 緩めてある**（そちらの doc を見よ——未知の値1件で台帳の一覧が丸ごと
   * 読めなくなることを避けるため）。`undefined` は「一度も編集していない」
   * であって、`closedBy` と同じく既定へは倒さない。
   */
  editedBy: z
    .string()
    .optional()
    .describe(
      "既知の値は 'clone' / 'human'（commitmentEditedBySchema）。無ければ一度も編集されていない。" +
        '台帳の完全性より由来の注記の厳密さを優先しないため、型としては任意の文字列を許す。',
    ),
});

export type CommitmentOrigin = z.infer<typeof commitmentOriginSchema>;
export type CommitmentClosedBy = z.infer<typeof commitmentClosedBySchema>;
export type CommitmentEditedBy = z.infer<typeof commitmentEditedBySchema>;
export type Commitment = z.infer<typeof commitmentSchema>;

/**
 * 台帳の1行が `commitmentSchema` として読めなかったときに、その行の代わりに
 * 一覧へ載せるもの（issue #296）。
 *
 * **なぜ型を足すか。** 直したいのは「1行読めなくても一覧が丸ごと落ちない」こと
 * だが、それだけだと読めなかった行は一覧から静かに消えるだけになる —
 * `Commitment[]` を返す関数の型はそのままなので、呼び出し側は握り潰したことに
 * すら気づけない。`CommitmentStore.list`（`store.ts`）の返り値をこの型を含む
 * 形へ変えることで、「読めない行が在る」ことを呼び出し側がコンパイル時に
 * 無視できないようにする。件数やログではなく型で持たせるのはそのためである。
 *
 * **「無い」でも「片付いた」でもない第3の状態である。** 空配列（無い）へ潰すと
 * `parseCommitment`（`packages/storage-pg/src/commitments.ts`）の doc が防ごう
 * としている結末 — クローンが引き受けたことを二度と思い出さない — へそのまま
 * 着く。
 *
 * **⚠️ `reason` に本文を混ぜないこと。** zod の `safeParse` が返すエラー
 * メッセージは欄名と型の食い違いしか含まないのでそのまま使ってよいが、
 * `JSON.stringify(生の値)` を足さないこと（`dropped-record.ts` の doc — #52 で
 * テスト出力（`railway/setup.test.ts` の差分アサーション）へ秘密が全文で
 * 出た事故が根拠である）。
 */
export const unreadableCommitmentSchema = z.object({
  /** 台帳の列 / 生の値から取れた id。取れないこともある（fs 版で本体が id を持たない形のとき）。 */
  id: z.string().optional(),
  /** 受け取った時刻。pg 版は列から取れる。fs 版は取れないことがある。 */
  at: isoDateTime.optional(),
  /** なぜ読めなかったか。**依頼の本文（`body`）を載せないこと**（`dropped-record.ts` と同じ制約）。 */
  reason: z.string(),
});
export type UnreadableCommitment = z.infer<typeof unreadableCommitmentSchema>;

/**
 * 一覧の `updatedAt`（更新＝片付けた時刻。まだなら受け取った時刻）を出す。
 *
 * **なぜここへ寄せたか。** かつては MCP（`tools.ts`）と CLI（`apps/cli/src/chat.ts`）
 * のそれぞれの実装側に `commitment.closedAt ?? commitment.at` がそのまま書かれて
 * いた。この repo は「導出が各実装の側にあって、書き忘れても何も落ちない」形で
 * 同じ壊れ方を既に3回踏んでいる（`.claude/skills/listing-and-detail/SKILL.md` の
 * 表、`digest.ts` の `omitted()` の doc — 「節ごとに手で書いていたのをここへ
 * 寄せた。…この行が各節の実装の側にあって、書き忘れても何も落ちなかったから
 * である」）。ここもその形だったので、スキーマの隣の共有ヘルパへ寄せ、3面
 * （MCP / HTTP / CLI）がこれを呼ぶ形にする。
 *
 * `Pick<>` で受けるのは、HTTP の応答型など `Commitment` の全欄を持たない値
 * からも呼べるようにするため。`GET /commitments` は `updatedAt` を返す欄を
 * 足してあり（`apps/daemon/src/app.ts`）、このヘルパをそのまま呼ぶ。
 */
export function commitmentUpdatedAt(entry: Pick<Commitment, 'at' | 'closedAt'>): string {
  return entry.closedAt ?? entry.at;
}

/**
 * まだ片付いていない台帳の行に、クローンから人間への返答が日誌に見つかるかを
 * 導く（issue #1003「放置」と「進行中」が同じ顔をしている問題）。
 *
 * **⭐ 設計の要（issue #1003）: 状態はクローンが申告するのではなく、既に在る
 * 記録から導く。** クローンが手で維持する欄を新しく足すと、クローンはそれを
 * 忘れる——この Issue の発端そのものが「返答したら閉じる」という既存の規則を
 * クローンが忘れていたことなので、新しい欄を足せば同じ形の失敗をもう一度
 * 作ることになる。だからここは新しい状態を「書く」場所を作らず、既存の
 * `exchange`（日誌）を読むだけにしてある。返す値も、`updatedAt` /
 * `commitmentUpdatedAt` と同じで**加算のみ**（既存の欄は1つも変えない）。
 *
 * ## `origin: 'human'` のうち、実際に一致するのはチャット発の行だけである
 *
 * `origin: 'human'` の `commitment.source` は、生まれた経路によって中身の
 * 意味が違う（`commitmentFor`、`packages/core/src/clone.ts`）:
 *
 * 1. **チャット**（`human_message`）— `source` は本物の会話 id。
 *    `inboxEventSchema` の `human_message.conversationId` は必須（省略できない）
 *    ので、この経路の行は必ず会話 id を持つ
 * 2. **承認待ちへの回答**（`human_answer`）— `source` は `approvalId` である。
 *    会話 id ではない
 * 3. **人間が API/CLI から直接積んだもの**（`POST /commitments` の
 *    `commitmentBody.source`）— 呼び出し側が渡した任意の文字列（省略もできる）。
 *    会話 id とは限らない
 *
 * この3つを見分ける専用の欄は無い。だから2・3の行は、`source` を会話 id として
 * 引いても日誌の会話に一致せず、この関数は `undefined` を返す——**これは欠陥
 * ではない。** `source` が実際に会話 id として機能する行（1）にだけこの導出を
 * 当てた結果であり、2・3の行は「導出できる材料が無い」側に残るだけで、新しく
 * 誤ったラベル（「放置されている」）を主張することはない。
 *
 * ## `人間の回答待ち`（3値目）はここに含めない
 *
 * `PendingApproval`（`ask_human` の承認待ち）と `Commitment` を結ぶ id は
 * リポジトリのどこにも無い（`commitmentId` は0件。issue #1003 の実測）。
 * 結べないものを出すと判定を丸めた嘘になる——issue が明示している線
 * （「結べないなら『人間の回答待ち』は出さない」）どおり、この関数は
 * 「未着手」と「返答済み・未クローズ」の2値だけを扱う。
 *
 * ## `exchange.conversationId` が無い行について
 *
 * `journalEntrySchema` の `exchange.conversationId` は型としては optional
 * である。ただし現行のすべての書き込み経路
 * （`packages/core/src/clone.ts` の `#record` / `#reportFailure` /
 * `turn_ended` の3か所——`with: 'human'` を書くのはこの3か所だけ）は、
 * `with: 'human'` の行に限っては必ず `conversationId` を添えて書く
 * （`conversationId === null` のときは `with: 'self'` へ倒れ、`'human'` には
 * ならない設計になっている）。**これは今のコードについて言えることであって、
 * 過去に書かれた行や将来の書き手についての保証ではない**——`conversationId`
 * を持たない `with: 'human'` の行が万一在れば、この関数はそれを日誌の会話に
 * 一致させられず「未着手」側へ残るので、静かに「返答済み」を取りこぼす形は
 * まだ理論上ありうる（PR 本文に書いた確認の範囲を参照）。
 *
 * @param commitment 判定したい1行（`origin` / `source` / `at` だけで足りる）。
 * @param humanOutboundRepliesByConversation 会話 id → その会話でクローンが
 *   人間へ返した `exchange`（`with: 'human'`, `role: 'outbound'`）の `at` を
 *   **昇順に並べたもの**。呼び出し側（`GET /commitments`）が日誌から1回だけ
 *   組み立てて全行で使い回す——行ごとに日誌を読み直さない
 *   （`.claude/skills/listing-and-detail/SKILL.md` と同じ「一覧ごとに手で
 *   書かない」発想）。
 * @returns 一致した最初の返答時刻（ISO 8601）。無ければ `undefined`
 *   （＝「未着手」側の残余に落ちる——`未着手` は別の状態として書き込まれる
 *   ものではなく、この関数が `undefined` を返したときの残余として画面側が
 *   決める）。
 */
export function commitmentRespondedAt(
  commitment: Pick<Commitment, 'origin' | 'source' | 'at'>,
  humanOutboundRepliesByConversation: ReadonlyMap<string, readonly string[]>,
): string | undefined {
  if (commitment.origin !== 'human' || commitment.source === undefined) return undefined;
  const replies = humanOutboundRepliesByConversation.get(commitment.source);
  if (replies === undefined) return undefined;
  // **昇順である前提で、`at` を初めて超えた時刻を返す。** 並びの契約は上の
  // JSDoc（呼び出し側が組み立てる）が持つので、ここで並べ直さない——
  // ソートは1回、組み立て側だけで行う。
  return replies.find((at) => at > commitment.at);
}

/**
 * まだ片付いていない台帳の行に、いまも走っている委譲（マネージャー）があるかを
 * 導く（issue #1003 段2「進行中（委譲あり）」）。
 *
 * **`commitmentRespondedAt`（直上）と対になる関数。** 材料が日誌の `exchange`
 * か台帳の `Job` かが違うだけで、形は同じ——呼び出し側（`GET /commitments`）が
 * 会話 id ごとに1回だけ組み立てた地図を全行で使い回し、この関数は1行ぶんの
 * 判定だけを行う。
 *
 * ## 対象になる行は `commitmentRespondedAt` と同じ制約を持つ
 *
 * `origin: 'human'` のうち、`source` が本物の会話 id として機能するのは
 * チャット経由の行だけである（`commitmentRespondedAt` の doc の3経路の説明を
 * 参照）。それ以外の行はここでも `undefined`（＝判定材料が無い）を返す。
 *
 * ## `at` より後に始まった委譲だけを数える
 *
 * 同じ会話の中に複数の未了行が在りうる（人間が同じ会話で何度も頼む形）ので、
 * **その行が作られた後に始まった委譲**だけを一致とみなす——`commitmentRespondedAt`
 * が「行より後に届いた返答」だけを見るのと同じ理由（行より前の委譲は、別の
 * 古い頼みごとに応えたものである可能性が高い）。**これは正確な1対1の紐付けを
 * 作るものではない** — 同じ会話の中で同じ時間帯に複数の委譲・複数の未了行が
 * 並行していれば、無関係な行にも「進行中」が付きうる（`Job.conversationId`
 * の doc の限界の節）。それでも「この会話では何も動いていない」と「この会話で
 * 何かが走っている」の区別には十分に効く。
 *
 * @param commitment 判定したい1行。
 * @param activeManagersByConversation 会話 id → **いま走っている**
 *   （`status` が `running` か `waiting_human`）マネージャーの `managerId` と
 *   `createdAt` の組。呼び出し側（`GET /commitments`）が `stores.jobs.listJobs()`
 *   から1回だけ組み立てて全行で使い回す。
 * @returns 一致した `managerId` の配列。1件も無ければ `undefined`
 *   （＝「進行中」ではない側の残余）。
 */
export function commitmentActiveDelegationIds(
  commitment: Pick<Commitment, 'origin' | 'source' | 'at'>,
  activeManagersByConversation: ReadonlyMap<
    string,
    readonly { managerId: string; createdAt: string }[]
  >,
): string[] | undefined {
  if (commitment.origin !== 'human' || commitment.source === undefined) return undefined;
  const managers = activeManagersByConversation.get(commitment.source);
  if (managers === undefined) return undefined;
  const ids = managers.filter((m) => m.createdAt > commitment.at).map((m) => m.managerId);
  return ids.length === 0 ? undefined : ids;
}

// ---------------------------------------------------------------------------
// ジョブ・承認待ち
// ---------------------------------------------------------------------------

/**
 * ジョブの状態。
 *
 * - `running`: マネージャーが手を動かしている
 * - `waiting_human`: 上（クローン、必要なら人間）の返事待ちで、**その仕事だけ**が止まっている
 * - `done`: **マネージャー自身のターン**が終わって待機中。セッションは生きているので
 *   追加指示を送れる。その下で作業者が走っているかまでは見ていない
 * - `failed`: セッションが落ちた
 * - `lost`: **前のセッションへ戻れなかった。** 自動では挑み直さない
 * - `stopped`: **明示的に止められ、runner のセッション一覧から消えたことを確かめた
 *   終端。** ただし「話しかけても続かない」は誤りだった（2026-08-22 訂正）——
 *   デーモンが**自動では**起こし直さないだけである（`restore()` / `#reattach()`
 *   のホワイトリストは `running` / `waiting_human` のみで `stopped` を含まない。
 *   `manager.ts`）。`abort()` は `job.sessionId` を消さないので、**人間・クローン
 *   の明示的な `manager_send` なら続きへ戻せる**（`lost` と同じ扱い。`send()` が
 *   `record.attached === false` を見て resume を投げ、戻れたら `status` を
 *   `running` へ書き戻す）。ここを本当に「続かない」にすると、人間が止めた
 *   Claude Code のセッションを `--resume` で戻せる能力を消すことになり、
 *   `docs/north_star.md` の禁止2（追加制限禁止）に触れる
 *
 * 「終わったら片付ける」ためのものではない。人間が Claude Code の窓を開いたまま
 * にしておくのと同じで、`done` は死ではなく待機である。
 *
 * **どれも「デーモンが観測できたこと」でしかない。** ここに並んでいるのは仕事の
 * 進み具合ではなく、セッションの見え方である。`running` は「走らせた」であって
 * 「進んでいる」ではない（分類器の拒否で手が止まっていても `running` のままで、
 * それは `manager_list` が状態に添える拒否の件数のほうに出る）。
 *
 * **`lost` を `done` と一緒にしない。** `done` は「終えて待っている」であり、
 * 話しかければ続く。`lost` はそのどちらでもない — **続ける手立てが無い**。ここを
 * 潰すと、戻せなかった仕事が「完了」として片付き、誰も起こし直さないまま消える。
 * クローンが「起こし直す対象」として見分けられる形で残すためにある
 * （roadmap M5 受け入れ基準4）。
 *
 * **ただし `lost` は「成果が無い」ではない。** 観測しているのは「戻れなかった」
 * ことだけで、デーモンは PR もブランチも見に行かない（リポジトリの事情は
 * マネージャーの領域である）。落ちる直前にマージまで済ませていた仕事が `lost` に
 * なった例が実際にある。**起こし直すかどうかは、外へ出た成果（PR・コミット・送信済みのメール・登録済みの予定・投稿先など）を確かめてから決める。**
 *
 * **`stopped` を `done` と一緒にしない。** どちらも「セッションは生きているように
 * 見えるかもしれない」状態だが、`done` は**自分から手を離しただけ**（待てば/話し
 * かければ続く）で、`stopped` は**外から止められ、実際に runner から消えたことを
 * 確かめた**終端である。ここを混ぜると、止めたはずのマネージャーが「待機中」と
 * 見えて話しかけられる相手が残る（`manager.ts` の `abort()` の doc）。
 */
export const jobStatusSchema = z.enum([
  'running',
  'waiting_human',
  'done',
  'failed',
  'lost',
  'stopped',
]);

export type JobStatus = z.infer<typeof jobStatusSchema>;

/**
 * `job-status-running.ts` の {@link JobStatusLike}（手書き）が、この zod
 * スキーマから推論した {@link JobStatus} と構造的に一致することの強制
 * （`_AssertAnsweredViaMatchesLikeType` と同じ形。9回目の横断レビュー指摘）。
 *
 * 軽い口（`job-status-running.ts`）は zod を import できないので、
 * `JobStatus` をそのまま使えず、同じ形を手で書き写している。**ここが崩れると、
 * 両者は静かにずれうる**——`jobStatusSchema` に選択肢を足しても
 * `JobStatusLike` を書き換え忘れれば、`isRunningJobStatus` の型はいまの
 * 6値のままで新しい値を受け付けられず、この `typecheck` が落ちて初めて
 * 気づく。**これは事故ではなく歯である**——新しい値を「実行中」に入れるか
 * 外すかを、`isRunningJobStatus` の `switch` へ明示的に足すまで
 * `pnpm typecheck` が赤いままにするための仕掛け。相互に `extends` させ、
 * 片方でも欠けたら `false` になって `AssertTrue<false>` が落とす。
 */
export type _AssertJobStatusMatchesRunningLikeType = AssertTrue<
  [JobStatus] extends [JobStatusLike] ? ([JobStatusLike] extends [JobStatus] ? true : false) : false
>;

/**
 * workspace の所在（M4 で置く継ぎ目）。
 *
 * 文字列のパスだけにしないのは、**runner が増えたときに移送の話になる**からである
 * （M5）。共有 FS や git からの再構築へ伸ばせる形で JobStore に残しておく。
 * ここが欠けると、runner が落ちたときに「どこで何を触っていたのか」が復元できない。
 *
 * **新しく書かれる形は運用選択 `ALTEROID_WORKSPACE_KIND` で決まる**
 * （`manager.ts` の `resolveWorkspacePolicy` → `workspaceLocatorFrom`）。
 * 設定が無い・読めない（`=git` で `ALTEROID_WORKSPACE_REPOSITORY` が無いときも）
 * ときは `unknown` へ倒れる。デーモンには永続性を確かめる手段がまだ無いからで、
 * 詳しい理由はその変種の doc に在る。いまの配備はこれを設定していないので、
 * 本番で書かれるのは `unknown` である（#1376）。
 * `runner-volume` は、運用者が `ALTEROID_WORKSPACE_KIND=runner-volume` と明示
 * したときに書かれるほかは、**それ以前に書かれた行が名乗っている値**であり、確かめた
 * 結果ではない（「それ以前」は `unknown` が入った #216 より前）— 新旧で意味が
 * 違うので、読むときに混ぜないこと。
 */
export const workspaceLocatorSchema = z.discriminatedUnion('kind', [
  /** その runner に固定された volume。M4 の既定。 */
  z.object({
    kind: z.literal('runner-volume'),
    runnerId: z.string(),
    path: z.string(),
  }),
  /** 複数 runner から見える共有ファイルシステム（M5 の選択肢）。 */
  z.object({ kind: z.literal('shared-volume'), path: z.string() }),
  /**
   * **どこに在るかは分かるが、入れ替えを跨いで残るかは確かめられなかった。**
   *
   * `runner-volume` は「その器のボリュームに在る」＝**残る**と読める値である。
   * ところがデーモンには、runner の `/workspace` がボリュームなのかどうかを知る
   * 手段が無い（名乗りに入っていない。`runner-protocol.ts` の `workspacePath` は
   * パスであって永続性ではない）。**確かめずに `runner-volume` と書くと、台帳が
   * 存在しない永続性を主張することになる** — ボリュームを付けない構成
   * （`railway/README.md`「workspace は毎デプロイで消える」）では実際に偽になり、
   * しかも**「復旧できる」と信じる方向へ嘘をつく。**
   *
   * だから確かめられないときは値を作らず、**何が取れなかったのかを `reason` に
   * 書いて残す**（AGENTS.md の地雷表「取れない軸に 0 の行を作る」の処方）。
   * `runnerId` と `path` は**確かめずに言える**ので落とさない — 分からないのは
   * 永続性だけである。
   */
  z.object({
    kind: z.literal('unknown'),
    runnerId: z.string(),
    path: z.string(),
    /** なぜ確かめられなかったか。**空にしないこと**（理由の無い「分からない」は値と同じである）。 */
    reason: z.string(),
  }),
  /** git から作り直す（M5 の選択肢。未コミット差分は別途退避が要る）。 */
  z.object({
    kind: z.literal('git'),
    repository: z.string(),
    ref: z.string(),
    patchId: z.string().optional(),
  }),
]);

export type WorkspaceLocator = z.infer<typeof workspaceLocatorSchema>;

/**
 * 貸し出し期限（lease）— **この委譲を、いまどのプロセスが握っているか**（M5 PR4）。
 *
 * ## なぜ `runnerId` だけでは足りないか
 *
 * `runnerId` は宛先の名前で、器を作り直しても同じである（台帳の鎖
 * `manager_id → runner_id` がそれで繋がっている）。だから名前だけでは
 * 「いまその名前に応えているプロセスが、さっき仕事を渡した相手と同じか」が言えない。
 * `instanceId`（runner が起動ごとに作る乱数。`apps/runner/src/app.ts`）を並べて初めて
 * **握っているプロセスの同一性**が表せる。
 *
 * ## なぜ期限が要るか
 *
 * 「落ちた」は観測の欠落であって停止の証明ではない（roadmap M5）。黙った器の仕事を
 * 別の器へ起こし直すと、実は生きていた器と合わせて**同じマネージャーが2台で走る** —
 * `gh pr create` のような取り返しのつかない操作が二重に走る。だから引き取る側は
 * 「もう動いていない」を**片側だけで言える材料**を要る。それがこの期限である
 * （判定は `lease.ts` の `judgeLease`、runner 側の自己失効は `runner.ts`）。
 *
 * **時刻はすべてデーモンの時計である。** 器をまたいで時計を合わせる前提を置かない
 * （合っていないことに気づく場所が無い）。runner へ渡すのは `ttlMs`（相対）だけで、
 * あちらは受け取った瞬間から自分の時計で数える。
 */
export const jobLeaseSchema = z.object({
  /** 貸し出し先の宛先の名前。**台帳の鎖と同じ値**（ここで別の名前へ繋ぎ変えない）。 */
  runnerId: z.string(),
  /**
   * いまその名前に応えているプロセス（runner の `/health` の `instanceId`）。
   *
   * **欠けることがある。** `identity()` を持たない runner（同一プロセスの
   * `runner-local` や古い器）は名乗らないので、そのときは**判定しない**
   * （「入れ替わっていない」とも「入れ替わった」とも読まない。`judgeLease` 参照）。
   */
  instanceId: z.string().optional(),
  /**
   * 世代番号。**引き取るたびに1つ増える**（fencing token）。
   *
   * runner はセッションごとに最後に受け取った世代を覚えていて、**それより古い世代の
   * 命令を拒む。** これが無いと、引き取りの後に遅れて届いた古い命令が、新しい世代の
   * セッションへ黙って混ざる。
   *
   * **返しても 1 へ戻さない**（返却は `releasedAt` を立てるだけで、この欄は残す）。
   *
   * かつては返却でこの欄ごと消していた。「世代が意味を持つのは runner のセッションが
   * 生きている間だけだから、数え直してよい」という理屈だったが、**その前提は保証
   * されていなかった。** 返却の契機（`closed`）は runner から遅れて届きうるので、
   * 「返した」と「そのセッションはもう無い」がずれる。ずれた側で数え直すと、runner が
   * 覚えている世代より小さい世代を渡すことになり、**runner はその命令を拒む
   * （409）** — 生きているマネージャーへ永久に届かなくなり、届かないことを
   * 「戻せなかった」と読んだ側が新しく起こし直して**二重実行になる。**
   *
   * だから単調に増やす。**返却は「もう握っていない」を表すだけで、数え直しの合図
   * ではない。**
   */
  fence: z.number().int().nonnegative(),
  /** 貸し出した時刻。 */
  grantedAt: isoDateTime,
  /**
   * デーモンが**最後にこの貸し出し先の生存を確かめた時刻**。
   *
   * ここが古いことは「落ちた」を意味しない（見に行っていないだけのこともある）。
   * 判定に使うのは `judgeLease` であって、この値の古さそのものではない。
   */
  seenAt: isoDateTime,
  /**
   * 貸し出し先が**自分で畳むまでの猶予**（ミリ秒）。runner へ渡した値の写しである。
   *
   * 写しを持つのは、引き取る側が「あちらはいつ自分で畳むと約束したか」を台帳だけから
   * 言えるようにするため（渡した値を後から変えても、この委譲に効いている約束は
   * 渡した時のものである）。
   */
  ttlMs: z.number().int().positive(),
  /**
   * **返した時刻**（もう握っていない）。立っていれば、次の引き取りは期限を待たない。
   *
   * **消すのではなく印を立てるのは、世代（`fence`）を残すためである**（上の項）。
   * 返却の契機は「持ち主自身がそのセッションを終えたと言った」（`closed`）か
   * 「止まったと確かめた停止」だけで、**確かめていない停止では立てない。**
   */
  releasedAt: isoDateTime.optional(),
});

export type JobLease = z.infer<typeof jobLeaseSchema>;

/**
 * `manager_stop`（running・非 force）が `pool.unpushedWork()` から取った、
 * 作業ツリー1本ぶんの枝名の写し（Issue #1228 候補(1)）。
 *
 * **`relativePath` / `branch` / `remoteOrigin` の意味は `runner-protocol.ts` の
 * `unpushedWorkTreeSchema` と同一だが、同じ zod スキーマの参照ではない。**
 * `runner-protocol.ts` は `schema.ts` から `jobStatusSchema` 等を import して
 * いる（`grep -Fn -- "from './schema.js'" packages/core/src/runner-protocol.ts`
 * で当たる）ので、逆向きの import（ここから `unpushedWorkTreeSchema` を
 * 引く）は循環参照になる。**だから形だけを独立して複製する。** 複製が
 * 二重管理の実害を生むとしても、この3欄（`relativePath` / `branch` /
 * `remoteOrigin`）が単体で変わることはまず無いと判断した——変えるなら
 * 両方を見比べながら直すこと。
 *
 * 出してよい範囲（有無・件数・枝名まで。ファイル名・差分の中身・
 * コミットメッセージ・author は含まない）は `unpushedWorkTreeSchema` の doc
 * が引いた線をそのまま継ぐ——ここは既に線の内側に在る値を運ぶだけで、
 * 新しい調べものはしない。**Issue #1376 B2 でその線に開けた1点の穴
 * （origin remote の host/path。userinfo・クエリ・フラグメント・資格・
 * 生の URL 文字列は落とす）も、同じく `unpushedWorkTreeSchema.remoteOrigin`
 * の doc をそのまま継ぐ。**
 */
export const observedWorktreeBranchSchema = z.object({
  /**
   * 探索の起点（`unpushedWorkResultSchema.cwd`）からの相対パス。**2026-09-24
   * のクローンの決定（オーナーの決定ではない）で、`cwd` の外で見つかった
   * ツリーはここへ絶対パスが入るようになった**——`unpushedWorkTreeSchema.
   * relativePath`（`runner-protocol.ts`）の doc をそのまま継ぐ。
   */
  relativePath: z.string(),
  /** いまの枝名。detached HEAD、または確かめられなかったときは `null`。 */
  branch: z.string().nullable(),
  /**
   * origin remote の host と path（Issue #1376 B2）。取れなかった・
   * 解釈できなかったときは省く——`unpushedWorkTreeSchema.remoteOrigin` の
   * doc（落とすもの: userinfo・クエリ・フラグメント・資格・生の URL）を
   * そのまま継ぐ。
   */
  remoteOrigin: z
    .object({
      host: z.string(),
      path: z.string(),
    })
    .optional(),
  /**
   * 件数の写し（Issue #2751）。`unpushedWorkTreeSchema` の同名の欄をそのまま
   * 継ぐ（有無・件数まで——「出してよい範囲」の内側）。器が入れ替わった後の
   * 再開の案内が、未 push のコミットを失った事実を件数つきで言うために要る。
   * 古い行・古い runner は持たない（省略。`0` で埋めない）。
   * 件数は `--remotes=origin` 基準で多めに出る側の誤差（`unpushedWorkTreeSchema` の doc）。
   */
  unpushedCommitCount: z.number().int().nonnegative().optional(),
  /** `unpushedCommitCount` を確かめられなかった理由。 */
  unpushedCommitCountUnknown: z.string().optional(),
  /** 未コミットの変更の件数（`git status --porcelain` の行数）。 */
  uncommittedChangeCount: z.number().int().nonnegative().optional(),
  /** `uncommittedChangeCount` を確かめられなかった理由。 */
  uncommittedChangeCountUnknown: z.string().optional(),
});

export type ObservedWorktreeBranch = z.infer<typeof observedWorktreeBranchSchema>;

/**
 * 未 push の作業ツリーの観測の最後の1回（Issue #1228 候補(1)）。**「最後に
 * 取れた回」であって「`manager_stop` のときだけ」ではない**——更新する
 * 呼び出し元は下の「残る族」を見よ。
 *
 * ## なぜ足すか
 *
 * `unpushedWorkTreeSchema.branch`（`runner-protocol.ts`）は `manager_stop` の
 * 断り文（`tools.ts` の `describeUnpushedWork`）へ文字列として描かれるだけで、
 * 台帳には一度も残らない——器が消えると、どの枝を見ればよいかの鍵が器の側に
 * 0になる、という Issue #1228 の指摘そのものを埋める。**新しい能力は足さない
 * ——既に取れている値を捨てずに残すだけである。**
 *
 * ## `unavailable` の意味（`workspaceLocatorSchema` の `unknown` + `reason` と
 * 同じ形）
 *
 * `kind: 'unavailable'` は「確かめようとしたが取れなかった」ことそのものを
 * 名乗る。**この欄が丸ごと `undefined`（一度もこの分岐を通っていない）と、
 * `kind: 'unavailable'`（通ったが取れなかった）を混ぜないこと**
 * （AGENTS.md「取れない軸に0の行を作る」の処方。`ManagerPool.unpushedWork()`
 * の戻り値である `ManagerUnpushedWork` の `kind: 'unavailable'` をそのまま写す）。
 *
 * ## 残る族（⛔ この欄が更新されない回）
 *
 * 更新するのは、`pool.unpushedWork()` が呼ばれた回（下の1〜3・6）と、runner が
 * 自分で先取りして運んだ観測を `manager.ts` が台帳へ写す回（下の4・5）の、
 * 合わせて6つの経路だけである:
 *
 * 1. `manager_stop`（`before.status === 'running' && force !== true`）の断り
 * 2. **委譲のターンが報告で終わったとき**（`manager.ts` の `case 'report'`。
 *    Issue #1266 の (4)。本番でこの経路が一度も発火していなかったため足した）
 * 3. **Bash で `git push` か、新しい枝を作る操作（`git checkout -b`／
 *    `git switch -c`／`git worktree add`／`git branch <名前>` 等。
 *    `bashCommandLooksLikeGitBranchCreate` の doc を見よ）を検出したとき**
 *    （`manager.ts` の `case 'tool_use'`。前者は Issue #1376 の続き——器の
 *    入れ替え・枠落ちで、最初の報告より前に落ちた委譲は枝名が引けない、
 *    という残っていた穴を、その委譲が一度でも `git push` を打っていれば
 *    埋める。後者は 2026-09-24T14:40Z のコメントが名指しした「枝ができた
 *    とき」を足したもので、`git push` を一度も打たずに落ちた委譲でも、
 *    枝さえ作っていれば埋まるようにする）
 * 4. **セッションが `closed`（`done` / `lost` / `failed`）で終わるとき**
 *    （`manager.ts` の `case 'closed'`。Issue #1266 候補(2)）。上の1〜3は
 *    どれも「セッションがまだ生きていて、次のターンか道具の実行が起きた
 *    とき」にしか発火しないので、**枠落ち（429）や失敗でセッションが
 *    `closed` になる経路（1〜3のどれも届く前に器を失う回）は、以前は
 *    この欄が一度も更新されなかった。** `runner.ts` の `RunnerSession#finish()`
 *    が `closed` を emit する直前に `unpushedWork()` を1回取り、
 *    `runnerEventSchema` の `closed.unpushedWork`（optional。古い runner の
 *    `closed` は壊さない）として運ぶ——デーモン側が `closed` を受けてから
 *    改めて runner へ問い合わせても、`#finish()` は emit と同じ同期区間で
 *    `#onClosed()`（セッションの削除）を呼ぶのでほぼ空振りする、という
 *    理由による（`closed.unpushedWork` の doc）。**上書きガード**
 *    （`manager.ts` の `isUnpushedWorkObservationAtLeastAsNewAs`）——2〜3の
 *    fire-and-forget（`#observeUnpushedWorkOnce`）と4・5は同じ委譲について
 *    非同期に競走することがあるため、`at` を比べて古い観測では上書きしない。
 * 5. **日常の redeploy（SIGTERM → `host.shutdown()` → `session.stop()`）で
 *    runner が止まる直前**（`manager.ts` の `case
 *    'shutdown_unpushed_work'`。Issue #1266 候補(C)）。`stop()`（`Host#
 *    shutdown()` 経由）は4と違って `closed` を出さない設計のままだが、
 *    `RunnerSession#stop()` は畳みの最後に `unpushedWork()` を1回取り、
 *    `runnerEventSchema` の `shutdown_unpushed_work`（`closed` とは別の
 *    イベント）として運ぶ。**best-effort である——届く保証は無い。** outbox
 *    （`RunnerHost` から先）は #629 が示した喪失の窓を持ち、SIGTERM は
 *    デーモン側の SSE 購読が同じタイミングで切れかけていることがある瞬間
 *    そのものである。届かなかった回はこの経路自体が発火しないので、
 *    **この欄は「取れなかった」（`kind: 'unavailable'`）にすらならず、既存の
 *    観測（無ければ `undefined`）がそのまま残るだけである**——0件も
 *    `unavailable` も新しく作らない（`shutdown_unpushed_work` の doc・
 *    `AGENTS.md`「取れない軸に0の行を作る」と同じ注意）。
 * 6. **`manager.ts` の `abort()` が `runner.stop(managerId)`（＝`Host#
 *    stop(managerId)`）を呼ぶ直前**（Issue #1266 残り2）。`abort()` は
 *    `manager_stop`（`force: true` の running、または非 force の
 *    `done`/`waiting_human`）・人間が Web UI / `DELETE /managers/:id` で
 *    止めたとき・`#autoFoldOne`（`by: 'auto-fold'`）のすべてで通る唯一の
 *    経路である。`#confirmStoppedAndReleaseLease`（`runner.stop()` を呼び、
 *    一覧から消えたことを確かめる関数）を呼ぶ**前**に `pool.unpushedWork()`
 *    を1回取る——`vacate()`（5行上の5とは別で、こちらは Issue #1266
 *    候補(2)(B)）が `runner.stop()` の直前に取るのと同じ形。**5と違い、
 *    ここは runner 側の best-effort な先取りではない**——呼び出し元
 *    （デーモン）はまだ生きて runner と往復できる状態でこの停止を発行する
 *    ので、要求と応答の1回の同期呼び出しで足りる（`runner-protocol.ts` の
 *    `shutdown_unpushed_work` の doc「どの `stop()` から出るか」が、
 *    `Host#stop(managerId)` はこの形で埋める設計だと既に述べていた）。
 *
 * **それでも更新されない回が残る。** `manager_list` 自身は、この一覧のために
 * 自動で往復を足さないという既存の作法（`ManagerPool.unpushedWork()` の
 * doc）のとおり、どの経路からも呼ばれない。**`runner プロセスそのものが
 * `#finish()` も `#stopBody()` も `abort()` の呼び出しも経ずに落ちた回**
 * （コンテナごと OOM-killed・SIGKILL・`FORCED_EXIT_MS` の期限そのものに
 * 間に合わなかった回等）も、`closed` も `shutdown_unpushed_work` も6の
 * 同期呼び出しも届かないので同様に拾えない。
 * ⟹ **報告の前に落ちた委譲は、その委譲が一度も `git push` を打たず、新しい
 * 枝も作っておらず、かつ `closed`（4）も `shutdown_unpushed_work`（5、
 * best-effort）も届かなかった場合にだけ拾えない**（最後の報告か、最後に
 * 検出した `git push`／枝作成／`closed`／`shutdown_unpushed_work` のうち
 * いちばん遅い時点の観測が残るだけである）。`git push` や枝作成の実行その
 * ものの最中に器が落ちた回も拾えない——検出は runner の `PostToolUse`
 * フック経由なので、コマンドの完了後にしか届かない（`manager.ts` の
 * `case 'tool_use'` のコメントを見よ）。呼び出し元は
 * `grep -rn 'unpushedWork' --include=*.ts packages/ apps/` で当たる。
 * **この欄が在ることを「常に最新の枝が分かる」とは読まないこと。**
 *
 * ## `source`（どの経路で取ったか。クローンの指摘を受けて追加）
 *
 * **時刻（`at`）だけでは足りない。** 器の入れ替えで委譲のセッションを見失った
 * とき（`ManagerRecord.sessionMissingSince` が立つ）、台帳にはその**前**の
 * ターン・報告が残した観測がそのまま残る——読み手はそれを「入れ替わった器が
 * 止まる直前にも0件だった」と誤読しうる（実際には、その観測はもっと前の、
 * 生きていたセッションの間に取られたものでしかない）。**`source` は、この
 * 観測を残した経路そのものを名乗る**——`unpushedWorkObservationSourceSchema`
 * の各値を見よ。
 *
 * **`.optional()` にしてある。** この欄を書かなかった版が書いた行（この
 * `source` を足す前に書かれた既存の行、または呼び出し元が明示的に
 * source を渡さなかった回）には無い——**無いことを、どれかの経路だと
 * 見なさない。**「不明」のまま扱う（`AGENTS.md`「取れない軸に0の行を作る」
 * と同じ注意——ここでは「経路 0（無い）」という値を作らず、欄ごと省く）。
 *
 * **読む側の使い方**（`tools.ts` の `describeUnpushedWorkObservation` が
 * 実装を持つ）: 委譲がいま器の入れ替えで応答不能（`sessionMissingSince` が
 * 立っている）なら、`source === 'shutdown'` かつ `at` がいまの
 * `runnerSessionSince`（このセッションが今の宛先に置かれたと確かめた時刻）
 * 以降であることを確かめてから、初めて「止まる直前の観測が届いた」と言う。
 * 満たさなければ（`source` が無い・古いセッションのものである・値そのものが
 * 別経路である）、「届いていない」側に倒す。
 *
 * ## 答えないこと
 *
 * この欄が答えるのは「どこ（どの枝）を見ればよいか」までである。**「成果が
 * 届いたか」（push 済みか・PR が在るか）は含まない**——それは `git ls-remote`
 * / `gh pr list` の側の答えであって、この欄の役割ではない。
 */
/**
 * `lastUnpushedWorkObservation` を残した経路（クローンの指摘を受けて追加）。
 *
 * **本文の「残る族」が挙げる6つの発火点は、実は8つの書き込み経路に対応する**
 * ——`pool.unpushedWork()`（`ManagerPool` の公開メソッド）を経由する5つ
 * （呼び出し元が違うだけで同じ実装 `#recordUnpushedWorkObservation` に
 * 収束する）と、runner が先取りして運ぶ直接書き込みの2つに分かれる:
 *
 * | 値 | 書き込む場所 | 発火点 |
 * | --- | --- | --- |
 * | `'stop-refusal'` | `tools.ts`（`manager_stop` running・非force の断り） | Issue #1037 |
 * | `'report'` | `manager.ts` `case 'report'` → `#observeUnpushedWorkOnce` | Issue #1266 (4) |
 * | `'tool_use'` | `manager.ts` `case 'tool_use'` → `#observeUnpushedWorkOnce` | Issue #1376 |
 * | `'auto-fold'` | `manager.ts` `#autoFoldOne`（`done` を自動で畳む前の安全弁） | Issue #1394 段⑥ |
 * | `'vacate'` | `manager.ts` `vacate()`（`runner.stop()` 直前の握手） | Issue #1266 候補(2)。#1453/#1472 |
 * | `'stop'` | `manager.ts` `abort()`（`#confirmStoppedAndReleaseLease`＝`runner.stop(managerId)` 直前の握手） | Issue #1266 残り2 |
 * | `'closed'` | `manager.ts` `case 'closed'`（runner の `#finish()` が先取り） | Issue #1266 候補(2) |
 * | `'shutdown'` | `manager.ts` `case 'shutdown_unpushed_work'`（runner の `stop()` が先取り） | Issue #1266 候補(C) |
 *
 * **`'auto-fold'` と `'vacate'` は、本文の「残る族」の番号付けが最初に付いた
 * ときには出てこなかった。** どちらも `pool.unpushedWork()` を呼ぶので観測は
 * 残るが、「断り」でも「終端」でもないので最初の5つの発火点の説明には数えて
 * いなかった——`source` を足すために全呼び出し元を洗い直して見つかった、
 * 既存の数え漏れである。**`'stop'` は Issue #1266 残り2として最初から本文の
 * 「残る族」6番目に数えて足した**——`'auto-fold'`/`'vacate'` と違って数え
 * 漏れではない。
 */
export const unpushedWorkObservationSourceSchema = z.enum([
  'stop-refusal',
  'report',
  'tool_use',
  'auto-fold',
  'vacate',
  'stop',
  'closed',
  'shutdown',
]);

export type UnpushedWorkObservationSource = z.infer<typeof unpushedWorkObservationSourceSchema>;

export const lastUnpushedWorkObservationSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('observed'),
    /** 観測した時刻。 */
    at: isoDateTime,
    /** どの経路で取ったか（`unpushedWorkObservationSourceSchema` の doc）。 */
    source: unpushedWorkObservationSourceSchema.optional(),
    /** 探索の起点（`unpushedWorkResultSchema.cwd` の写し）。 */
    cwd: z.string(),
    /** 見つかった作業ツリーぶんの枝名。0本のこともある。 */
    worktrees: z.array(observedWorktreeBranchSchema),
    /**
     * `unpushedWorkResultSchema.truncatedAtCount` の写し（Issue #1885）。
     * **省略できるが、黙って切ったことにはしない**——あちらの doc と同じ
     * 注意。この欄が載っているとき、`worktrees` は探索を打ち切った先に
     * 在ったかもしれない作業ツリーを含んでいない可能性がある。
     */
    truncatedAtCount: z.number().int().positive().optional(),
    /** `unpushedWorkResultSchema.stoppedEarly` の写し（Issue #1885）。 */
    stoppedEarly: z.literal(true).optional(),
    /** `unpushedWorkResultSchema.scratchRootsUnknown` の写し（Issue #1885）。 */
    scratchRootsUnknown: z.string().optional(),
    /**
     * `unpushedWorkResultSchema.unreadableDirCount` の写し（Issue #1885）。
     * **`unreadableDirSample` は写さない**——`<パス>: <エラーメッセージ>` の
     * 形で絶対パスを含みうるため、`unpushedWorkTreeSchema` の doc が引く
     * 「出してよい範囲（有無・件数・枝名まで）」の外になる。
     */
    unreadableDirCount: z.number().int().positive().optional(),
  }),
  z.object({
    kind: z.literal('unavailable'),
    /** 確かめようとした時刻。 */
    at: isoDateTime,
    /** どの経路で取ろうとしたか（`unpushedWorkObservationSourceSchema` の doc）。 */
    source: unpushedWorkObservationSourceSchema.optional(),
    /** 取れなかった理由（`ManagerUnpushedWork` の `reason` の写し）。 */
    reason: z.string(),
  }),
]);

export type LastUnpushedWorkObservation = z.infer<typeof lastUnpushedWorkObservationSchema>;

/**
 * 退避 ref を送らなかった（または送れなかった）理由（Issue #1266。
 * `packages/core/src/rescue-ref.ts`）。**理由は分類であって、git の生の
 * 文面ではない**（stderr にはパスや URL の断片が混ざりうるので運ばない）。
 */
export const rescueNotPushedReasonSchema = z.enum([
  /** 追跡済みの変更も未 push のコミットも無く、送るものが無かった。 */
  'nothing-tracked',
  /** 差分に鍵らしい文字列があったので送らなかった（`files` に名前だけ）。 */
  'secret-like',
  /** 差分が判定の上限を超えた。安全側（送らない側）に倒した。 */
  'too-large',
  /** push に使える資格が無い（`GH_TOKEN` 無し。`scope: 'app'` の構成など）。 */
  'no-credential',
  /** `origin` が無い。 */
  'no-remote',
  /** push が失敗した（`failureKind` に分類）。 */
  'push-failed',
  /** 退避 commit を作る途中の git が失敗した。 */
  'error',
  /** 畳む直前の期限などで打ち切られた（失敗とは区別する。次の周期でまた試す）。 */
  'timeout',
]);
export type RescueNotPushedReason = z.infer<typeof rescueNotPushedReasonSchema>;

/** 退避 ref を消した（消そうとした）理由。 */
export const rescueRemovalReasonSchema = z.enum([
  /** 内容が origin の枝に入っていた（runner が `landedAt` を付けた）。 */
  'landed',
  /** 委譲が `done` のまま猶予を過ぎた。 */
  'done',
  /** 委譲が `failed` のまま猶予を過ぎた。 */
  'failed',
  /** 委譲が `stopped` のまま猶予を過ぎた。 */
  'stopped',
]);
export type RescueRemovalReason = z.infer<typeof rescueRemovalReasonSchema>;

/** 消せなかった理由の分類（git の文面は運ばない）。 */
export const rescueRemovalFailureKindSchema = z.enum([
  'auth',
  'network',
  'timeout',
  /** 台帳の commit と remote の ref が食い違う（その後に別の退避が送られた）。消さない。 */
  'moved',
  /** 送った先の URL が台帳に無い、または使えない形。 */
  'no-remote',
  /** 宛先の runner が名簿に開いていない、または後始末の口を持たない。 */
  'no-runner',
  'other',
]);
export type RescueRemovalFailureKind = z.infer<typeof rescueRemovalFailureKindSchema>;

/** 退避 ref の後始末の記録（デーモンが書く）。{@link rescueWorktreeSchema} の `pushed.removal`。 */
export const rescueRemovalSchema = z.object({
  /** 消した時刻、または（`failureKind` があれば）最後に試して失敗した時刻。 */
  at: isoDateTime,
  reason: rescueRemovalReasonSchema,
  failureKind: rescueRemovalFailureKindSchema.optional(),
  /** 失敗した回数（再試行の間隔を伸ばす材料）。 */
  attempts: z.number().int().positive().optional(),
});
export type RescueRemoval = z.infer<typeof rescueRemovalSchema>;

/**
 * 1つの作業ツリーについての、退避 ref の最後の状態（Issue #1266）。
 *
 * - `pushed` は**最後に成功した退避**。後の回が送らなかったり失敗したりしても
 *   消さない（remote にはまだ在る）。
 * - `notPushed` は**直近の回**が送らなかった理由。成功した回は省く。
 * - `untracked` / `submoduleCount` は**退避されなかったもの**。オーナー決定
 *   （2026-10-05）で、未追跡のパスは名前だけを出す（中身は出さない）。
 *   `paths` は上限つきで、溢れたぶんは `omitted` に件数だけ。
 */
export const rescueWorktreeSchema = z.object({
  /** `observedWorktreeBranchSchema.relativePath` と同じ（`cwd` の外は絶対パス）。 */
  relativePath: z.string(),
  branch: z.string().nullable(),
  /** この状態を確かめた時刻。 */
  at: isoDateTime,
  pushed: z
    .object({
      /** `refs/alteroid-rescue/<委譲id>/<作業ツリーの短い名>`。 */
      ref: z.string(),
      /** 退避 commit の sha。 */
      commit: z.string(),
      at: isoDateTime,
      /**
       * 送った先の remote（`origin`）の URL。**userinfo・クエリ・フラグメントは落としてある**
       * （資格を台帳へ持ち込まない）。後始末（Issue #1266）が、委譲のセッションも作業ツリーも
       * 無いところから `git push <url> --delete <ref>` を撃つための所在。読めなければ省く
       * （＝後始末は消さずに `no-remote` と残す）。
       */
      remote: z.string().optional(),
      /** 退避 commit の tree の sha。「内容がもう origin の枝に入ったか」の比較に使う。 */
      tree: z.string().optional(),
      /**
       * runner が、この退避 commit の tree と同じ tree を origin の枝（作業ツリーの
       * remote-tracking）の直近の commit に見つけた時刻。**ローカルの remote-tracking
       * しか見ていない**（ネットワークは使わない。最後の fetch/push 時点の像）。
       * 後始末は「内容は origin に在る」として即座に消してよい。
       */
      landedAt: isoDateTime.optional(),
      /**
       * **デーモンが書く**後始末の記録。runner は書かない。`pushed` を消さず印を付ける
       * （消した事実と、いつ・なぜを残す）。`failureKind` があれば消せなかった回で、
       * 次の機会に再試行する。
       */
      removal: rescueRemovalSchema.optional(),
    })
    .optional(),
  notPushed: z
    .object({
      reason: rescueNotPushedReasonSchema,
      /** `reason: 'push-failed'` の分類。 */
      failureKind: z.enum(['auth', 'network', 'rejected', 'timeout', 'other']).optional(),
      /** `reason: 'secret-like'` のとき、当たったファイルの名前（文字列そのものは持たない）。 */
      files: z.array(z.string()).optional(),
    })
    .optional(),
  untracked: z
    .object({
      /** 未追跡のファイルの総数。 */
      count: z.number().int().positive(),
      /** パスの名前（上限つき）。 */
      paths: z.array(z.string()),
      /** `paths` に載せ切れなかった件数。 */
      omitted: z.number().int().nonnegative(),
    })
    .optional(),
  /** 作業ツリーの中の submodule の件数（中の変更は退避されない）。 */
  submoduleCount: z.number().int().positive().optional(),
});
export type RescueWorktree = z.infer<typeof rescueWorktreeSchema>;

/** 委譲ごとの退避 ref の台帳（`Job.lastRescue`）。作業ツリーごとの最後の状態。 */
export const lastRescueSchema = z.object({
  /** runner から最後に届いた時刻（後始末が書き換えても進めない）。 */
  at: isoDateTime,
  worktrees: z.array(rescueWorktreeSchema),
  /**
   * **デーモンが書く。** 後始末の走査が、この委譲が `done` / `failed` / `stopped` のいずれかで
   * あることを**初めて見た**時刻（Issue #1266）。猶予は `max(at, terminal.seenAt)` から数える
   * ——`at` だけだと、`lost` のまま長く放置されたものが `stopped` へ畳まれた瞬間に猶予ゼロで
   * 消える。状態が変われば（別の終端・終端でなくなる）作り直す／外す。
   */
  terminal: z
    .object({ status: z.enum(['done', 'failed', 'stopped']), seenAt: isoDateTime })
    .optional(),
});
export type LastRescue = z.infer<typeof lastRescueSchema>;

/**
 * `unpushed-work-observation-format.ts` の
 * {@link UnpushedWorkObservationIncompletenessLike}（手書き）が、この zod
 * スキーマの `kind: 'observed'` 変種と構造的に一致することの強制
 * （`_AssertTraceActionMatchesLikeType` と同じ形——**片方向**）。
 *
 * **双方向ではなく片方向**（`Extract<..., 'observed'> extends
 * UnpushedWorkObservationIncompletenessLike`）。`UnpushedWorkObservationIncompletenessLike`
 * は意図して「`describeUnpushedWorkObservationIncompleteness` が読む4欄
 * だけの最小の型」であって `kind: 'observed'` 変種の完全な写しではない
 * （`at` / `cwd` / `worktrees` / `source` を持たない）ので、双方向にすると
 * 必ず落ちる。
 *
 * **ここが崩れると、両者は静かにずれうる**——`lastUnpushedWorkObservationSchema`
 * の `kind: 'observed'` へ確かめきれなかったことの欄を足しても
 * `UnpushedWorkObservationIncompletenessLike` を書き換え忘れれば、
 * `describeUnpushedWorkObservationIncompleteness` はその欄を1つも読めない
 * まま `pnpm typecheck` が落ちて初めて気づく。
 */
export type _AssertUnpushedWorkObservationIncompletenessMatchesLikeType = AssertTrue<
  Extract<
    LastUnpushedWorkObservation,
    { kind: 'observed' }
  > extends UnpushedWorkObservationIncompletenessLike
    ? true
    : false
>;

/**
 * `unpushed-work-observation-format.ts` の手で複製した
 * `UnpushedWorkObservationSourceLike` が、`unpushedWorkObservationSourceSchema`
 * と**両向きで**一致することの保証（Issue #2457）。経路を足して揃え忘れれば
 * `pnpm typecheck` が落ちる。
 */
export type _AssertUnpushedWorkObservationSourceMatchesLikeType = AssertTrue<
  [UnpushedWorkObservationSource] extends [UnpushedWorkObservationSourceLike]
    ? [UnpushedWorkObservationSourceLike] extends [UnpushedWorkObservationSource]
      ? true
      : false
    : false
>;

export const jobSchema = z.object({
  id: z.string(),
  createdAt: isoDateTime,
  updatedAt: isoDateTime,
  status: jobStatusSchema,
  /**
   * `manager_start` が呼ばれた時点の会話 id（issue #1003 段2）。
   *
   * ## なぜここに在るか
   *
   * 台帳（`Commitment`）の未了行のうち「進行中（委譲あり）」を見分けるには、
   * その行と委譲を結ぶ鍵が要る。`commitmentId` のような専用の id はどこにも
   * 無い（issue #1003 の実測。`commitmentId` は0件）——新しく足すと、それは
   * **クローンが手で維持する欄**になり、この Issue が禁じている形
   * （「クローンが手で維持する欄を足すと、クローンはそれを忘れる」）に触れる。
   *
   * **⟹ 代わりに、既に存在する `ToolContext.conversationId`（#768・#781）を
   * `manager_start` の呼び出し文脈から自動で写す。** クローンは何も入力しない
   * ——`manager_start` のツール引数にこの欄は無い（`tools.ts` を見ればよい）。
   * `Commitment.source`（`origin: 'human'` かつチャット経由の行にだけ、本物の
   * 会話 id が入る——`commitmentRespondedAt` の doc）とここを突き合わせれば、
   * 「この会話の中で委譲した」を導ける。
   *
   * ## 限界（正確な1対1の紐付けではない）
   *
   * この欄が結ぶのは「同じ会話の中で起きたか」であって「この特定の未了行が
   * この委譲を生んだか」ではない。1つの会話の中に複数の未了行や複数の委譲が
   * 在れば、**この欄だけでは特定の行と特定の委譲を一意に結べない**
   * （`commitmentActiveDelegationIds` の doc に判定の実装と、緩和のために
   * 課している条件——委譲が行の `at` より後に始まっていること——を書いた）。
   * それでも「この会話では何も動いていない」と「この会話で何かが走っている」
   * の区別は付けられるので、issue #1003 が言う「放置」と「進行中」を見分ける
   * には足りる。
   *
   * **`ToolContext.conversationId` は内部ターン（マネージャー発の確認・蒸留・
   * timer）では `undefined` を返す**（#781）。そのときはこの欄も省略される
   * ——「会話に紐づかない委譲」は「進行中」の判定対象から自然に外れる
   * （偽の紐付けを作らない側に倒れる）。
   */
  conversationId: z.string().optional(),
  /** マネージャーの識別子。ジョブ1件 = マネージャー1本なので id と同じ値が入る。 */
  managerId: z.string().optional(),
  /** SDK のセッション id。M4 の resume の足がかり。 */
  sessionId: z.string().optional(),
  /**
   * SDK が生ログを預けるときの scope（SessionStore の `projectKey`）。
   *
   * **これが無いと、器を作り直したあとに生ログを引き当てられない。** ローカルの
   * トランスクリプトはコンテナと一緒に消えるので、可観測性の最下段へ降りる経路は
   * `projectKey` + `sessionId` の対で持つしかない（PRD「可観測性」）。
   */
  projectKey: z.string().optional(),
  summary: z.string(),
  /** クローンが出した依頼の全文。 */
  request: z.string().optional(),
  /**
   * マネージャーの作業ディレクトリ（人間が Claude Code を開く場所と同じ）。
   *
   * **runner が実際に開いた値へ揃える（可能なら）**（Issue #1814）。`start()` /
   * `#resume()` を呼ぶ前は「頼む値」（明示の `cwd`、省略時は `workspacePath`）が
   * 入るが、runner の応答が実際に使った値を返せば（`Host#resolveCwd` が倒した
   * 場合を含む）、その値でここを上書きする——**古い runner（応答に `cwd` を
   * 持たない）とは応答が返らないだけなので、そのときはここが頼んだ値のまま
   * 残る。それは「確認できていない」であって「確認して一致した」ではない**
   * （`ManagerSummary.cwdConfirmed` を持つのは `start()` の応答だけで、この
   * 欄単体からは確認できたかどうかを読めない）。
   */
  cwd: z.string().optional(),
  /**
   * どの manager-runner で走っているか（M4）。
   *
   * `manager_id → runner_id → session_id → workspace` の鎖をここで持つ。
   * **これが無いと、runner が増えた瞬間に `manager_send` の宛先が決まらない。**
   * 1台構成でも最初から残しておく（後から足すと、既存のジョブに宛先が無い）。
   */
  runnerId: z.string().optional(),
  /** workspace の所在。runner affinity と合わせて復元できるようにする。 */
  workspace: workspaceLocatorSchema.optional(),
  /**
   * 貸し出し期限（M5 PR4）。**いまどのプロセスがこの委譲を握っているか。**
   *
   * `runnerId` が「どの宛先か」なのに対し、こちらは「その宛先のどのプロセスか」と
   * 「いつまで握っていると約束したか」である。
   *
   * **欠けている＝判定材料が無い、であって「握られていない」ではない。** それでも
   * `judgeLease` は欠けているときに引き取りを許す — この欄が無かった頃のジョブと、
   * 貸し出しを名乗らない runner のジョブが**永久に引き取れなくなる**のを避けるため
   * である（能力の削除になる。north_star 禁止1）。判定できないことは、判定の結果の
   * 側ではなく `judgeLease` の返り値の種類として持つ。
   */
  lease: jobLeaseSchema.optional(),
  /**
   * **`lost` に確定した後に `closed(status: 'done')` が届き、クローンへ知らせた時刻**
   * （Issue #3161）。`manager.ts` の `case 'closed'` の「lost の後の closed」の項。
   *
   * `closed` には冪等キーが無いので、同じ委譲へ `done` が二重に届いたときに知らせを
   * 1回に保つ印をここへ持つ。**台帳（`Job`）に置くのはデーモンの再起動をまたいでも
   * 効かせるため**——runner は SSE の再接続で `Last-Event-ID` から同じ出来事を配り直す
   * ことがあり（`runner-protocol.ts` の `reportId` の doc）、プロセス内の集合では
   * 再起動の後の二重を止められない。**欠けている＝まだ知らせていない。**
   */
  lateDoneNotifiedAt: isoDateTime.optional(),
  /**
   * **器がこの委譲のセッションを持ったと、デーモンが確かめた直近の時刻**（Issue #3189）。
   * `ManagerRecord.runnerSessionSince` の写しで、書くのは start / resume の後・runner の
   * `session` の名乗り・`resume_failed`（recovered）の4箇所。**`closed(done)` が「このセッション
   * で report を受け取ったか」を `lastReportAt` と突き合わせて判定する材料**で、台帳に置くのは
   * デーモンの再起動をまたいで効かせるため。**欠けている＝この欄を書く前の行（または一度も
   * 確かめていない行）。判定できない側に倒す**（`reportSeenInSession` の `unknown`）。
   */
  runnerSessionSince: isoDateTime.optional(),
  /**
   * **report 無しの `closed(done)` の知らせ（`closed_done_silent`。#3189）を積んだときの
   * `runnerSessionSince` の値**（Issue #3233）。同じセッションについて知らせを1回に保つ印で、
   * `manager.ts` の `case 'closed'` の「report が無いまま `closed(done)` だけが届いたこと」の項。
   *
   * `closed` には冪等キーが無く、SSE の再配達で同じ `closed(done)` が2度届くと知らせが「×2」に
   * なっていた。セッションは1回しか閉じず、resume / start すれば `runnerSessionSince` が新しくなる
   * ので、「1セッションにつき1回」がそのまま正しい線になる。`lateDoneNotifiedAt` と同じく台帳に置く
   * （デーモンの再起動をまたいでも効かせるため）。**欠けている＝まだ知らせていない。**
   * **`runnerSessionSince` がまだ無いセッション**（既に生きている器へ付け直しただけで start / resume を
   * 通っていない行など）では、値の代わりに空文字を書く＝「セッションの時刻が無いまま知らせた」。
   * start / resume / session の名乗りで `runnerSessionSince` が立てば空文字とは一致しなくなるので、
   * 新しい終わりは従来どおり知らせる。
   */
  silentDoneNotifiedFor: z.union([isoDateTime, z.literal('')]).optional(),
  /**
   * **この委譲のセッションが最後に実際に置かれた器**（runner の `/health` の
   * `instanceId`）。器の入れ替えを、話しかけられた委譲へ告げるかの判定材料である
   * （#669。`manager.ts` の `#runnerSwappedSinceSession`）。
   *
   * ## `lease.instanceId` と何が違うのか。なぜ2つ持つのか
   *
   * `lease.instanceId` は**誰が握っているか**（貸し出しの持ち主）で、
   * `#claimForResume` が引き取りの関門を通った時点、つまり **`runner.resume()` を
   * 出す前**に台帳へ書き込まれる（あの順序は「奪う操作だけは書けたことを条件に
   * する」という別の正しい理由でそうなっている。動かさないこと）。
   *
   * **⟹ 関門を通った後に resume が失敗する枝**（`#loadSession` が `unreadable` を
   * 返した／`runner.resume()` が投げた）**では、貸し出しだけが新しい器へ進み、
   * 告げる1行は届かない。** そこで貸し出しを判定材料にすると、次に話しかけたとき
   * 「もう告げた」と読めてしまい、**二度と告げられなくなる。** 空になった
   * `/workspace` の上で「続き」を書き始める、という #669 の症状そのものである。
   *
   * だから**役割を分けて2つ持つ**。この欄は「握っているか」を一切表さず、
   * **セッションが実際にその器へ載ったことが確かめられた回にだけ**進む:
   *
   * - `start()` — `runner.start()` が返った後（`runnerSessionSince` と同じ地点）
   * - `#resume()` — `runner.resume()` が返った後（同じ地点。ここより後に
   *   `'resumed'` 以外へ落ちる枝は無い）
   *
   * ## 値の出どころは、その回に関門が判定した相手である
   *
   * どちらの地点でも `job.lease.instanceId`（＝直前に `grantLease` / `touchLease`
   * が置いた、その回に claim した相手）を写す。**新しく名簿を引き直さない** —
   * 引き直すと、resume の最中に器が入れ替わった回に「新しい器へ載った」と書いて
   * しまい、実際には古い器へ載ったセッションについて**以後ずっと告げなくなる**。
   * 写す側に倒せば、その回は古い値のまま残り、次の `send()` が告げる（余分に
   * 告げるほうが安全側である——言うのは「手元を確かめよ」だけである）。
   *
   * ## 欠けているとき
   *
   * **`undefined` は「判定できない」であって「入れ替わっていない」ではない。**
   * 欠けるのは2つの場合である:
   *
   * 1. `instanceId` を名乗らない runner（同一プロセスの `runner-local` や古い器）。
   *    **名乗らない値で上書きしない**（`undefined` を書き込まない）ので、一度名乗った
   *    器の値は残る——後でまた名乗り始めた器と突き合わせられる
   * 2. **この欄より前に作られたジョブ。** 保存は Job 丸ごとの JSON（pg は
   *    `jobs.job` 列、fs は JSON ファイル）なので移行は要らないが、古い行にこの欄は
   *    無い。`#runnerSwappedSinceSession` はそのとき `lease.instanceId` へ落ちる
   *    ——**限界も含めてあちらの doc に書いてある**
   */
  sessionInstanceId: z.string().optional(),
  /*
   * **`managerProvider` は撤去した**（2026-10-07 のオーナー決定。マネージャー層は常に Claude で動く）。
   * かつて（#486 S7）クローンが `provider` を指名した委譲にだけ書いていた。保存は Job 丸ごとの JSON
   * なので、旧い行には欄が残りうる。`z.object` は未知の欄を黙って捨てるので、読み込みは落ちない
   * （`.strict()` にしないこと。歯は `packages/storage-fs/src/job-legacy-manager-provider.test.ts`）。
   */
  /**
   * 退避済みトランスクリプト以外の生ログへの入口は**ここに持たない**。
   *
   * 走行中の生ログは manager-runner のディスクの上にあり、デーモンはその中を
   * 仮定しない（runner のローカルパスを台帳に書くと、runner が入れ替わった
   * 瞬間に嘘になる）。降り方は runner の API → アーカイブ → 預かった
   * セッションの生ログ、の順である。
   */
  /** 退避済みトランスクリプト（TranscriptArchive の id）。 */
  archiveIds: z.array(z.string()).optional(),
  /** 直近の報告。一覧でクローンが状況を掴むためのもの。 */
  lastReport: z.string().optional(),
  /**
   * `lastReport` を**デーモンが受け取った時刻**（#358）。
   *
   * **これが名乗るのは「受け取った」だけである。** 「マネージャーが報告を
   * 生成した時刻」でも「クローンのターンへ入った時刻」でもない — 前者は
   * runner 側が包む前の話でデーモンには届かず、後者はいまどのレコードにも
   * 無く日誌を掘らないと取れない（`#handle` が書く1行の書き込み時刻としてしか
   * 残らない）。取れないものを取れた顔で出さない（AGENTS.md の地雷表）。
   *
   * `lastReport` と同じ扱い（応答として終わった回はそのまま残り、次の
   * `report` が来たときだけ上書きされる。台帳を消す操作ではない）。
   */
  lastReportAt: z.string().optional(),
  /**
   * `lastReport` を台帳へ書いた瞬間の status（Issue #1036）。
   *
   * ## なぜ在るのか
   *
   * `manager_report` / `manager_list` は「この報告がいつのものか」
   * （`lastReportAt`）は持てても、「その時点で状態が何だったか」を持って
   * いなかった。読み手は直近に**完了した**ターンの中身を、**いまの状態**
   * として読んでしまう——クローンが走行中の委譲3本を「止まっている」と
   * 誤読して停止させた実害（Issue #1036 の事故）。
   *
   * ⚠️ **これだけで #1036 の事故そのものが止まるとは名乗らない。** 事故を
   * 起こしたクローンは、同じ突き合わせを既に受信箱の断り書き
   * （`inbox-validity.ts` の `describeValidity`）で読んでいたが、それでも
   * 数えなかった（#1036 コメント）。**行為の側で止めるのは #1037
   * （`manager_stop` が running を既定で断る。PR #1043）である。** この欄が
   * 埋めるのは「`manager_report` / `manager_list` が齢も status も1文字も
   * 出していなかった」という別の——そして純粋な——欠落のほうである。
   *
   * ## 何を書くか——「書いた瞬間」は前ではなく後
   *
   * `case 'report':`（`manager.ts`）はこの欄と同じ瞬間に `record.job.status`
   * を `event.status` へ書き換える。**ここに書くのは `event.status`（報告が
   * 名乗った値）そのものである**——書き換え前の値（この report が届く直前
   * まで台帳が名乗っていた status。多くは `running`）ではない。理由は、
   * 突き合わせたい問いが「この報告が運んだ内容は、どの status に対応する
   * ものか」だからである。`report` イベントの `status` は「このターンを
   * 終えて、いまはこの状態で待っている」を意味する。前者（書き換え前）を
   * 採ると、この欄はほぼ常に `running` になり、比較はほぼ常に「違う」から
   * 始まってしまう。
   *
   * **⚠️ 例外が1つある（Issue #1592 の副作用の疑い）。** `event.status ===
   * 'waiting_human'` かつ `record.waiting` が空（＝待っている確認が実際には
   * 無い）なら、`record.job.status` は `event.status` をそのまま採らず
   * `'running'` へ補正する（`manager.ts` の `case 'report'` の該当コメント）。
   * **この欄（`lastReportStatus`）は補正しない**——`event.status` を
   * そのまま残す。だから、この例外に当たった回だけ、この欄と
   * `record.job.status` が同じ瞬間に別の値を持つ。**これは壊れではなく
   * `describeReportDrift` の入力そのもの**——「報告が名乗った前提（この
   * 欄）と、いまの状態（`status`）が違う」を言うための欄なので、ここでだけ
   * 両者が一致しないのは設計どおりである。
   *
   * ## 何のために読まれるか
   *
   * 読む側（`manager-activity.ts` の `describeReportDrift`）は、この欄と
   * 「いまの `status`」を突き合わせ、違えば「この報告が名乗った前提は
   * 動いている」と言う。**新しい status の名簿は作らない**——`running` に
   * 限定せず、焼いた値といまの値が違えば常に出す（比較は
   * `inbox-validity.ts` の `statusValidity` にそのまま乗せ、`changed` /
   * `unchanged` の4値の設計をここでも踏襲する）。
   *
   * ## 欠けているとき
   *
   * **既定値は作らない。** この欄を持たない古い行（この変更より前に書かれた
   * 行）は比較できないので、`describeReportDrift` は何も足さない
   * （`describeValidity` の `unclaimed` が空文字を返すのと同じ約束。
   * AGENTS.md「取れない軸に 0 の行を作る」）。
   */
  lastReportStatus: jobStatusSchema.optional(),
  /**
   * 直近の報告が**報告ではなく失敗**だったこと（SDK が「これは応答ではない」と
   * 言った回）。応答として終わった回では消える。
   *
   * **`status` では表せない。** あちらは仕事の状態（`done` は「終えて待機中。
   * 話しかければ続く」）で、ここは**直近の1ターンがどう終わったか**である。
   * 支出上限に当たった回はセッション自体は生きているので、`status` を `failed`
   * へ倒すと嘘になる（クローンは話しかけ直せる）。
   *
   * **これが無いと、人間の一覧に「報告が来た」としか出ない。** 直す前は
   * `You've hit your org's monthly spend limit …` が `lastReport` にそのまま入り、
   * マネージャーが何か報告してきたように見えていた（`sdk-failure.ts` の doc）。
   */
  lastFailure: z
    .object({
      /** SDK の語そのまま（`billing_error` / `error_during_execution` など）。 */
      code: z.string(),
      /** どの印で分かったか（`sdk-failure.ts` の `SdkFailureVia`）。 */
      via: z.string(),
      at: isoDateTime,
    })
    .optional(),
  /**
   * 直近の1ターンが、`result` を受け取らないまま畳まれたこと（Issue #917）。
   *
   * `lastFailure` とは軸が違う——あちらは SDK が「これは応答ではない」と
   * 言った回（`failure` が付く）で、こちらは SDK からその声明すら届かないまま
   * 器の入れ替え・`manager_stop`・クラッシュ等で畳まれた回
   * （`runner.ts` の `#flushUnreported` / `runnerEventSchema` の
   * `report.unreported` の doc）。**両方が無いことも、片方だけ在ることもある**
   * ——同じ欄に混ぜない。
   *
   * **これが無いと、`lastReport` が完遂した報告に見える。** 本文
   * （`unreportedText()` が包んだもの）は畳まれる前の途中経過であって、
   * 完遂した報告ではない——`case 'report'` がここを見て `manager_list` /
   * `manager_report` の見出しを「直近のターンの中身」へ倒す
   * （`tools.ts` の見出し分岐の doc）。
   *
   * `reason` は `#flushUnreported` が受け取った理由文字列をそのまま運ぶ
   * （言い換えない）。応答として終わった回（次の `report` が `unreported`
   * を伴わずに届いた回）では消える——`lastFailure` と同じ「直近」の意味を
   * 守る。
   */
  lastUnreported: z
    .object({
      reason: z.string(),
      at: isoDateTime,
    })
    .optional(),
  /**
   * `manager_stop` で畳まれたターンの本文（Issue #1038）。
   *
   * ## `lastReport` とは別の欄にする理由
   *
   * `case 'report'`（`manager.ts`）は `record.job.status === 'stopped'` の回
   * （止めたマネージャーから後から届いた report）を、日誌へは残すが
   * `lastReport` へは書かずに `return` する（R4「止めた後は受信箱へ回さない」
   * ——`#emit()` もしない。この判断そのものは覆さない）。**その分岐が、台帳にも
   * 何も残さないという副作用まで巻き込んでいた**のが #1038 の指す穴——本文は
   * 日誌にしか残らず、`manager_stop` の応答にも `manager_report` にも1文字も
   * 出ない。誤って止めたことに気づく契機が、止めた直後には無かった。
   *
   * `lastReport` は「完遂した報告」の欄である。畳まれた本文を混ぜると、次に
   * 読む側は「完遂した報告」と「止めた後に打ち切られた途中経過」を区別できなく
   * なる——`lastUnreported`（`result` を受け取らないまま畳まれた回）と同じ
   * 「同じ欄に混ぜない」の理由。
   *
   * ## いつ書くか
   *
   * `case 'report'` の `record.job.status === 'stopped'` 分岐でだけ書く。
   * **`record.job.status` は動かさない。`#emit()` もしない**（R4 は覆さない）。
   *
   * 通常どおり処理される回（`status === 'stopped'` の早期リターンを通らない
   * 回）では、`delete` で下ろす——`lastFailure` / `lastUnreported` と同じ
   * 「応答として終わった回では消える」を守るため。下ろさないと、止めた委譲を
   * 再開して普通に報告し始めた後も、古い畳まれた本文が居座って
   * `manager_report` / `manager_list` の見出しを誤らせる。
   *
   * ## 順序の注意（`manager_stop` の応答を組む時点では、まだ届いていないことがある）
   *
   * `abort()` は `runner.stop()` を待った直後に `record.job.status = 'stopped'`
   * を書く。一方この report イベントは、HTTP 越しの runner では**別経路で
   * 後から届く**——`manager_stop` の応答を組む時点でこの欄がまだ埋まっていない
   * ことは普通にある。**その待ちのために `manager_stop` を止めないこと**
   * （止まらない委譲を止めたい場面でその待ちが効く）。届けばこの欄へ残るので、
   * `manager_report` で後から読める。
   */
  lastFoldedTurn: z
    .object({
      text: z.string(),
      at: isoDateTime,
    })
    .optional(),
  /**
   * セッションが `failed` として畳まれたときの、器の資源による落ち方の分類
   * （`system-error.ts` の `SystemErrorFacts`。#713 段3）。
   *
   * **軸が `lastFailure` と違う。** `lastFailure` は「直近の**1ターン**が報告
   * ではなく失敗で終わった」で、セッション自体は生きている（`status` は
   * `done` のまま、`manager_send` で続けられる）。こちらは「**セッションその
   * ものが `closed`（`status: 'failed'`）として畳まれた**、その落ち方の OS
   * 由来の事実」——セッションはもう走っていない。**同じ欄に混ぜない**（軸が
   * 違うものを1つの欄に載せると、どちらの質問にも正しく答えられなくなる）。
   *
   * `manager.ts` の `#onEvent` の `case 'closed'`（`event.status === 'failed'`）
   * が、`event.systemError` が在るときだけ立てる。**`code` を持たない例外
   * （枠 429 で落ちた／signal で畳まれた）では立たない**——`systemErrorFactsOf`
   * の doc が言う「取れなかった」を、この欄でも値で埋めない
   * （`AGENTS.md`「取れない軸に 0 の行を作る」）。
   *
   * **古びさせる。** 新しいターンの出力（`case 'report'`）が届いた回には
   * 下ろす——下ろさないと、起こし直されて普通に報告しているマネージャーに、
   * 過去の落ち方が貼り付いたままになる（`lastFailure` が「応答として終わった
   * 回では消える」のと同じ理由。下ろす条件は `case 'report'` 側の doc）。
   */
  lastSystemError: systemErrorFactsSchema.extend({ at: isoDateTime }).optional(),
  /**
   * セッションが `closed` として畳まれたとき、その委譲が生きていた間に
   * 器の cgroup 全体で増えた「pids 上限で拒んだ／OOM で殺した」回数の差分
   * （`cgroup-events.ts` の `CgroupEventsDelta`。Issue #1517「最小の形」2）。
   *
   * **`lastSystemError` と軸が違う。** あちらは Node が構造として持つ失敗の
   * 分類（`code`/`errno`/`syscall`）で `status === 'failed'` かつ `code` を
   * 持つ例外のときにしか立たない。こちらは cgroup のカウンタが読めた回には
   * `status` に関わらず立ちうる——**signal で畳まれた回（`lastSystemError`
   * が立たない回）にこそ効く軸**（#1334 の SIGABRT 原因調査）。同じ欄に
   * 混ぜない。
   *
   * **いまは `status === 'failed'` の回にだけ書く。** `manager.ts` の
   * `#onEvent` の `case 'closed'` が、`lastSystemError` と同じ条件
   * （`event.status === 'failed'` かつ材料が在る）でだけ立てる——`done` /
   * `lost` で畳まれた回にまで台帳の欄を増やすかどうかは、この最小の形の外に
   * ある判断として保留した（設計判断。PR 本文に記載）。
   *
   * **古びさせる。** `lastSystemError` と同じ理由・同じ条件（`case 'report'`
   * が届いた回）で下ろす——起こし直されて普通に報告しているマネージャーに、
   * 過去のセッションの落ち方が貼り付いたままにしない。
   */
  lastCgroupEvents: cgroupEventsDeltaSchema.extend({ at: isoDateTime }).optional(),
  /**
   * この委譲が**枠（利用上限）で止まった**印が立った時刻（Issue #914 段2）。
   *
   * `manager.ts` の `case 'usage_notice'`（`event.notice.kind === 'reached'`）が
   * 立て、{@link Pool.resumeStoppedByUsage}（の `#clearUsageStoppedMark`
   * ヘルパー経由）が消費して下ろす——**プロセス内の `#usageStopped`（`Set`）の
   * 永続化された側**である。
   *
   * ## なぜ台帳にも要るか
   *
   * `#usageStopped` は `Set<string>` なのでデーモンが作り直されると消える。
   * 消えて困るのは「起こし直す相手を1本忘れる」ことだが、**この欄が無かった
   * 頃**は、デーモンが入れ替わった時点で台帳が `done` / `failed` / `lost` の
   * 委譲は誰にも起こされないまま座り続けた（起動時の引き取り `#restoreJobs`
   * は `running` / `waiting_human` だけを続きへ戻すので、既に終端している
   * 委譲はそもそも対象に入らない）。この欄が `#restoreJobs` の写しとして
   * 生き残ることで、次の起動でも `#usageStopped` を組み直せる。
   *
   * ## `undefined` の意味は2つある
   *
   * この仕組みより前に作られたジョブ（保存は Job 丸ごとの JSON なので移行は
   * 要らないが、古い行にこの欄は無い）と、単に止まっていないジョブの両方が
   * `undefined` になる。**見分ける必要は無い**——どちらも「起こし直す対象では
   * ない」という同じ結論になるためである。
   */
  usageStoppedAt: isoDateTime.optional(),
  /**
   * 未 push の作業ツリーの枝名の観測、最後に取れた1回（Issue #1228
   * 候補(1)）。詳しい意味・残る族・答えないことは
   * {@link lastUnpushedWorkObservationSchema} の doc を見よ。
   */
  lastUnpushedWorkObservation: lastUnpushedWorkObservationSchema.optional(),
  /**
   * 走行中に定期的に退避 ref を push した記録（Issue #1266）。
   * {@link lastRescueSchema} の doc を見よ。`lastUnpushedWorkObservation` とは
   * 別の欄にしてある——あちらは「いま何が未 push か」の観測で新しいほうが勝つ
   * 上書き、こちらは作業ツリーごとに積み増す。
   */
  lastRescue: lastRescueSchema.optional(),
});

export type Job = z.infer<typeof jobSchema>;

/**
 * `system-error-format.ts` の {@link SystemErrorFactsLike}（手書き）が、
 * この zod スキーマから推論した {@link SystemErrorFacts} と構造的に一致する
 * ことの強制（`_AssertJobStatusMatchesRunningLikeType` と同じ形）。
 *
 * 軽い口（`system-error-format.ts`）は zod を import できないので、
 * `SystemErrorFacts` をそのまま使えず、同じ形を手で書き写している。
 * **ここが崩れると、両者は静かにずれうる**——`systemErrorFactsSchema` に
 * 欄を足しても `SystemErrorFactsLike` を書き換え忘れれば、
 * `formatSystemErrorFacts` はその欄を1つも読めないまま `pnpm typecheck` が
 * 落ちて初めて気づく。
 */
export type _AssertSystemErrorFactsMatchesLikeType = AssertTrue<
  [SystemErrorFacts] extends [SystemErrorFactsLike]
    ? [SystemErrorFactsLike] extends [SystemErrorFacts]
      ? true
      : false
    : false
>;

/**
 * `cgroup-events-format.ts` の {@link CgroupEventsDeltaLike}（手書き）が、
 * この zod スキーマから推論した {@link CgroupEventsDelta} と構造的に一致する
 * ことの強制（`_AssertSystemErrorFactsMatchesLikeType` と同じ形）。
 *
 * 軽い口（`cgroup-events-format.ts`）は zod を import できないので、
 * `CgroupEventsDelta` をそのまま使えず、同じ形を手で書き写している。
 * **ここが崩れると、両者は静かにずれうる**——`cgroupEventsDeltaSchema` に
 * 欄を足しても `CgroupEventsDeltaLike` を書き換え忘れれば、
 * `formatCgroupEventsNote` はその欄を1つも読めないまま `pnpm typecheck` が
 * 落ちて初めて気づく。
 */
export type _AssertCgroupEventsDeltaMatchesLikeType = AssertTrue<
  [CgroupEventsDelta] extends [CgroupEventsDeltaLike]
    ? [CgroupEventsDeltaLike] extends [CgroupEventsDelta]
      ? true
      : false
    : false
>;

/**
 * `request_permission`（`tools.ts`）が起こした承認待ちが持つ、規則そのものの
 * 記録（Issue #863「許可をコードではなくデータにする」）。
 *
 * **`request_permission` を通った要求だけがこの欄を持つ。** 道具自身が
 * `packages/core/src/permission-rule.ts` の `validatePermissionRequest` で
 * `allows` が全部通り `denies` が1件も通らないことを検査してから積むので、
 * ここに入っている `allows` / `denies` は常にその検査を通った後の値である
 * （＝この欄の存在そのものが「検算済み」を意味する）。
 *
 * `ask_human` が起こす普通の確認にはこの欄が無い——`pendingApprovalSchema`
 * の他の欄（`question` / `context`）と共存し、人間はどちらの経路でも同じ
 * `answer` で答える。`answerApproval`（`clone.ts`）はこの欄の有無で
 * 「許可の記録を試みるかどうか」を分岐する。
 */
export const permissionRequestSchema = z.object({
  /** `Bash(<完全な文字列>)` または `Bash(<前方一致>:*)`（`permission-rule.ts`）。 */
  rule: z.string(),
  /** この規則が通すべき具体例。人間が承認画面で確かめる材料。 */
  allows: z.array(z.string()),
  /** この規則が拒むべき具体例。1件以上（`validatePermissionRequest` が強制）。 */
  denies: z.array(z.string()),
});

export type PermissionRequest = z.infer<typeof permissionRequestSchema>;

/** ask_human の承認待ちキュー（PRD「権限境界」）。 */
export const pendingApprovalSchema = z.object({
  id: z.string(),
  createdAt: isoDateTime,
  question: z.string(),
  context: z.string().optional(),
  /** どのマネージャーの件か（= manager_id）。 */
  jobId: z.string().optional(),
  /**
   * マネージャー側で止まっている確認の id。
   *
   * **`jobId` だけでは足りない。** 1本のマネージャーが同時に複数を待つので、
   * ここが欠けると人間の回答をどの確認へ返せばよいか決められず、答えたのに
   * 仕事が再開しない。人間へ回る経路の端から端まで、この id を運ぶこと。
   */
  requestId: z.string().optional(),
  answeredAt: isoDateTime.optional(),
  /**
   * 回答の文。`selections` で答えたときは、デーモンが設問・選んだ選択肢・その他・補足を
   * 人間が読める文に畳んだもの（`foldSelections`。issue #2525）。
   */
  answer: z.string().optional(),
  /**
   * `ask_human` が積んだ構造化の設問（issue #2525）。無い承認待ち（この欄より前の行・
   * `request_permission`・設問を付けなかった `ask_human`）は自由文だけで答える。
   * **`request_permission` の承認待ちには付けない**（許可/拒否は `decision` が持つ）。
   */
  questions: z.array(approvalQuestionSchema).optional(),
  /** `questions` への人間の答えの構造（設問 id → 選んだ選択肢 id ＋ その他の文）。 */
  selections: z.array(approvalSelectionSchema).optional(),
  /**
   * 回答がどの経路を通ったか（Issue #1479）。doc は {@link answeredViaSchema} を
   * 見よ。**`answeredAt` と対で埋まる**——`Clone#answerApproval` が同じ呼びの中で
   * 両方を書く。`via` を渡さずに呼んだ経路（内部呼び出し・古いテスト）では
   * `answeredAt` だけが付いてここは undefined のままになる。
   *
   * **`undefined` は「記録なし」と読む。** この欄より前に答えられた既存の行
   * （fs の `jobs/jobs.json`・pg の `approvals.approval` は blob なので
   * マイグレーション無しでそのまま読める）は全部これに当たる——「operator 経由
   * だった」への遡及はできないが、それは元から記録していなかった情報なので、
   * 「わからない」を「わかったが operator ではない」に化けさせない。
   */
  answeredVia: answeredViaSchema.optional(),
  /**
   * 回答（`answeredAt` / `answer`）が受信箱まで配達されたか（issue #1977）。
   *
   * ## なぜ要るか
   *
   * `Clone#answerApproval` は (1) この行を回答済みにする→(2) 日誌・許可の
   * 記録→(3) `human_answer` 合図を受信箱へ書く、の順に別々の書き込みを行う。
   * (1) の後・(3) の前にプロセスが落ちると、この行は `answeredAt` を持つのに
   * 受信箱には何も無い——`listApprovals({ pendingOnly: true })` は回答済みの
   * 行を素通りするので、どの経路からも拾い直されず、**人間が答えたのに
   * クローンは一度も受け取らない**（issue #1977 本文）。
   *
   * - `'pending'`: 承認の行は回答済みだが、`human_answer` 合図をまだ受信箱へ
   *   書けていない（書く前・書いている最中）。
   * - `'delivered'`: 合図を受信箱へ書き終えた。
   *
   * **起動時に `Clone#reconcileUndeliveredAnswers` が、`'pending'` のまま
   * 残っている行を拾い直す**（`withdrawnAt` が付いている行は対象にしない）。
   *
   * **古い行はこの欄を持たない。** この直しより前に回答された行（fs の
   * `jobs/jobs.json`・pg の `approvals.approval` は blob なのでマイグレーション
   * 無しでそのまま読める）は `undefined` のままで、`answeredVia` と同じく
   * 「わからない」を偽の値へ化けさせない——`undefined` は拾い直しの対象に
   * **しない**（`=== 'pending'` の絞り込みに一致しないため）。遡って
   * 配り直すと、とっくに人間の目から消えた古い回答が今さら届く。
   */
  answerDelivery: z.enum(['pending', 'delivered']).optional(),
  /**
   * どの会話で上がった確認か（#768）。
   *
   * `ask_human` を叩いた時点の「いまのターンの会話 id」から埋める。
   * **マネージャー発の確認・蒸留・timer など内部ターンで上がった分は
   * undefined のままである** —— そこには紐づけられる会話が無い。
   * 回答（`human_answer`）へこの id を運び直すことで、人間への返答が
   * その会話へ載る（SSE も履歴も）。会話 id を持たない確認は今までどおり
   * `self` へ積まれ、挙動は変わらない。
   */
  conversationId: z.string().optional(),
  /**
   * クローンが `approval_withdraw`（`tools.ts`）で取り下げた時刻（#963）。
   *
   * **行は消さない。** `commitment_close` が `closedAt` / `closedReason` で
   * 台帳の行を終端させるのと同じ思想 — `listApprovals({ pendingOnly: true })`
   * はこの欄が付いた行を除くが、`getApproval` / `approvals_list id=<id>` で
   * 引けば理由ごと読み戻せる。
   *
   * **`answeredAt` とは排他的な想定である。** `approval_withdraw` は
   * `answeredAt` が付いている行を断り、`answerApproval`（`clone.ts`）は
   * `withdrawnAt` が付いている行を想定していない（人間の回答は承認待ち
   * キューの一覧経由で選ばれるので、`pendingOnly` から外れた取り下げ済みの
   * 行が回答の対象に上がることは無い）。
   */
  withdrawnAt: isoDateTime.optional(),
  /**
   * 取り下げの理由。**`approval_withdraw` は必須入力として要求する**
   * （issue #963 —「人間が後から『なぜ取り下げられたのか』を読めること」が
   * 最終承認の実体である）。ここが optional なのは、スキーマとしては
   * `withdrawnAt` の無い行に付かないことを表すだけで、`withdrawnAt` が
   * 付いた行では常に埋まっている。
   */
  withdrawnReason: z.string().optional(),
  /**
   * `request_permission` が積んだ要求だけが持つ（issue #863）。`ask_human` 経由
   * の普通の確認には無い。doc は {@link permissionRequestSchema} を見よ。
   */
  permissionRequest: permissionRequestSchema.optional(),
});

export type PendingApproval = z.infer<typeof pendingApprovalSchema>;

/**
 * 承認待ちの1行が `pendingApprovalSchema` として読めなかったときに、その行の
 * 代わりに一覧へ載せるもの（issue #2298。`unreadableCommitmentSchema` と同じ形）。
 *
 * **「無い」でも「回答済み」でもない第3の状態。** 一覧が読めない行を黙って飛ばすと、
 * 人間もクローンも、読めない承認待ちが在ること自体に気づけない。
 *
 * **⚠️ 本文（`question` / `context` / `answer`）を載せないこと。** 承認の欄には人間の
 * 依頼文や回答がそのまま入りうる（`UnreadableApprovalError` の doc、#52 と同じ理由）。
 * `reason` は「どの欄が不正か」だけにする。
 */
export const unreadableApprovalSchema = z.object({
  /** 行から取れた id。取れないこともある（fs 版で行そのものが id を持たない形のとき）。 */
  id: z.string().optional(),
  /** なぜ読めなかったか（不正な欄名だけ。値は載せない）。 */
  reason: z.string(),
});
export type UnreadableApproval = z.infer<typeof unreadableApprovalSchema>;

/**
 * 委譲（ジョブ台帳）の1行が `jobSchema` として読めなかったときに、その行の代わりに
 * 外へ出すもの（issue #2345。`unreadableApprovalSchema` と同じ形）。
 *
 * **「居ない」でも「畳まれた」でもない第3の状態。** `listJobs()` が読めない行を黙って
 * 飛ばすと、`manager_list` は「マネージャーは1本も居ない」、`GET /managers` は空の
 * 一覧を返し、digest・進捗からも委譲が消える。
 *
 * **⚠️ 本文（依頼文・報告・cwd など）を載せないこと。** job の欄には人間の依頼文・
 * マネージャーの報告がそのまま入りうる（`UnreadableJobError` の doc、#52 と同じ理由）。
 * `reason` は「どの欄が不正か」だけにする。
 */
export const unreadableJobSchema = z.object({
  /** 行から取れた id。取れないこともある（fs 版で行そのものが id を持たない形のとき）。 */
  id: z.string().optional(),
  /** なぜ読めなかったか（不正な欄名だけ。値は載せない）。 */
  reason: z.string(),
});
export type UnreadableJob = z.infer<typeof unreadableJobSchema>;

/**
 * 一覧の `updatedAt`（更新＝回答が付いた時刻。まだなら作成時刻）を出す。
 *
 * **なぜここへ寄せたか。** かつては MCP（`tools.ts`）と CLI（`apps/cli/src/chat.ts`）
 * のそれぞれの実装側に `approval.answeredAt ?? approval.createdAt` がそのまま
 * 書かれていた。この repo は「導出が各実装の側にあって、書き忘れても何も
 * 落ちない」形で同じ壊れ方を既に3回踏んでいる（`.claude/skills/listing-and-detail/SKILL.md`
 * の表、`digest.ts` の `omitted()` の doc — 「節ごとに手で書いていたのをここへ
 * 寄せた。…この行が各節の実装の側にあって、書き忘れても何も落ちなかったから
 * である」）。ここもその形だったので、スキーマの隣の共有ヘルパへ寄せ、3面
 * （MCP / HTTP / CLI）がこれを呼ぶ形にする。
 *
 * `Pick<>` で受けるのは、HTTP の応答型など `PendingApproval` の全欄を持たない
 * 値からも呼べるようにするため。`GET /approvals` は `updatedAt` を返す欄を
 * 足してあり（`apps/daemon/src/app.ts`）、このヘルパをそのまま呼ぶ。
 *
 * **⚠️ 2026-08-23 訂正: 下の「呼び出し元からは到達しない」は `tools.ts` の
 * `approvals_list`（MCP）についてだけ、いまも成り立つ。** `GET /approvals`
 * （HTTP）は既定こそ `pending=false` を外した未回答のみだが、**`pending=false`
 * を渡すと `listApprovals({ pendingOnly: false })` を呼び、回答済みも含めて
 * 返る。** これが、呼び出し元からこの `??` の左枝（`answeredAt` が付いている側）
 * へ実際に到達する初めての経路である（`apps/daemon/src/app.test.ts` がこの
 * 経路の `updatedAt === answeredAt` を固定している）。**「将来 `pendingOnly` を
 * 外したとき」ではなく、既にその経路が存在する。**
 *
 * 以下は元の記録（`tools.ts` の `approvals_list` に限っての話として読むこと）:
 *
 * `tools.ts` の `approvals_list`（呼び出し元）からは、この `??` の左枝
 * （`answeredAt` が付いている側）は到達しない。`approvals_list` の一覧
 * モードは `listApprovals({ pendingOnly: true })` をハードコードで呼び、fs /
 * pg / インメモリの3実装すべてが `answeredAt === undefined`（pg は `isNull`）
 * で絞るからである。**それでも消してはいけない** — MCP 側で将来 `pendingOnly`
 * を外したとき、これが無いと「更新」が黙って嘘になる（答えが付いた件が一覧に
 * 出るようになった瞬間、更新が回答時刻ではなく作成時刻を指す）。「死んでいる
 * コード」と「将来のために置いてあるもの」は、書いていなければ区別が付かない。
 * 根拠は3実装のソースと呼び出し元1箇所の網羅（2026-08-22T15:58Z 観測、MCP
 * 側のみ）であって、実行時カバレッジでは確かめていない。
 *
 * **左枝を歯で固定できないのは MCP の呼び出し元からの話であって、このヘルパ
 * 自身については成り立たない。** `schema.test.ts` はこのヘルパを直接呼ぶ
 * 単体試験で `answeredAt` 有りの枝を固定しており、HTTP 側も上記のとおり
 * `app.test.ts` が固定している。
 *
 * **2026-09-15 追記（#963）: `withdrawnAt` を先頭の枝に足した。** 取り下げも
 * 「この1件が最後に変わった時刻」の一種であり、`answeredAt` と同じ扱いを
 * 受ける。両方が付くことは正常な経路では無い（`pendingApprovalSchema` の
 * `withdrawnAt` の doc）が、万一両方在れば「最後に変わった」側を優先する
 * 意味で `withdrawnAt` を先に見る。
 */
export function approvalUpdatedAt(
  approval: Pick<PendingApproval, 'createdAt' | 'answeredAt' | 'withdrawnAt'>,
): string {
  return approval.withdrawnAt ?? approval.answeredAt ?? approval.createdAt;
}

// ---------------------------------------------------------------------------
// 許可の記録（Issue #863「許可をコードではなくデータにする」）
// ---------------------------------------------------------------------------

/**
 * この定型文と**ちょうど**一致した回答だけが許可を記録する（`clone.ts` の
 * `answerApproval`）。**前後の空白だけを trim する** — 「許可します。」
 * （句点付き）・「いいよ」・「許可する」のような近い言い回しは一致しない
 * （設計上の意図——定型文から外れた回答は、人間が実際に何を承認したのか
 * 機械的に確定できないため、記録しない側へ倒す）。
 */
export const PERMISSION_GRANT_CONSENT_PHRASE = '許可します';

/**
 * `permissionGrantSchema.route` — 誰の回答として記録されたか。
 *
 * **`principalKind` は `'account'` の1値しか取らない。** `operator` 経路の
 * 回答は最初から `PermissionGrant` を作らない（`clone.ts` の
 * `answerApproval` が記録前に弾く）ので、この型自体が「operator は記録され
 * ない」という不変条件を運ぶ——`PermissionGrant` が実在する時点で、その経路は
 * 必ずアカウントである。
 */
export const permissionGrantRouteSchema = z.object({
  principalKind: z.literal('account'),
  accountId: z.string(),
});

export type PermissionGrantRoute = z.infer<typeof permissionGrantRouteSchema>;

/**
 * 人間が承認した、以降 Bash 呼び出しを自動で通してよい許可の記録
 * （Issue #863）。
 *
 * **書き手はただ1つ**——`clone.ts` の `answerApproval` が、`request_permission`
 * の要求（`PendingApproval.permissionRequest`）へ人間が定型文
 * （{@link PERMISSION_GRANT_CONSENT_PHRASE}）で、かつアカウント経由の回答
 * （`route.principalKind === 'account'`）で答えたときだけ1件作る。
 *
 * **読み手はクローン本セッションの `PreToolUse` フックだけ**
 * （`clone.ts` の `#onPreToolUse`）。Bash 呼び出しのたびに有効な（`revokedAt`
 * が付いていない）行をストアから引き直し、`rule` が一致すれば
 * `permissionDecision: 'allow'` を返して `lastUsedAt` を進める。
 *
 * **行は消さない。** 取り消しは `revokedAt` を立てるだけ（`commitment_close`
 * / `approval_withdraw` と同じ「終端は別の状態であって削除ではない」思想）。
 */
export const permissionGrantSchema = z.object({
  id: z.string(),
  /** `Bash(<完全な文字列>)` または `Bash(<前方一致>:*)`（`permission-rule.ts`）。 */
  rule: z.string(),
  /** 承認された時点の `PermissionRequest.allows` の写し（人間の判断材料の記録）。 */
  allows: z.array(z.string()),
  /** 承認された時点の `PermissionRequest.denies` の写し。 */
  denies: z.array(z.string()),
  /** この許可を生んだ `PendingApproval.id`。 */
  approvalId: z.string(),
  /** 人間が実際に送った回答の原文（{@link PERMISSION_GRANT_CONSENT_PHRASE} と一致するはず）。 */
  answer: z.string(),
  grantedAt: isoDateTime,
  route: permissionGrantRouteSchema,
  /** 取り消した時刻。無ければ有効。 */
  revokedAt: isoDateTime.optional(),
  /** `#onPreToolUse` が最後にこの許可を使って `allow` を返した時刻。 */
  lastUsedAt: isoDateTime.optional(),
});

export type PermissionGrant = z.infer<typeof permissionGrantSchema>;

// ---------------------------------------------------------------------------
// chat ストリーム（daemon → CLI）
// ---------------------------------------------------------------------------

/**
 * SSE で流す chat のイベント。CLI はこれだけを見て表示する
 * （CLI は core を埋め込まない — architecture.md「脳は1インスタンス」）。
 */
export const chatStreamEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }),
  /**
   * 受信箱に積んだ（＝受理したが、まだ順番が来ていない）。
   *
   * **`thinking` に潰さないこと。** クローンは受信箱を一件ずつ取り出して直列に
   * 処理するので（architecture.md「同時実行モデル」）、先客（蒸留・マネージャー
   * との往復・自律の起点）が走っているあいだ、届いた発言は**受理されているのに
   * 誰も考えていない**。`thinking` は「入力がモデルへ渡って最初の出力を待って
   * いる」という別の事実で、`queued` の後に必ず来る（順番が来たとき）。
   *
   * 1つの語へ寄せると、待っている理由が「順番待ち」なのか「モデルが考えている」
   * なのかを見る側から区別できなくなり、**長く待たされたときにこそ嘘になる**
   * （数分の順番待ちが「考えている」と表示される）。2つの状態には2つの語を置く。
   */
  z.object({ type: z.literal('queued') }),
  z.object({ type: z.literal('thinking') }),
  /**
   * 枠（利用上限）が閉じていて、この合図はそもそもモデルへ投げていない。
   *
   * **`queued` にも `thinking` にも潰さないこと。** `queued` は「先客が居て
   * 順番を待っている」で、`thinking` は「モデルが考えている」だが、どちらも
   * 前提は同じ — **入力はいずれモデルへ渡る**。`usage_limited` はそれが崩れて
   * いる場面である。枠が閉じているあいだ、届いた合図はモデルへ一度も渡らず、
   * 保持されたまま次の合図（人間の発言・自律の発意など）を待つ
   * （`clone.ts` の `#usageBlocked` / `#deferred`）。3つ目の語を置かず
   * どれかへ寄せると、`queued` の doc と同じ理由で**長く待たされたときにこそ
   * 嘘になる** — 枠が数時間閉じていても「順番待ち」や「考えている」と表示され
   * 続け、実際には誰も手をつけていないことが画面から見えなくなる。
   *
   * **終端ではない。** 保持したこの合図は、次に別の合図が届いたときに
   * 配り直されて実際に投げられる。ターンの終端は従来どおり `done` と `error`
   * だけである（この合図のあとには必ず `error` が続く — 送り主を待たせない
   * ため、いまは投げられないという結果を終端として返す。ただし枠が閉じたこと
   * 自体は消えない情報なので、その `error` より必ず先に出す）。
   */
  z.object({ type: z.literal('usage_limited'), message: z.string() }),
  z.object({ type: z.literal('tool'), tool: z.string() }),
  z.object({ type: z.literal('ask_human'), approvalId: z.string(), question: z.string() }),
  z.object({ type: z.literal('done') }),
  z.object({ type: z.literal('error'), message: z.string() }),
]);

export type ChatStreamEvent = z.infer<typeof chatStreamEventSchema>;

// ---------------------------------------------------------------------------
// やり方（PracticeStore） — #1055 段3
// ---------------------------------------------------------------------------

/**
 * やり方のスラッグ。`memorySlugSchema` と同じ制約にしてある（ファイル名にも
 * URL の経路にもそのまま出るので、経路要素を含めない）。
 *
 * **別の定数にしてあるのは意図である。** 記憶とやり方は別の器で、片方の制約を
 * 緩めたときにもう片方が黙って道連れになる形を作らない。
 */
export const practiceSlugSchema = z
  .string()
  .min(1)
  .max(PRACTICE_SLUG_RULE.maxLength)
  .regex(PRACTICE_SLUG_RULE.pattern, PRACTICE_SLUG_RULE.message);

/**
 * 仕事の**種類**（実装 / 調査 / 相談 / レビュー / 日報 …）。**自由文字列である。**
 *
 * ## ⛔ ここを `z.enum` にしないこと（決定。#1055 段3）
 *
 * 列挙を書いた瞬間に「仕事の種類の一覧」を実装側が決めることになる。それは
 * `docs/north_star.md` の問いに正面から当たる（逐語）:
 *
 * > 仕事の型を「実装専用」に狭めていないか？
 *
 * （続けて「人間が Claude Code に頼むのは実装だけではない」として、調査・設計の
 * 相談・外部サービスの確認・レビューを名指ししている。⚠️ 原文はこの2文が1行に
 * 並んでおり、区切りは全角空白である —— lint（`no-irregular-whitespace`）に
 * 当たるので、ここでは逐語のまま貼らずに分けてある。）
 *
 * `grep -Fn -- '仕事の型を「実装専用」に狭めていないか' docs/north_star.md`
 *
 * **いま私たちが知っている種類が全部だとは限らない。** 知らない種類のやり方を
 * 書こうとした人間が、器に拒まれる形を作らない。表記ゆれは**そのぶんの代償**として
 * 引き受ける（束ねる側が寄せればよく、器が弾く理由にはならない）。
 */
export const practiceKindSchema = z
  .string()
  .min(1)
  .max(128)
  // **NUL だけの値は空と同じ（issue #3361）。** ストアは NUL を落として残す（`nul-guard.ts`）ので、
  // NUL だけの kind は落とした後に空になり、保存層の `practiceSchema` が投げて HTTP が 500 になる。
  // 落とした後の形で入口が断る（HTTP の `practiceBody` も道具 `practice_write` もこれを通る）。
  .refine((kind) => stripNul(kind).length > 0, {
    message: 'NUL（\\u0000）だけの値は空と同じ',
  });

/**
 * 一覧に出す分（本文を含まない）。
 *
 * 本文を含まない形を別に持つのは `MemoryDocumentMeta` と同じ理由 —— 一覧の1行の
 * ために全文を運ばない。
 */
export const practiceMetaSchema = z.object({
  slug: practiceSlugSchema,
  kind: practiceKindSchema,
  /** 人間が一覧で見る短い名前。 */
  title: z.string(),
  createdAt: isoDateTime,
  updatedAt: isoDateTime,
  /**
   * 本文の文字数（コードポイント数。サロゲートペアの絵文字は1、結合文字は
   * 分かれたまま数える——UTF-16 のコード単位数でも、UTF-8 のバイト数でもない）。
   * 一覧から「空のやり方」を見分けるために出す。**保存された値ではなく、読む
   * たびに本文から導出する**（#1340。fs は `[...content].length`、pg は
   * `char_length(content)`——どちらもコードポイント数を返すので一致する）。
   */
  chars: z.number().int().nonnegative(),
});

/**
 * やり方の1行が `practiceMetaSchema` として読めなかったときに、その行の代わりに
 * 一覧へ載せるもの（issue #2346。`unreadableScheduleSchema` と同じ形）。
 *
 * **「無い」でも「消された」でもない第3の状態。** 一覧が読めない行を黙って飛ばすと、
 * 「やり方はまだ1件も無い。これは正常な状態である」と言い切れてしまう（単票の
 * `GET /practices/:slug` は 409 で言い分けている）。
 *
 * **⚠️ 本文（`content`）も題（`title`）も載せないこと。** どちらも人間・クローンの
 * 自由文がそのまま入りうる。`reason` は「どの欄が不正か」だけにする。
 */
export const unreadablePracticeSchema = z.object({
  /** 行から取れた slug。取れないこともある（fs 版で行が slug を持たない形のとき）。 */
  slug: z.string().optional(),
  /** なぜ読めなかったか（不正な欄名だけ。値は載せない）。 */
  reason: z.string(),
});
export type UnreadablePractice = z.infer<typeof unreadablePracticeSchema>;

/**
 * 認証トークンのプールの1行が `agentTokenSchema` として読めなかったときに、その行の
 * 代わりに外へ出すもの（issue #2346。`unreadableScheduleSchema` と同じ形）。
 *
 * **「登録されていない」でも「消された」でもない第3の状態。** 読めない行を黙って
 * 飛ばすと、行だけが読めないプールが「トークンは登録されていません」に見える
 * （同じ応答の `settings` は `settingsUnreadable` で言い分けている）。
 *
 * **⚠️ トークンの値（`value`）を決して載せないこと。** 識別に使うのは値を含まない
 * 欄（`id`・`label`）だけで、取れなければ載せない。`reason` は「どの欄が不正か」だけ。
 */
export const unreadableTokenSchema = z.object({
  /** 行から取れた id（文字列のときだけ）。 */
  id: z.string().optional(),
  /** 行から取れたラベル（文字列のときだけ。値ではなく人間が付けた名前）。 */
  label: z.string().optional(),
  /** なぜ読めなかったか（不正な欄名だけ。値は載せない）。 */
  reason: z.string(),
});
export type UnreadableToken = z.infer<typeof unreadableTokenSchema>;

/**
 * 許可の記録の1行が `permissionGrantSchema` として読めなかったときに、その行の代わりに
 * 外へ出すもの（issue #2536。`unreadableTokenSchema` と同じ線）。
 *
 * **「許可が無い」でも「取り消された」でもない第3の状態。** 読めない行を黙って飛ばすと、
 * 読めない行しか無い一覧が「許可はまだ1件も無い」に見える。
 *
 * **⚠️ 許可の本文（`allows` / `denies` / `answer` など）を決して載せないこと。** 識別に
 * 使うのは id だけで、取れなければ載せない。`reason` は「どの欄が不正か」だけ。
 */
export const unreadablePermissionGrantSchema = z.object({
  /** 行から取れた id（文字列のときだけ）。 */
  id: z.string().optional(),
  /** なぜ読めなかったか（不正な欄名だけ。値は載せない）。 */
  reason: z.string(),
});
export type UnreadablePermissionGrant = z.infer<typeof unreadablePermissionGrantSchema>;

/**
 * アカウントの1行が読めなかったときに、その行の代わりに外へ出すもの（issue #2536。
 * {@link unreadablePermissionGrantSchema} と同じ線）。
 *
 * **⚠️ email・identity・アクセストークンなど、行の中身を決して載せないこと。**
 * 識別に使うのは id だけ。`reason` は「どの欄が不正か」だけ。
 */
export const unreadableAccountSchema = z.object({
  /** 行から取れた id（文字列のときだけ）。 */
  id: z.string().optional(),
  /** なぜ読めなかったか（不正な欄名だけ。値は載せない）。 */
  reason: z.string(),
});
export type UnreadableAccount = z.infer<typeof unreadableAccountSchema>;

/**
 * 読めない行を、外へ返す形（`rowsUnreadable: { count, rows }`）へ畳む（issue #2536）。
 * **0件なら `undefined`**（鍵ごと無くす。`{ count: 0 }` は作らない——既存の呼び手の応答を
 * 変えないため）。`count` は全件、`rows` は **id が取れた行だけ**（id の無い行は指せない。
 * 件数には数える）。
 */
export function toRowsUnreadable(
  unreadable: readonly { id?: string | undefined; reason: string }[],
): { count: number; rows: { id: string; reason: string }[] } | undefined {
  if (unreadable.length === 0) return undefined;
  return {
    count: unreadable.length,
    rows: unreadable.flatMap((row) =>
      row.id === undefined ? [] : [{ id: row.id, reason: row.reason }],
    ),
  };
}

/**
 * 仕事のやり方（#1055 段3）。**器が持つのは「こう書いてある」までである。**
 *
 * ## ⛔ ここに「実行される」欄を足さないこと（北極星に触る）
 *
 * PRD「自律」の器には逐語でこう書いてある:
 *
 * > **器が持つのは「何を頼まれたか」と「まだ片付いていないか」だけである。**
 * > 順序も優先度も締切も持たない — それは「やることの一覧」の側であり、
 * > **何を先にやるかは記憶にある目的と価値観からクローンが毎回決め直す**
 *
 * `grep -Fn -- '器が持つのは「何を頼まれたか」と「まだ片付いていないか」だけである' docs/PRD.md`
 *
 * ⟹ **やり方の器も同じ線である。** 持つのは本文（`content`）1つだけで、
 * `steps: []` / `required: boolean` / `enforce` / `commands` のような、
 * **器の側が実行や強制を意味づける欄を置かない。**
 *
 * - やり方は**クローンが読む素材**であって、実行される定義ではない
 * - **読んで従わない自由が要る。** 従わせた時点で、クローンは「制限された
 *   自動化ジョブ」に戻る（`docs/north_star.md`）
 * - **やり方が1件も無いことは正常な状態である。** 空の器がどこかの前提を
 *   崩してはいけない（段3 の受け入れ基準「やり方が書かれていない仕事も普通に進む」）
 */
export const practiceSchema = practiceMetaSchema.extend({
  /** 本文。人間とクローンが読む散文そのもの。 */
  content: z.string(),
});

export type PracticeSlug = z.infer<typeof practiceSlugSchema>;
export type PracticeMeta = z.infer<typeof practiceMetaSchema>;
export type Practice = z.infer<typeof practiceSchema>;

/**
 * やり方の**版**（追記専用の履歴。#1309）。一覧に出す分（本文を含まない）。
 *
 * ## なぜ要るか
 *
 * `PracticeStore.write` は全文置換で、前の本文は `write()` の直接の戻り値からは
 * 二度と読めない（`practiceSchema` の doc）。#1055 段4 の受け入れ基準
 * 「過去の候補が消えていない」を満たすには、**書いた後の本文を版として積み上げる
 * 履歴が要る**——それがこれである。
 *
 * ## `PracticeMeta` と分けてある理由
 *
 * `PracticeMeta` は「いまのやり方」の1件を指すが、こちらは「ある時点で書かれた
 * 本文」を指す——同じ slug に何件も存在しうる。フィールドの意味も違う:
 * `PracticeMeta.updatedAt` は最後に書いた時刻（1個）だが、`PracticeVersionMeta.at`
 * は**その版が書かれた時刻**（版ごとに1個ずつ持つ）。
 */
export const practiceVersionMetaSchema = z.object({
  slug: practiceSlugSchema,
  /**
   * 1始まりの連番。**slug ごとに独立**（別の slug の版番号とは無関係）。
   *
   * `remove()` は版を消さないので（`PracticeStore.remove` の doc）、消した後に
   * 同じ slug を作り直しても、版番号は 1 へ戻らず**消える前の続きから**振られる
   * ——同じ slug に対して以前積んだ版が、番号の衝突なく読み続けられる。
   */
  version: z.number().int().positive(),
  kind: practiceKindSchema,
  title: z.string(),
  /**
   * この版が書かれた時刻（＝その `write()` 呼び出しの `updatedAt` と同じ瞬間）。
   *
   * `createdAt` / `updatedAt` という名にしなかったのは、版そのものには
   * 「作成」と「更新」の区別が無い（1つの版は書かれたら不変で、書き換わらない）
   * ためである——`JournalEntry.at` と同じ理由で単一の `at` にしてある。
   */
  at: isoDateTime,
  /**
   * 本文の文字数（コードポイント数。`practiceMetaSchema.chars` と同じ数え方
   * ——#1340 に倣い、版でも保存せず読むたびに本文から導出する）。
   */
  chars: z.number().int().nonnegative(),
});

export const practiceVersionSchema = practiceVersionMetaSchema.extend({
  /** その版の本文。書かれた時点のまま、以後変わらない。 */
  content: z.string(),
});

export type PracticeVersionMeta = z.infer<typeof practiceVersionMetaSchema>;
export type PracticeVersion = z.infer<typeof practiceVersionSchema>;
