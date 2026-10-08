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

export const turnFailureKindSchema = z.enum(['auth', 'quota', 'other']);

export type TurnFailureKind = z.infer<typeof turnFailureKindSchema>;

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
    // 無い行を文面から推し量って `auth` / `quota` へ読み替えない: この欄を足す前の行は種別を決めていない＝不明のため
    turnFailureKind: turnFailureKindSchema.optional(),
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
    cause: z.enum(['distill', 'clone', 'human']),
    // `optional` にする: 既存の日誌エントリを1件も壊さないため（`summary` の自由文は削らない）
    // `describe` を `write` に畳まず、`move_in` / `move_out` を `write` / `remove` にも `move` 1つにも畳まない: 区別が自由文だけに落ちる／増えた側と減った側をバイト数の大小から推測することになるため
    action: z.enum(['write', 'append', 'remove', 'describe', 'move_in', 'move_out']).optional(),
    bytesBefore: z.number().int().nonnegative().optional(),
    bytesAfter: z.number().int().nonnegative().optional(),
    summary: z.string(),
    answeredApprovalId: z.string().optional(),
  }),
  z.object({
    type: z.literal('daily_report'),
    id: z.string(),
    at: isoDateTime,
    date: z.string(),
    body: z.string(),
    // `body` を空にして代用しない: 「書けなかった」と「クローンが空文字を書いた」を区別できず、日報がある日として数えられて再試行が「もう書いた」と判断し、本物の日報が永久に書かれないため
    unavailable: z.string().optional(),
  }),
  z.object({
    type: z.literal('external_event'),
    id: z.string(),
    at: isoDateTime,
    source: z.string(),
    via: z.object({ keyId: z.string(), name: z.string() }).optional(),
    attachments: z.array(attachmentRefSchema).optional(),
    // 要約にしない: 日誌は「何かあったときに掘る」層で、何が届いたのか分からない記録は掘る役に立たないため
    summary: z.string(),
  }),
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
  z.object({
    type: z.literal('turn_usage'),
    id: z.string(),
    at: isoDateTime,
    layer: usageLayerSchema,
    site: usageSiteSchema,
    managerId: z.string(),
    sessionId: z.string().optional(),
    // 合計に潰さない: `cacheReadInputTokens` と `cacheCreationInputTokens` を分けないと、キャッシュの書き直しに払っているのかが推測になるため
    models: z.record(z.string(), usageTotalsSchema),
    reset: z
      .object({
        fromCostUsd: z.number().nonnegative(),
        toCostUsd: z.number().nonnegative(),
      })
      .optional(),
    contextUsage: contextUsageObservationSchema.optional(),
    // 配列にする: 1ターンに複数回（manual と auto が同じターンで両方）を排除する根拠が無いため。空配列は作らず、起きなければキーごと省く
    compactions: z
      .array(
        z.object({
          trigger: z.enum(['manual', 'auto']),
          preTokens: z.number().int().nonnegative(),
          postTokens: z.number().int().nonnegative().optional(),
        }),
      )
      .optional(),
    // 台帳には `result.usage` を使わない: 「メインループだけ」で、per-turn が合計か直近1回ぶんかをこの文言が決めていないため（台帳は `modelUsage` を使う）
    /**
     * **「MAIN AGENT LOOP ONLY — excludes Task subagent, sidechain, and auxiliary model calls, and is per-turn in streaming-input sessions. Prefer modelUsage for token/cost accounting」** [sdk-verbatim SDKResultSuccess.usage]
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
  // `turn_usage` に相乗りさせない: 消費の行は増分がある回にしか書かれず、失敗したターン・増分がゼロだった回の文脈占有が落ちるため
  z.object({
    type: z.literal('context_usage'),
    id: z.string(),
    at: isoDateTime,
    layer: usageLayerSchema,
    site: usageSiteSchema,
    managerId: z.string(),
    sessionId: z.string().optional(),
    turnSucceeded: z.boolean(),
    contextUsage: contextUsageObservationSchema,
  }),
  // `Inbox#unshift` は `delivered` に数えない: 戻される合図は保持される前に `push` で数えられていて、数え直すと二重に計上されるため
  // `InboxStore.pending()` が読めなければこの窓は書かず、カウンタも戻さない: 次のターンへ持ち越せば、この窓ぶんの到着・配達・消し込みを失わずに済むため
  z.object({
    type: z.literal('inbox_flow'),
    id: z.string(),
    at: isoDateTime,
    // 必ず持たせる: カウンタは器が入れ替わると0から始まり、無いと「いつからの数か」が消えて器を跨いだ比較が壊れるため
    windowStartedAt: isoDateTime,
    arrived: inboxFlowByTypeCountSchema,
    delivered: inboxFlowByTypeCountSchema,
    settled: inboxFlowByTypeCountSchema,
    pending: z.object({
      count: z.number().int().nonnegative(),
      oldestAt: isoDateTime.optional(),
    }),
    // 窓ごとに0へ戻さない: 増分ではなく時点の値で、書いた直後にクリアすると「残っている件数」という意味が壊れるため
    // `.optional()` にして `default` で埋めない: この欄が増える前の行が読み出しで丸ごと落ちるため、無いことは「観測していない」であって「0件だった」ではない
    retained: z
      .object({
        unread: z.number().int().nonnegative(),
        redelivered: z.number().int().nonnegative(),
        redeliveredClosed: z.number().int().nonnegative(),
        pendingCollapse: z.number().int().nonnegative(),
      })
      .optional(),
  }),
  // `observedBy` を必須にする: 観測した側が名乗った申告で、デーモンは値を確かめられないため
  // 古さを判定しない: `at` をそのまま返し、新しさの判断は読み手に任せるため
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
          // 任意にして `default` で埋めない: この欄が増える前の行が読み出しで丸ごと落ちるため、無いことは「CI を観測していない」であって「0 件だった」ではない
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
          // `ci` と排他にする: 取れなかったのに数を置くと 0 を作ることになり、両方あれば読み手がどちらを信じるか決められないため
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

// 日誌の枝そのものから導く: `POST /github-observations` と道具 `github_observation_record` が同じ検証を通るように、手で書き直さないため
export const githubObservationInputSchema = (
  journalEntrySchema.options.find(
    (option) => option.shape.type.value === 'github_observation',
  ) as Extract<
    (typeof journalEntrySchema.options)[number],
    { shape: { type: { value: 'github_observation' } } }
  >
).omit({ type: true, id: true, at: true });
export type JournalEntryType = JournalEntry['type'];

// 双方向の完全一致にしない: `TraceActionLike` は `describeTraceAction` が読む欄だけの最小の型で、`id` / `at` / `actor` などのぶんで必ず落ちるため
export type _AssertTraceActionMatchesLikeType = AssertTrue<
  JournalEntry extends TraceActionLike ? true : false
>;

// 双方向の完全一致にしない: `JournalDiagnosticsEntryLike` は実際に読む欄だけの最小の型で、`id` / `at` などのぶんで必ず落ちるため
export type _AssertJournalDiagnosticsMatchesLikeType = AssertTrue<
  Extract<
    JournalEntry,
    { type: 'worker_wait' | 'turn_usage' | 'context_usage' | 'inbox_flow' }
  > extends JournalDiagnosticsEntryLike
    ? true
    : false
>;

export type DailyReport = Extract<JournalEntry, { type: 'daily_report' }>;

export function isDailyReport(entry: JournalEntry): entry is DailyReport {
  return entry.type === 'daily_report';
}

// 「その日の日報はもうあるか」を数える側は `isDailyReport` ではなくこちらを使う: 印の行を数えると、後から本物を書き直す道が閉じるため
export function isWrittenDailyReport(entry: JournalEntry): entry is DailyReport {
  return isDailyReport(entry) && entry.unavailable === undefined;
}

// `satisfies Record<JournalEntryType, true>` で縛る: 足し忘れると、増えた種別だけが絞り込みから漏れて「あるのに見えない」が静かに生まれるため
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
export type JournalEntryInput = DistributiveOmit<JournalEntry, 'id' | 'at'>;

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export const scheduleKindSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9._-]*$/, 'kind は英小文字・数字・. _ - のみ');

// 上限を置く: 無いと `Date` の範囲を超える値が保存でき、次の予定が Invalid Date になって、行は保存済みなので再起動しても直らないため
export const SCHEDULE_EVERY_MINUTES_MAX = 525_600;

export const SCHEDULE_EVERY_MINUTES_MAX_MESSAGE = `every の分数は 1以上${SCHEDULE_EVERY_MINUTES_MAX}（1年）以下の整数のみ。それより長い周期は cron 式か単発の予定で書く`;

// 「何回まで」を表す形を足さない: 周期は方針であって抑止装置ではないため
export const scheduleSpecSchema = z.discriminatedUnion('type', [
  // 時刻の範囲までここで見る: 形だけ見て通すと `25:99` が保存でき、検査を経路ごとに置くとどれか1本を通り忘れた時点で穴になるため
  z.object({
    type: z.literal('daily'),
    at: z.string().regex(/^(?:[01]?\d|2[0-3]):[0-5]\d$/, 'HH:MM（00:00〜23:59）で書く'),
  }),
  z.object({
    type: z.literal('every'),
    minutes: z
      .number()
      .int()
      .min(1)
      .max(SCHEDULE_EVERY_MINUTES_MAX, SCHEDULE_EVERY_MINUTES_MAX_MESSAGE),
  }),
  // 「毎週月曜」を `daily` で代用させない: 毎日起きて曜日を見る形になり、7回に6回は上位モデルのターンを空焼きするため
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

export const scheduledRequestSchema = z.object({
  kind: scheduleKindSchema,
  spec: scheduleSpecSchema,
  request: z.string().min(1),
  createdAt: isoDateTime,
  updatedAt: isoDateTime,
  lastRunAt: isoDateTime.optional(),
  // `lastRunAt` と分ける: 手で起こした1回で位相を動かさないため（一緒にすると、再起動した瞬間に定期の予定がその分ずれる）
  lastScheduledRunAt: isoDateTime.optional(),
  // 印と基準（`lastScheduledRunAt`）の両方を持つ: 印が無いと claim の直後に落ちた発火が「もう動いた」と見えて消え、印だけだと動いた後に落ちたときの二重実行を止められないため
  pendingRun: z.object({ at: isoDateTime, cause: z.enum(['schedule', 'manual']) }).optional(),
});

export type ScheduleKind = z.infer<typeof scheduleKindSchema>;
export type ScheduleSpec = z.infer<typeof scheduleSpecSchema>;
export type ScheduledRequest = z.infer<typeof scheduledRequestSchema>;

// 本文（`request`）を載せない: 人間の依頼文がそのまま入りうるため
export const unreadableScheduleSchema = z.object({
  kind: z.string().optional(),
  reason: z.string(),
});
export type UnreadableSchedule = z.infer<typeof unreadableScheduleSchema>;

// `ScheduledRequest` と同じ行にしない: 既定の仕込みがクローンから「継続中の依頼」に見えて `schedule_remove` で消せてしまい、`schedule_list` の「既定の定期ジョブはここには出ない」の約束が静かに破れるため
// 既定の仕込みの名前をここに書き写さない: 数え上げを持つのは `RESERVED_SCHEDULE_KINDS`（`schedule.ts`）だけで、書き写すと足された後も取り残されるため
export const schedulePhaseSchema = z.object({
  kind: z.string().min(1),
  lastScheduledRunAt: isoDateTime.optional(),
  lastRunAt: isoDateTime.optional(),
});

export type SchedulePhase = z.infer<typeof schedulePhaseSchema>;

// 起点（`origin`）を落とさない: 落とすと、一覧を見たクローンが人間との約束か自分で思い立ったことかを区別できないため
export const commitmentOriginSchema = z.enum(['human', 'manager', 'external', 'self']);

// `origin` から導出しない: 人間が積んだ仕事をクローンが片付けることも、クローンが立てた仕事を人間が片付けることもあるため
// 書き込み側だけをこの enum で縛る: `commitmentSchema.closedBy` に使うと、保存層（`parseCommitment`）は未知の enum 値1つで台帳の一覧を丸ごと読めなくするため
export const commitmentClosedBySchema = z.enum(['clone', 'human']);

export const commitmentEditedBySchema = z.enum(['clone', 'human']);

// 順序・優先度・締切を持たない: 持つと「やることの一覧」になり、判断をクローンに残せないため
export const commitmentSchema = z.object({
  id: z.string(),
  at: isoDateTime,
  origin: commitmentOriginSchema,
  source: z.string().optional(),
  // 要約にしない: 器が要約を持つと「頼まれた内容そのもの」が二度と取れなくなるため
  body: z.string(),
  closedAt: isoDateTime.optional(),
  // 「閉じた」だけを残さない: 人間が後から否定するには、何をもって終わりとしたのかが要るため
  closedReason: z.string().optional(),
  // 既定へ倒さない: `undefined` は「この欄が入る前の行」で、`'clone'` / `'human'` へ倒すと黙って化けるため
  // `z.enum` にしない: `parseCommitment` は未知の値1つで台帳の一覧を丸ごと読めなくし、未知の値は `undefined` へ潰さずそのまま保持するため
  closedBy: z
    .string()
    .optional()
    .describe(
      "既知の値は 'clone' | 'human'（commitmentClosedBySchema）。無いこともある" +
        '（この欄が入る前の行）。台帳の完全性より由来の注記の厳密さを優先しないため、' +
        '型としては任意の文字列を許す。',
    ),
  // `z.enum` を置かない: `closedBy` と同じく未知の値1つで台帳の一覧が丸ごと読めなくなるため（網羅性は書き込み側の型 `TextMarkup` と表示側の narrow で保つ）
  bodyMarkup: z.string().optional(),
  // 日誌へ前後の本文を残さない編集の口を足さない: 台帳が静かに書き換わると、クローンが過去の自分を追えなくなるため
  editedAt: isoDateTime.optional(),
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

// `reason` に依頼の本文（`body`）を載せない: `JSON.stringify(生の値)` を足すと、秘密がテスト出力へ全文で出た事故（`dropped-record.ts`）の再発になるため
export const unreadableCommitmentSchema = z.object({
  id: z.string().optional(),
  at: isoDateTime.optional(),
  reason: z.string(),
});
export type UnreadableCommitment = z.infer<typeof unreadableCommitmentSchema>;

export function commitmentUpdatedAt(entry: Pick<Commitment, 'at' | 'closedAt'>): string {
  return entry.closedAt ?? entry.at;
}

// 新しい状態を「書く」場所を作らず、既存の日誌の `exchange` を読むだけにする: クローンが手で維持する欄を足すと、クローンはそれを忘れるため
// 「人間の回答待ち」は出さない: `PendingApproval` と `Commitment` を結ぶ id が無く、結べないものを出すと判定を丸めた嘘になるため
export function commitmentRespondedAt(
  commitment: Pick<Commitment, 'origin' | 'source' | 'at'>,
  humanOutboundRepliesByConversation: ReadonlyMap<string, readonly string[]>,
): string | undefined {
  if (commitment.origin !== 'human' || commitment.source === undefined) return undefined;
  const replies = humanOutboundRepliesByConversation.get(commitment.source);
  if (replies === undefined) return undefined;
  // 並べ直さない: ソートは組み立て側で1回だけ行うため
  return replies.find((at) => at > commitment.at);
}

// `at` より後に始まった委譲だけを数える: 行より前の委譲は、別の古い頼みごとに応えたものである可能性が高いため
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

// `lost` を `done` と一緒にしない: 潰すと、戻せなかった仕事が「完了」として片付き、誰も起こし直さないまま消えるため
// `stopped` を「話しかけても続かない」にしない: 人間が止めた Claude Code のセッションを `manager_send` の resume で戻せる能力を消すことになり、禁止2（追加制限禁止）に触れるため
// `stopped` を `done` と一緒にしない: 止めたはずのマネージャーが「待機中」と見えて、話しかけられる相手が残るため
/**
 * **ただし `lost` は「成果が無い」ではない。** 観測しているのは「戻れなかった」
 * ことだけで、デーモンは PR もブランチも見に行かない（リポジトリの事情は
 * マネージャーの領域である）。落ちる直前にマージまで済ませていた仕事が `lost` に
 * なった例が実際にある。**起こし直すかどうかは、外へ出た成果（PR・コミット・送信済みのメール・登録済みの予定・投稿先など）を確かめてから決める。**
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

// `JobStatus` をそのまま使わず手で写す: 軽い口（`job-status-running.ts`）は zod を import できないため
export type _AssertJobStatusMatchesRunningLikeType = AssertTrue<
  [JobStatus] extends [JobStatusLike] ? ([JobStatusLike] extends [JobStatus] ? true : false) : false
>;

export const workspaceLocatorSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('runner-volume'),
    runnerId: z.string(),
    path: z.string(),
  }),
  z.object({ kind: z.literal('shared-volume'), path: z.string() }),
  // 永続性を確かめずに `runner-volume` と書かない: 存在しない永続性を主張し、「復旧できる」と信じる方向へ嘘をつくため（確かめられないときは `reason` に何が取れなかったかを書く）
  z.object({
    kind: z.literal('unknown'),
    runnerId: z.string(),
    path: z.string(),
    // 空にしない: 理由の無い「分からない」は値と同じため
    reason: z.string(),
  }),
  z.object({
    kind: z.literal('git'),
    repository: z.string(),
    ref: z.string(),
    patchId: z.string().optional(),
  }),
]);

export type WorkspaceLocator = z.infer<typeof workspaceLocatorSchema>;

// 時刻はすべてデーモンの時計にする: 器をまたいで時計を合わせる前提を置かない（runner へ渡すのは相対の `ttlMs` だけ）
// `runnerId` だけにしない: 名前は器を作り直しても同じで、握っているプロセスの同一性は `instanceId` を並べて初めて表せるため
export const jobLeaseSchema = z.object({
  runnerId: z.string(),
  // 欠けるときは判定しない: `identity()` を持たない runner は名乗らないため
  instanceId: z.string().optional(),
  // 返しても 1 へ戻さない: 返却の契機は runner から遅れて届きうるので、数え直すと runner が覚えている世代より小さい世代を渡して 409 で拒まれ、届かないことを「戻せなかった」と読んだ側が起こし直して二重実行になるため
  fence: z.number().int().nonnegative(),
  grantedAt: isoDateTime,
  seenAt: isoDateTime,
  ttlMs: z.number().int().positive(),
  // 消さず印を立てる: 世代（`fence`）を残すため（確かめていない停止では立てない）
  releasedAt: isoDateTime.optional(),
});

export type JobLease = z.infer<typeof jobLeaseSchema>;

// `unpushedWorkTreeSchema`（`runner-protocol.ts`）を参照せず形を複製する: あちらが `schema.ts` を import しており、逆向きの import が循環参照になるため
export const observedWorktreeBranchSchema = z.object({
  relativePath: z.string(),
  branch: z.string().nullable(),
  remoteOrigin: z
    .object({
      host: z.string(),
      path: z.string(),
    })
    .optional(),
  // `0` で埋めない: 古い行・古い runner は持たないため
  unpushedCommitCount: z.number().int().nonnegative().optional(),
  unpushedCommitCountUnknown: z.string().optional(),
  uncommittedChangeCount: z.number().int().nonnegative().optional(),
  uncommittedChangeCountUnknown: z.string().optional(),
});

export type ObservedWorktreeBranch = z.infer<typeof observedWorktreeBranchSchema>;

// `unavailable` と欄ごとの `undefined` を混ぜない: 確かめようとして取れなかったのと、一度もこの分岐を通っていないのは別のため
// `source` を持つ: 時刻だけだと、器の入れ替えで見失った後に前のターンの観測が「止まる直前にも0件だった」と誤読されるため。無いことをどれかの経路だと見なさない
// 「常に最新の枝が分かる」とは読まない: 報告の前に落ちた委譲は、`git push` も枝作成も `closed` も `shutdown_unpushed_work` も届かなければ拾えないため
// 「成果が届いたか」は含めない: この欄が答えるのは見るべき枝までで、push 済みか・PR が在るかは別の答えのため
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
    at: isoDateTime,
    source: unpushedWorkObservationSourceSchema.optional(),
    cwd: z.string(),
    worktrees: z.array(observedWorktreeBranchSchema),
    truncatedAtCount: z.number().int().positive().optional(),
    stoppedEarly: z.literal(true).optional(),
    scratchRootsUnknown: z.string().optional(),
    // `unreadableDirSample` は写さない: 絶対パスを含みうるため、「出してよい範囲（有無・件数・枝名まで）」の外になる
    unreadableDirCount: z.number().int().positive().optional(),
  }),
  z.object({
    kind: z.literal('unavailable'),
    at: isoDateTime,
    source: unpushedWorkObservationSourceSchema.optional(),
    reason: z.string(),
  }),
]);

export type LastUnpushedWorkObservation = z.infer<typeof lastUnpushedWorkObservationSchema>;

// 理由は分類で、git の生の文面を運ばない: stderr にはパスや URL の断片が混ざりうるため
export const rescueNotPushedReasonSchema = z.enum([
  'nothing-tracked',
  'secret-like',
  'too-large',
  'no-credential',
  'no-remote',
  'push-failed',
  'error',
  'timeout',
]);
export type RescueNotPushedReason = z.infer<typeof rescueNotPushedReasonSchema>;

export const rescueRemovalReasonSchema = z.enum([
  // 内容が origin の枝に入っていた（runner が `landedAt` を付けた）
  'landed',
  'done',
  'failed',
  'stopped',
]);
export type RescueRemovalReason = z.infer<typeof rescueRemovalReasonSchema>;

export const rescueRemovalFailureKindSchema = z.enum([
  'auth',
  'network',
  'timeout',
  'moved',
  'no-remote',
  'no-runner',
  'other',
]);
export type RescueRemovalFailureKind = z.infer<typeof rescueRemovalFailureKindSchema>;

export const rescueRemovalSchema = z.object({
  at: isoDateTime,
  reason: rescueRemovalReasonSchema,
  failureKind: rescueRemovalFailureKindSchema.optional(),
  attempts: z.number().int().positive().optional(),
});
export type RescueRemoval = z.infer<typeof rescueRemovalSchema>;

// 未追跡は名前だけを出す: 中身は出さない
export const rescueWorktreeSchema = z.object({
  relativePath: z.string(),
  branch: z.string().nullable(),
  at: isoDateTime,
  pushed: z
    .object({
      ref: z.string(),
      commit: z.string(),
      at: isoDateTime,
      // userinfo・クエリ・フラグメントは落とす: 資格を台帳へ持ち込まないため
      remote: z.string().optional(),
      tree: z.string().optional(),
      landedAt: isoDateTime.optional(),
      // `pushed` を消さず印を付ける: 消した事実と、いつ・なぜを残すため
      removal: rescueRemovalSchema.optional(),
    })
    .optional(),
  notPushed: z
    .object({
      reason: rescueNotPushedReasonSchema,
      failureKind: z.enum(['auth', 'network', 'rejected', 'timeout', 'other']).optional(),
      files: z.array(z.string()).optional(),
    })
    .optional(),
  untracked: z
    .object({
      count: z.number().int().positive(),
      paths: z.array(z.string()),
      omitted: z.number().int().nonnegative(),
    })
    .optional(),
  submoduleCount: z.number().int().positive().optional(),
});
export type RescueWorktree = z.infer<typeof rescueWorktreeSchema>;

export const lastRescueSchema = z.object({
  at: isoDateTime,
  worktrees: z.array(rescueWorktreeSchema),
  // 猶予は `max(at, terminal.seenAt)` から数える: `at` だけだと、`lost` のまま長く放置されたものが `stopped` へ畳まれた瞬間に猶予ゼロで消えるため
  terminal: z
    .object({ status: z.enum(['done', 'failed', 'stopped']), seenAt: isoDateTime })
    .optional(),
});
export type LastRescue = z.infer<typeof lastRescueSchema>;

// 双方向の完全一致にしない: `UnpushedWorkObservationIncompletenessLike` は読む4欄だけの最小の型で、`at` / `cwd` / `worktrees` / `source` を持たないため、双方向だと必ず落ちる
export type _AssertUnpushedWorkObservationIncompletenessMatchesLikeType = AssertTrue<
  Extract<
    LastUnpushedWorkObservation,
    { kind: 'observed' }
  > extends UnpushedWorkObservationIncompletenessLike
    ? true
    : false
>;

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
  // `commitmentId` のような専用の欄を足さず、`ToolContext.conversationId` を自動で写す: クローンが手で維持する欄を足すと、クローンはそれを忘れるため
  conversationId: z.string().optional(),
  managerId: z.string().optional(),
  sessionId: z.string().optional(),
  // `projectKey` + `sessionId` の対で持つ: ローカルのトランスクリプトはコンテナと一緒に消え、無いと器を作り直した後に生ログを引き当てられないため
  projectKey: z.string().optional(),
  summary: z.string(),
  request: z.string().optional(),
  // 頼んだ値のまま残ったものを「確認して一致した」と読まない: 古い runner は応答に `cwd` を持たないため
  cwd: z.string().optional(),
  // 1台構成でも最初から残す: 後から足すと、既存のジョブに宛先が無いため
  runnerId: z.string().optional(),
  workspace: workspaceLocatorSchema.optional(),
  // 欠けているときも引き取りを許す: そうしないと、この欄が無かった頃のジョブと貸し出しを名乗らない runner のジョブが永久に引き取れなくなるため
  lease: jobLeaseSchema.optional(),
  // 台帳に置く: runner は SSE の再接続で同じ出来事を配り直すことがあり、プロセス内の集合では再起動の後の二重を止められないため
  lateDoneNotifiedAt: isoDateTime.optional(),
  runnerSessionSince: isoDateTime.optional(),
  // 「1セッションにつき1回」にする: `closed` には冪等キーが無く、SSE の再配達で同じ `closed(done)` が2度届くと知らせが「×2」になるため
  silentDoneNotifiedFor: z.union([isoDateTime, z.literal('')]).optional(),
  // `lease.instanceId` を判定材料にしない: 貸し出しは `runner.resume()` を出す前に進むので、resume が失敗した枝で「もう告げた」と読めて二度と告げられなくなるため
  // 名簿を引き直さず、その回に claim した相手を写す: 引き直すと、resume の最中に器が入れ替わった回に「新しい器へ載った」と書いて以後ずっと告げなくなるため
  // 名乗らない値で上書きしない（`undefined` を書き込まない）: 一度名乗った器の値を残すため
  sessionInstanceId: z.string().optional(),
  // `.strict()` にしない: 撤去した `managerProvider` が旧い行に残りうるが、`z.object` は未知の欄を黙って捨てるので読み込みは落ちないため
  // 退避済みトランスクリプト以外の生ログへの入口をここに持たない: runner のローカルパスを台帳に書くと、runner が入れ替わった瞬間に嘘になるため
  archiveIds: z.array(z.string()).optional(),
  lastReport: z.string().optional(),
  // 「受け取った」だけを名乗る: 報告の生成時刻も、クローンのターンへ入った時刻も取れないため
  lastReportAt: z.string().optional(),
  // `event.status` をそのまま書く（書き換え前の値にしない）: 問いは「この報告が運んだ内容はどの status に対応するか」で、書き換え前だとほぼ常に `running` になるため
  // 既定値を作らない: 欄を持たない古い行は比較できず、`describeReportDrift` は何も足さないため
  lastReportStatus: jobStatusSchema.optional(),
  // `status` を `failed` へ倒さない: 支出上限に当たった回もセッションは生きていて、話しかけ直せるため
  lastFailure: z
    .object({
      code: z.string(),
      via: z.string(),
      at: isoDateTime,
    })
    .optional(),
  // `lastFailure` と同じ欄に混ぜない: こちらは SDK からその声明すら届かないまま畳まれた回で、軸が違うため（`reason` は言い換えずそのまま運ぶ）
  lastUnreported: z
    .object({
      reason: z.string(),
      at: isoDateTime,
    })
    .optional(),
  // `lastReport` と同じ欄に混ぜない: 畳まれた本文を混ぜると、完遂した報告と止めた後に打ち切られた途中経過を区別できなくなるため
  // `manager_stop` の応答を組む時点で埋まっていなくても、その待ちのために止めない: 止まらない委譲を止めたい場面でその待ちが効くため
  // 通常の回では `delete` で下ろす: 下ろさないと、再開して報告し始めた後も古い畳まれた本文が居座り、`manager_report` / `manager_list` の見出しを誤らせるため
  lastFoldedTurn: z
    .object({
      text: z.string(),
      at: isoDateTime,
    })
    .optional(),
  // `lastFailure` と同じ欄に混ぜない: こちらはセッションそのものが畳まれた OS 由来の事実で軸が違う。`code` を持たない例外では立てず、取れなかったを値で埋めない
  // 新しいターンの出力が届いた回に下ろす: 下ろさないと、起こし直されたマネージャーに過去の落ち方が貼り付いたままになるため
  lastSystemError: systemErrorFactsSchema.extend({ at: isoDateTime }).optional(),
  // `lastSystemError` と同じ欄に混ぜない: signal で畳まれた回（`lastSystemError` が立たない回）にこそ効く軸のため
  lastCgroupEvents: cgroupEventsDeltaSchema.extend({ at: isoDateTime }).optional(),
  // 台帳にも持つ: `#usageStopped` はデーモンが作り直されると消え、終端している `done` / `failed` / `lost` の委譲が誰にも起こされないまま座り続けるため
  usageStoppedAt: isoDateTime.optional(),
  lastUnpushedWorkObservation: lastUnpushedWorkObservationSchema.optional(),
  // `lastUnpushedWorkObservation` と別の欄にする: あちらは新しいほうが勝つ上書き、こちらは作業ツリーごとに積み増すため
  lastRescue: lastRescueSchema.optional(),
});

export type Job = z.infer<typeof jobSchema>;

export type _AssertSystemErrorFactsMatchesLikeType = AssertTrue<
  [SystemErrorFacts] extends [SystemErrorFactsLike]
    ? [SystemErrorFactsLike] extends [SystemErrorFacts]
      ? true
      : false
    : false
>;

export type _AssertCgroupEventsDeltaMatchesLikeType = AssertTrue<
  [CgroupEventsDelta] extends [CgroupEventsDeltaLike]
    ? [CgroupEventsDeltaLike] extends [CgroupEventsDelta]
      ? true
      : false
    : false
>;

export const permissionRequestSchema = z.object({
  rule: z.string(),
  allows: z.array(z.string()),
  denies: z.array(z.string()),
});

export type PermissionRequest = z.infer<typeof permissionRequestSchema>;

export const pendingApprovalSchema = z.object({
  id: z.string(),
  createdAt: isoDateTime,
  question: z.string(),
  context: z.string().optional(),
  jobId: z.string().optional(),
  // `jobId` だけにしない: 1本のマネージャーが同時に複数を待つので、欠けると回答をどの確認へ返すか決められず、答えたのに仕事が再開しないため
  requestId: z.string().optional(),
  answeredAt: isoDateTime.optional(),
  answer: z.string().optional(),
  // `request_permission` の承認待ちには付けない: 許可/拒否は `decision` が持つため
  questions: z.array(approvalQuestionSchema).optional(),
  selections: z.array(approvalSelectionSchema).optional(),
  // `undefined` は「記録なし」と読む: 「わからない」を「わかったが operator ではない」に化けさせないため
  answeredVia: answeredViaSchema.optional(),
  // `undefined` は拾い直しの対象にしない: 遡って配り直すと、とっくに人間の目から消えた古い回答が今さら届くため
  answerDelivery: z.enum(['pending', 'delivered']).optional(),
  conversationId: z.string().optional(),
  // 行は消さない: `commitment_close` と同じく、理由ごと読み戻せるようにするため
  withdrawnAt: isoDateTime.optional(),
  withdrawnReason: z.string().optional(),
  permissionRequest: permissionRequestSchema.optional(),
});

export type PendingApproval = z.infer<typeof pendingApprovalSchema>;

// 本文（`question` / `context` / `answer`）を載せない: 人間の依頼文や回答がそのまま入りうるため
export const unreadableApprovalSchema = z.object({
  id: z.string().optional(),
  reason: z.string(),
});
export type UnreadableApproval = z.infer<typeof unreadableApprovalSchema>;

// 本文（依頼文・報告・cwd など）を載せない: 人間の依頼文・マネージャーの報告がそのまま入りうるため
export const unreadableJobSchema = z.object({
  id: z.string().optional(),
  reason: z.string(),
});
export type UnreadableJob = z.infer<typeof unreadableJobSchema>;

export function approvalUpdatedAt(
  approval: Pick<PendingApproval, 'createdAt' | 'answeredAt' | 'withdrawnAt'>,
): string {
  return approval.withdrawnAt ?? approval.answeredAt ?? approval.createdAt;
}

// 定型文とちょうど一致した回答だけを許可として記録する: 定型文から外れた回答は、人間が実際に何を承認したのか機械的に確定できないため、記録しない側へ倒す
export const PERMISSION_GRANT_CONSENT_PHRASE = '許可します';

// `principalKind` は `'account'` の1値にする: `operator` 経路の回答は `PermissionGrant` を作らない不変条件を型で運ぶため
export const permissionGrantRouteSchema = z.object({
  principalKind: z.literal('account'),
  accountId: z.string(),
});

export type PermissionGrantRoute = z.infer<typeof permissionGrantRouteSchema>;

// 行は消さず `revokedAt` を立てる: 終端は別の状態であって削除ではないため
export const permissionGrantSchema = z.object({
  id: z.string(),
  rule: z.string(),
  allows: z.array(z.string()),
  denies: z.array(z.string()),
  approvalId: z.string(),
  answer: z.string(),
  grantedAt: isoDateTime,
  route: permissionGrantRouteSchema,
  revokedAt: isoDateTime.optional(),
  lastUsedAt: isoDateTime.optional(),
});

export type PermissionGrant = z.infer<typeof permissionGrantSchema>;

export const chatStreamEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }),
  // `thinking` に潰さない: 先客が走っているあいだ、届いた発言は受理されているのに誰も考えておらず、長く待たされたときにこそ嘘になるため
  z.object({ type: z.literal('queued') }),
  z.object({ type: z.literal('thinking') }),
  // `queued` にも `thinking` にも潰さない: 枠が閉じている間は入力がモデルへ一度も渡らず、数時間閉じていても「順番待ち」や「考えている」と表示され続けて、誰も手をつけていないことが見えなくなるため
  z.object({ type: z.literal('usage_limited'), message: z.string() }),
  z.object({ type: z.literal('tool'), tool: z.string() }),
  z.object({ type: z.literal('ask_human'), approvalId: z.string(), question: z.string() }),
  z.object({ type: z.literal('done') }),
  /**
   * ターンの終端（失敗）。`kind` は失敗の種別で、**文面から推し量らずこの欄を読む**（`turnFailureKindSchema`）。
   * 言い切れない失敗は `other`。
   */
  z.object({ type: z.literal('error'), message: z.string(), kind: turnFailureKindSchema }),
]);

