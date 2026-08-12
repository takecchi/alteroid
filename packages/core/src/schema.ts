import { z } from 'zod';

/**
 * 型付きメッセージのスキーマ（docs/architecture.md「配線」）。
 *
 * ここに定義されるのは層をまたぐメッセージだけである。M1 で実際に流れるのは
 * 人間の発言だけだが、受信箱・日誌・ジョブの構造は最初からイベント駆動で置く
 * （chat 専用の作りにすると M3 で自律に化けられない — AGENTS.md 地雷4）。
 */

const isoDateTime = z.string().datetime({ offset: true });

// ---------------------------------------------------------------------------
// 記憶（PersonaStore）
// ---------------------------------------------------------------------------

/** 記憶文書のスラッグ。ファイル名にそのまま使うので経路要素を含めない。 */
export const memorySlugSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z0-9][a-z0-9._-]*$/, 'slug は英小文字・数字・. _ - のみ');

export const memoryDocumentMetaSchema = z.object({
  slug: memorySlugSchema,
  /** 文書の先頭見出し（`# ...`）。無ければ slug。 */
  title: z.string(),
  updatedAt: isoDateTime,
  bytes: z.number().int().nonnegative(),
});

export const memoryDocumentSchema = memoryDocumentMetaSchema.extend({
  content: z.string(),
});

export type MemorySlug = z.infer<typeof memorySlugSchema>;
export type MemoryDocumentMeta = z.infer<typeof memoryDocumentMetaSchema>;
export type MemoryDocument = z.infer<typeof memoryDocumentSchema>;

// ---------------------------------------------------------------------------
// 受信箱イベント
// ---------------------------------------------------------------------------

/**
 * 仕事の起点（PRD「自律」の4つ）。M1 で届くのは `human` だけだが、
 * 判別可能ユニオンとして最初から4つ揃えておく。
 */
export const inboxEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('human_message'),
    id: z.string(),
    at: isoDateTime,
    text: z.string(),
    /** 人間が chat セッションを閉じたか（会話終了 = 蒸留の契機） */
    conversationId: z.string(),
  }),
  z.object({
    type: z.literal('human_answer'),
    id: z.string(),
    at: isoDateTime,
    /** 承認待ちキューの項目 id */
    approvalId: z.string(),
    answer: z.string(),
  }),
  z.object({
    type: z.literal('distill'),
    id: z.string(),
    at: isoDateTime,
    reason: z.enum(['conversation_end', 'shutdown']),
  }),
  z.object({
    type: z.literal('timer'),
    id: z.string(),
    at: isoDateTime,
    /** 何の定期ジョブか（M3） */
    kind: z.string(),
  }),
  z.object({
    type: z.literal('external'),
    id: z.string(),
    at: isoDateTime,
    source: z.string(),
    payload: z.unknown(),
  }),
  z.object({
    type: z.literal('self_initiative'),
    id: z.string(),
    at: isoDateTime,
    reason: z.string(),
  }),
  z.object({
    type: z.literal('manager_message'),
    id: z.string(),
    at: isoDateTime,
    managerId: z.string(),
    /** マネージャーからの報告 / 質問 / 許可確認 */
    kind: z.enum(['report', 'question', 'permission']),
    text: z.string(),
    /**
     * 質問・許可確認のときだけ付く。マネージャー側でその1件が返事を待って
     * 止まっている。クローンが `manager_send` で答えるとそこだけが再開する。
     */
    requestId: z.string().optional(),
  }),
]);

export type InboxEvent = z.infer<typeof inboxEventSchema>;
export type InboxEventType = InboxEvent['type'];

// ---------------------------------------------------------------------------
// 日誌エントリ
// ---------------------------------------------------------------------------

/**
 * 追記専用の記録（PRD「可観測性」の中段）。
 * 型は architecture.md の JournalStore 行に対応する。
 */
