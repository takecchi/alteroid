import { z } from 'zod';

import { CRON_EXPRESSION_MAX, isCronExpression } from './cron.js';

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
    /** 何の定期ジョブか */
    kind: z.string(),
    /**
     * その発火が何を対象にしているか（日報なら対象日 `YYYY-MM-DD`）。
     *
     * **発火時刻から逆算させないこと。** デーモンが止まっていた日の日報を後から
     * 作るとき、発火時刻はその日ではない。対象は起こした側が決めて運ぶ。
     */
    target: z.string().optional(),
  }),
  z.object({
    type: z.literal('external'),
    id: z.string(),
    at: isoDateTime,
    source: z.string(),
    /** 中身のない通知（source だけが届く）もあるので省略できる。 */
    payload: z.unknown().optional(),
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
  z.object({
    type: z.literal('external_event'),
    id: z.string(),
    at: isoDateTime,
    /** どこから届いたか（webhook の呼び出し元が名乗る名前）。 */
    source: z.string(),
    /**
     * 届いた中身。長いものは切って入る。
     *
     * 要約ではなく中身を落とすのは、日誌が「何かあったときに掘る」層だからである
     * （PRD「可観測性」）。何が届いたのか分からない記録は掘る役に立たない。
     */
    summary: z.string(),
  }),
]);

export type JournalEntry = z.infer<typeof journalEntrySchema>;
export type JournalEntryType = JournalEntry['type'];
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
  z.object({ type: z.literal('every'), minutes: z.number().int().min(1) }),
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
      .refine(isCronExpression, 'cron 式として読めない（例: 毎週月曜 10:00 なら `0 10 * * 1`）'),
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
   * 前回この依頼で動いた時刻。
   *
   * 「前にいつ見たか」が分からないと、同じ仕事を毎回まっさらから起こすことになる
   * （＝同じ issue に何本もマネージャーが立つ）。重複を数の上限で止めるのは
   * 禁止2に触るので、材料として渡して判断に使わせる。
   */
  lastRunAt: isoDateTime.optional(),
});

export type ScheduleKind = z.infer<typeof scheduleKindSchema>;
export type ScheduleSpec = z.infer<typeof scheduleSpecSchema>;
export type ScheduledRequest = z.infer<typeof scheduledRequestSchema>;

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

/**
 * workspace の所在（M4 で置く継ぎ目）。
 *
 * 文字列のパスだけにしないのは、**runner が増えたときに移送の話になる**からである
 * （M5）。いまは `runner-volume` しか使わないが、共有 FS や git からの再構築へ
 * 伸ばせる形で JobStore に残しておく。ここが欠けると、runner が落ちたときに
 * 「どこで何を触っていたのか」が復元できない。
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
  /** git から作り直す（M5 の選択肢。未コミット差分は別途退避が要る）。 */
  z.object({
    kind: z.literal('git'),
    repository: z.string(),
    ref: z.string(),
    patchId: z.string().optional(),
  }),
]);

export type WorkspaceLocator = z.infer<typeof workspaceLocatorSchema>;

export const jobSchema = z.object({
  id: z.string(),
  createdAt: isoDateTime,
  updatedAt: isoDateTime,
  status: jobStatusSchema,
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
  /** マネージャーの作業ディレクトリ（人間が Claude Code を開く場所と同じ）。 */
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
});

export type Job = z.infer<typeof jobSchema>;

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