export type ChatStreamEvent = z.infer<typeof chatStreamEventSchema>;

// `memorySlugSchema` と別の定数にする: 記憶とやり方は別の器で、片方の制約を緩めたときにもう片方が黙って道連れになる形を作らないため
export const practiceSlugSchema = z
  .string()
  .min(1)
  .max(PRACTICE_SLUG_RULE.maxLength)
  .regex(PRACTICE_SLUG_RULE.pattern, PRACTICE_SLUG_RULE.message);

// `z.enum` にしない: 列挙を書くと仕事の種類の一覧を実装側が決めることになり、north_star の「仕事の型を「実装専用」に狭めていないか」に当たるため
export const practiceKindSchema = z
  .string()
  .min(1)
  .max(128)
  // NUL だけの値は落とした後の形で入口が断る: ストアは NUL を落として残すので、落とした後に空になり、保存層の `practiceSchema` が投げて HTTP が 500 になるため
  .refine((kind) => stripNul(kind).length > 0, {
    message: 'NUL（\\u0000）だけの値は空と同じ',
  });

export const practiceMetaSchema = z.object({
  slug: practiceSlugSchema,
  kind: practiceKindSchema,
  title: z.string(),
  createdAt: isoDateTime,
  updatedAt: isoDateTime,
  // 保存した値にしない: 読むたびに本文から導出する（fs と pg はどちらもコードポイント数を返すので一致する）
  chars: z.number().int().nonnegative(),
});