export const journalEntrySchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('exchange'),
    id: z.string(),
    at: isoDateTime,
    /**
     * 誰との往復か。`self` は人間に見せない内部ターン（蒸留・自律の起点）。
     * 内部ターンも必ず日誌に残す — 見えない層を作らない（PRD「可観測性」）。
     */
    with: z.enum(['human', 'manager', 'self']),
    role: z.enum(['inbound', 'outbound']),
    text: z.string(),
    conversationId: z.string().optional(),
  }),
  z.object({
    type: z.literal('decision'),
    id: z.string(),
    at: isoDateTime,
    /** 何を判断したか */
    decision: z.string(),
    /** 記憶のどこに根拠があったか（無ければ人間に聞いたはず） */
    grounds: z.string(),
  }),
  z.object({
    type: z.literal('escalation'),
    id: z.string(),
    at: isoDateTime,
    question: z.string(),
    /** 承認待ちキューの項目 id、またはマネージャーの確認1件の id。 */
    approvalId: z.string(),
    /** マネージャー発の確認ならその manager_id（誰が止まっているかを辿るため）。 */
    managerId: z.string().optional(),
    answeredAt: isoDateTime.optional(),
    answer: z.string().optional(),
  }),
  z.object({
    type: z.literal('tool_use'),
    id: z.string(),
    at: isoDateTime,
    /**
     * 実行した層。`manager:<id>` / `worker:<id>:<agent>` の形で入る。
     * マネージャーと作業者の全ツール実行がここに落ちる（監査）。
     */
    actor: z.string(),
    tool: z.string(),
    input: z.unknown(),
  }),
  z.object({
    type: z.literal('memory_update'),
    id: z.string(),
    at: isoDateTime,
    slug: memorySlugSchema,
    /** 蒸留・人間の直接編集・クローンの書き込みのどれか */
    cause: z.enum(['distill', 'clone', 'human']),
    summary: z.string(),
  }),
  z.object({
    type: z.literal('daily_report'),
    id: z.string(),
    at: isoDateTime,
    date: z.string(),
    body: z.string(),
  }),
]);

export type JournalEntry = z.infer<typeof journalEntrySchema>;
export type JournalEntryType = JournalEntry['type'];
/** 追記時に id / at はストアが埋める。 */
export type JournalEntryInput = DistributiveOmit<JournalEntry, 'id' | 'at'>;

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

// ---------------------------------------------------------------------------
// ジョブ・承認待ち
// ---------------------------------------------------------------------------

/**
 * ジョブの状態。
 *
 * - `running`: マネージャーが手を動かしている
 * - `waiting_human`: 上（クローン、必要なら人間）の返事待ちで、**その仕事だけ**が止まっている
 * - `done`: 直近の依頼を終えて待機中。セッションは生きているので追加指示を送れる
 * - `failed`: セッションが落ちた
 *
 * 「終わったら片付ける」ためのものではない。人間が Claude Code の窓を開いたまま
 * にしておくのと同じで、`done` は死ではなく待機である。
 */
export const jobStatusSchema = z.enum(['running', 'waiting_human', 'done', 'failed']);

export type JobStatus = z.infer<typeof jobStatusSchema>;

export const jobSchema = z.object({
  id: z.string(),
  createdAt: isoDateTime,
  updatedAt: isoDateTime,
  status: jobStatusSchema,
  /** マネージャーの識別子。ジョブ1件 = マネージャー1本なので id と同じ値が入る。 */
  managerId: z.string().optional(),
  /** SDK のセッション id。M4 の resume の足がかり。 */
  sessionId: z.string().optional(),
  summary: z.string(),
  /** クローンが出した依頼の全文。 */
  request: z.string().optional(),
  /** マネージャーの作業ディレクトリ（人間が Claude Code を開く場所と同じ）。 */
  cwd: z.string().optional(),
  /** 走行中セッションのトランスクリプト。可観測性の最下段への入口。 */
  transcriptPath: z.string().optional(),
  /** 退避済みトランスクリプト（TranscriptArchive の id）。 */
  archiveIds: z.array(z.string()).optional(),
  /** 直近の報告。一覧でクローンが状況を掴むためのもの。 */
  lastReport: z.string().optional(),
});

export type Job = z.infer<typeof jobSchema>;

/** ask_human の承認待ちキュー（PRD「権限境界」）。 */
export const pendingApprovalSchema = z.object({
  id: z.string(),
  createdAt: isoDateTime,
  question: z.string(),
  context: z.string().optional(),
  jobId: z.string().optional(),
  answeredAt: isoDateTime.optional(),
  answer: z.string().optional(),
});

export type PendingApproval = z.infer<typeof pendingApprovalSchema>;

// ---------------------------------------------------------------------------
// chat ストリーム（daemon → CLI）
// ---------------------------------------------------------------------------

/**
 * SSE で流す chat のイベント。CLI はこれだけを見て表示する
 * （CLI は core を埋め込まない — architecture.md「脳は1インスタンス」）。
 */
export const chatStreamEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({ type: z.literal('thinking') }),
  z.object({ type: z.literal('tool'), tool: z.string() }),
  z.object({ type: z.literal('ask_human'), approvalId: z.string(), question: z.string() }),
  z.object({ type: z.literal('done') }),
  z.object({ type: z.literal('error'), message: z.string() }),
]);

export type ChatStreamEvent = z.infer<typeof chatStreamEventSchema>;
