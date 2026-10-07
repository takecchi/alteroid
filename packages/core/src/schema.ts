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