// 本文（`content`）も題（`title`）も載せない: どちらも人間・クローンの自由文がそのまま入りうるため
export const unreadablePracticeSchema = z.object({
  slug: z.string().optional(),
  reason: z.string(),
});
export type UnreadablePractice = z.infer<typeof unreadablePracticeSchema>;

// トークンの値（`value`）を載せない: 識別に使うのは値を含まない `id` / `label` だけにするため
export const unreadableTokenSchema = z.object({
  id: z.string().optional(),
  label: z.string().optional(),
  reason: z.string(),
});
export type UnreadableToken = z.infer<typeof unreadableTokenSchema>;

// 許可の本文（`allows` / `denies` / `answer` など）を載せない: 識別に使うのは id だけにするため
export const unreadablePermissionGrantSchema = z.object({
  id: z.string().optional(),
  reason: z.string(),
});
export type UnreadablePermissionGrant = z.infer<typeof unreadablePermissionGrantSchema>;

// email・identity・アクセストークンなど行の中身を載せない: 識別に使うのは id だけにするため
export const unreadableAccountSchema = z.object({
  id: z.string().optional(),
  reason: z.string(),
});
export type UnreadableAccount = z.infer<typeof unreadableAccountSchema>;

// 0件なら `undefined` にして `{ count: 0 }` を作らない: 既存の呼び手の応答を変えないため
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

