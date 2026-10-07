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

export const rescueRemovalReasonSchema = z.enum(['landed', 'done', 'failed', 'stopped']);
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