// 「実行される」欄（`steps` / `required` / `enforce` / `commands` など）を足さない: 器が実行や強制を意味づけると、読んで従わない自由が無くなり、クローンが「制限された自動化ジョブ」に戻るため
export const practiceSchema = practiceMetaSchema.extend({
  content: z.string(),
});

export type PracticeSlug = z.infer<typeof practiceSlugSchema>;
export type PracticeMeta = z.infer<typeof practiceMetaSchema>;
export type Practice = z.infer<typeof practiceSchema>;

export const practiceVersionMetaSchema = z.object({
  slug: practiceSlugSchema,
  // 版を消さず、作り直しても 1 へ戻さない: 消える前の続きから振ると、以前積んだ版が番号の衝突なく読み続けられるため
  version: z.number().int().positive(),
  kind: practiceKindSchema,
  title: z.string(),
  // `createdAt` / `updatedAt` に分けない: 1つの版は書かれたら不変で、「作成」と「更新」の区別が無いため
  at: isoDateTime,
  chars: z.number().int().nonnegative(),
});

export const practiceVersionSchema = practiceVersionMetaSchema.extend({
  content: z.string(),
});

export type PracticeVersionMeta = z.infer<typeof practiceVersionMetaSchema>;
export type PracticeVersion = z.infer<typeof practiceVersionSchema>;
