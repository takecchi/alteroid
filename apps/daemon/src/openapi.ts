import {
  createMemoryStores,
  jobStatusSchema,
  journalEntrySchema,
  memoryDocumentMetaSchema,
  memoryDocumentSchema,
  pendingApprovalSchema,
  runnerCapacitySchema,
  runnerCredentialFingerprintSchema,
  runnerLeaseSchema,
  workspaceLocatorSchema,
  type CloneHost,
  type JournalEntry,
  type ManagerPool,
} from '@alteroid/core';
import type { GenerateSpecOptions } from 'hono-openapi';
import { z } from 'zod';

import { createApp } from './app.js';

/**
 * `GET /openapi.json` `GET /docs` が読む応答スキーマと documentation。
 *
 * `app.ts` を可読に保つため、ここへ分離してある（app.ts が全経路の
 * `describeRoute` で埋まると、肝心の配線が読めなくなる）。
 *
 * **core が既に zod スキーマを持っているもの（記憶・日誌・承認待ち・
 * chat イベントなど）はここで再定義しない。** 再定義すると実装のスキーマと
 * ドキュメントのスキーマが2つに分かれ、いつか必ずずれる（spec が嘘になる）。
 * core に無いもの（health の応答・会話一覧・マネージャー要約など）だけを
 * ここで新たに zod で書く。
 */

// ---------------------------------------------------------------------------
// 汎用のエラー形
// ---------------------------------------------------------------------------

/** ハンドラが手で返す `{ error: '...' }`（404 / 400 / 409 / 415 / 503）。 */
export const errorResponseSchema = z.object({ error: z.string() });

/**
 * `validator('json' | 'query', ...)` が検査に落ちたときの応答（hono-openapi の
 * 既定フック）。`@hono/zod-validator` の 400 とは形が違う（`error` が issue の
 * 配列で入る）ので、手書きの `errorResponseSchema` とは別に持つ。
 */
export const validationErrorResponseSchema = z.object({
  data: z.unknown(),
  error: z.array(z.unknown()),
  success: z.literal(false),
});

/** 検査落ちと業務エラーの両方が同じ 400 に乗る経路のための合わせ技。 */
export const badRequestResponseSchema = z.union([
  validationErrorResponseSchema,
  errorResponseSchema,
]);

// ---------------------------------------------------------------------------
// /health
// ---------------------------------------------------------------------------

export const healthResponseSchema = z.object({
  ok: z.literal(true),
  pid: z.number().int(),
  /** 本人確認用トークン（CLI が PID を信用しないため）。 */
  token: z.string(),
  /** 記憶の置き場（ローカルのパス / PostgreSQL）。接続情報は含めない。 */
  storage: z.string(),
});

// ---------------------------------------------------------------------------
// 会話（/conversations）
// ---------------------------------------------------------------------------

const conversationSchema = z.object({
  conversationId: z.string(),
  startedAt: z.string(),
  updatedAt: z.string(),
  messages: z.number().int(),
  /** 一覧に出す短い抜粋。全文は `GET /conversations/:id` にある。 */
  preview: z.string(),
});

export const conversationsResponseSchema = z.object({
  conversations: z.array(conversationSchema),
  /** 遡った範囲。ここより古い会話は出てこない（`scan` を増やせば見える）。 */
  scanned: z.number().int(),
});

const conversationMessageSchema = z.object({
  id: z.string(),
  at: z.string(),
  /** `inbound` = 人間の発言 / `outbound` = クローンの返答。 */
  role: z.enum(['inbound', 'outbound']),
  text: z.string(),
});

export const conversationDetailResponseSchema = z.object({
  conversationId: z.string(),
  messages: z.array(conversationMessageSchema),
});

// ---------------------------------------------------------------------------
// 記憶（/memory）— core の memoryDocument(Meta)Schema をそのまま使う
// ---------------------------------------------------------------------------

export const memoryListResponseSchema = z.object({ documents: z.array(memoryDocumentMetaSchema) });
export const memoryReadResponseSchema = z.object({ document: memoryDocumentSchema });
export const memoryDeleteResponseSchema = z.object({ ok: z.literal(true), slug: z.string() });

// ---------------------------------------------------------------------------
// 日誌（/journal, /journal/stream）— core の journalEntrySchema をそのまま使う
// ---------------------------------------------------------------------------

export const journalListResponseSchema = z.object({ entries: z.array(journalEntrySchema) });

/**
 * `journalEntrySchema` は discriminatedUnion。`/reports` が実際に返すのは
 * `daily_report` の枝だけなので、**再定義せず union から取り出す** — 手で
 * 書き直すと、schema.ts 側に日報の項目が増えたときにここだけ古いままになる。
 */
function journalVariant(type: JournalEntry['type']) {
  const found = journalEntrySchema.options.find((option) => option.shape.type.value === type);
  if (found === undefined) {
    throw new Error(`journal エントリ種別 "${type}" が見つからない（schema.ts の変更を確認）`);
  }
  return found;
}

const dailyReportEntrySchema = journalVariant('daily_report');

export const reportsResponseSchema = z.object({ reports: z.array(dailyReportEntrySchema) });

// ---------------------------------------------------------------------------
// 承認待ち（/approvals）— core の pendingApprovalSchema をそのまま使う
// ---------------------------------------------------------------------------

export const approvalsResponseSchema = z.object({ approvals: z.array(pendingApprovalSchema) });

export const approvalsAnswerResponseSchema = z.object({
  results: z.array(z.object({ id: z.string(), ok: z.boolean(), error: z.string().optional() })),
});

export const okResponseSchema = z.object({ ok: z.literal(true) });

// ---------------------------------------------------------------------------
// 外部イベントの入口（/events）
// ---------------------------------------------------------------------------

export const eventAcceptedResponseSchema = z.object({ ok: z.literal(true), id: z.string() });

// ---------------------------------------------------------------------------
// 時間起点のジョブ（/schedule）
// ---------------------------------------------------------------------------

export const scheduleStatusSchema = z.object({
  kind: z.string(),
  description: z.string(),
  /** 次の発火時刻（ISO 8601）。 */
  nextAt: z.string(),
});

export const scheduleListResponseSchema = z.object({ entries: z.array(scheduleStatusSchema) });

// ---------------------------------------------------------------------------
// マネージャー（/managers）
// ---------------------------------------------------------------------------

const managerWaitingSchema = z.object({ requestId: z.string(), summary: z.string() });

/**
 * `ManagerSummary`（`packages/core/src/manager.ts`）は zod スキーマを持たない
 * プレーンな TS interface なので、ここでだけ zod として書く。
 */
export const managerSummarySchema = z.object({
  managerId: z.string(),
  status: jobStatusSchema,
  /** このデーモンから話しかけられるか（宛先を失った分だけ `false`）。 */
  live: z.boolean(),
  cwd: z.string(),
  request: z.string(),
  startedAt: z.string(),
  updatedAt: z.string(),
  sessionId: z.string().optional(),
  lastReport: z.string().optional(),
  runnerId: z.string().optional(),
  workspace: workspaceLocatorSchema.optional(),
  waiting: z.array(managerWaitingSchema),
});

export const managersListResponseSchema = z.object({
  managers: z.array(managerSummarySchema),
});

export const managerDetailResponseSchema = z.object({ manager: managerSummarySchema });

/**
 * 移送の結果（M5）。**移せなかったことを黙らない**ので、`moved` が null でも
 * 何が起きたかが `detail` に入る。
 */
export const managerMoveResponseSchema = z.object({
  /** 実際に別の器で開き直せた分。移せなければ null。 */
  moved: managerSummarySchema.nullable(),
  detail: z.string(),
});

export const managerActionResponseSchema = z.object({
  /** `answered` = 止まっていた確認を解いた / `delivered` = 追加指示として届けた / `stopped` = 止めた。 */
  outcome: z.enum(['answered', 'delivered', 'stopped']),
  detail: z.string(),
});

// ---------------------------------------------------------------------------
// runner の名簿と鍵（/runners）— core の runnerCredentialFingerprintSchema を使う
// ---------------------------------------------------------------------------

/** 直近の生存判定（`RunnerHealthState`。core は TS interface なのでここで zod にする）。 */
const runnerIncarnationSchema = z.object({
  incarnation: z.string(),
  lastSeenAt: z.string(),
  lease: runnerLeaseSchema.optional(),
});

const runnerSummarySchema = z.object({
  runnerId: z.string(),
  workspacePath: z.string(),
  /** 名乗りが返っている（か、まだ一度も聞いていない）。 */
  alive: z.boolean(),
  /** 最後に名乗りが返った時刻。一度も返っていなければ null。 */
  lastSeenAt: z.string().nullable(),
  /** 連続で届かなかった回数。 */
  misses: z.number().int().nonnegative(),
  /**
   * 最後に測れた資源。**実測であって定員ではない**（roadmap M5 の地雷）。
   * 「あと何本置けるか」ではないので、委譲を断る根拠に使わないこと。
   */
  capacity: runnerCapacitySchema.optional(),
  /** その器が自分に課している貸し出し期限（報告しない器では省かれる）。 */
  lease: runnerLeaseSchema.optional(),
  /** いま名乗っている器の起動（`runnerId` は作り直しても同じ名前で戻る）。 */
  incarnation: z.string().optional(),
  /** この宛先で見た起動の履歴（新しい順）。 */
  incarnations: z.array(runnerIncarnationSchema).optional(),
  /** 最後の失敗の理由（人間が読む用）。 */
  lastError: z.string().optional(),
  /** 配られている鍵の指紋。**値は返らない。** */
  credentials: z.array(runnerCredentialFingerprintSchema),
});

export const runnersListResponseSchema = z.object({ runners: z.array(runnerSummarySchema) });

export const runnersCredentialsResponseSchema = z.object({
  results: z.array(
    z.object({
      runnerId: z.string(),
      ok: z.boolean(),
      credentials: z.array(runnerCredentialFingerprintSchema).optional(),
      error: z.string().optional(),
    }),
  ),
});

// ---------------------------------------------------------------------------
// アーカイブ（/archive）
// ---------------------------------------------------------------------------

export const archiveListResponseSchema = z.object({ entries: z.array(z.string()) });

// ---------------------------------------------------------------------------
// documentation（`GET /openapi.json` の骨格）
// ---------------------------------------------------------------------------

/**
 * `openAPIRouteHandler(app, { documentation, exclude })` にそのまま渡す。
 *
 * `exclude` で `/openapi.json` `/docs` 自身を spec から外す。実際には
 * `describeRoute` を付けていない経路はそもそも spec に載らない（hono-openapi の
 * 既定動作）ので二重の安全策だが、Issue の指示（「excludePaths などで除外」）
 * どおり明示しておく。
 */
export const openApiExcludePaths = ['/openapi.json', '/docs'];

export const openApiDocumentation: GenerateSpecOptions['documentation'] = {
  openapi: '3.1.0',
  info: {
    title: 'alteroid daemon API',
    // API 自体の版。apps/daemon/package.json の version（0.0.0 のプレースホルダ、
    // 非公開パッケージなので固定していない）とは別に持つ。
    version: '0.1.0',
    description:
      'alteroidd（常駐デーモン）の HTTP API。クローンとの対話・記憶・日誌・日報・' +
      '承認待ち・委譲先マネージャーの操作までを持つ。**runner の制御面（SDK の ' +
      'start/send/stop など）は含まない** — そこはマネージャーが自分宛の許可確認に ' +
      '自分で答えられてしまう境界であり、外へ出す面ではない（docs/architecture.md ' +
      '「制御面の保護」）。',
  },
  servers: [
    {
      url: 'http://127.0.0.1:4517',
      description:
        '既定の待ち受け。ポートは ALTEROID_PORT で変わる（既定 4517）。既定では ' +
        '127.0.0.1 以外には開いていない（ALTEROID_BIND で変更可）。',
    },
  ],
  tags: [
    { name: 'system', description: '死活監視・停止など、デーモン自体の管理' },
    { name: 'chat', description: '人間とクローンの対話（SSE）と会話終了（蒸留の契機）' },
    {
      name: 'conversations',
      description: '会話の履歴。日誌から組み立てる（新しい状態は持たない）',
    },
    {
      name: 'memory',
      description: '記憶（PersonaStore）。人間が読んでいつでも直せる Markdown 文書群',
    },
    { name: 'journal', description: '日誌（追記専用の記録）。可観測性の中段' },
    { name: 'reports', description: '日報。可観測性の最上段（人間の普段の接点はほぼこれだけ）' },
    { name: 'approvals', description: '承認待ちキュー（`ask_human` の応答口）' },
    { name: 'events', description: '外部イベントの入口（仕事の起点③）' },
    { name: 'schedule', description: '時間起点のジョブ（起点②④）の一覧と手動起動' },
    { name: 'managers', description: '委譲先マネージャーの一覧・状態・生ログ・直接の指示/停止' },
    { name: 'runners', description: '委譲先 runner の名簿と、そこへ配る鍵の指紋' },
    { name: 'archive', description: 'セッション生ログ（可観測性の最下段）' },
  ],
  components: {
    // 認証はまだ無い（PRD にも未着手）。導入したらここに securityScheme を足す
    // （例: Bearer トークンなら `{ bearerAuth: { type: 'http', scheme: 'bearer' } }`
    // とし、各 `describeRoute` に `security: [{ bearerAuth: [] }]` を添える）。
    securitySchemes: {},
  },
};

// ---------------------------------------------------------------------------
// ビルド時の spec 生成
// ---------------------------------------------------------------------------

/**
 * `createApp` を実際には走らせず、経路定義（`describeRoute` / `validator` が
 * 積んだメタデータ）だけから spec を組み立てる。
 *
 * **なぜスタブの deps でよいのか。** `GET /openapi.json` のハンドラ
 * （`openAPIRouteHandler`）は各ハンドラを実行しない — hono のルーティング表を
 * 読んで、`describeRoute`/`validator` が付けたメタデータを集めるだけである。
 * だから `clone` や `stores` が実際に何かをする必要は無く、`createMemoryStores()`
 * （fs/pg ドライバ不要のインメモリ実装）と、呼ばれたら即 throw する `CloneHost`
 * で十分に足りる。呼ばれてしまったらそれ自体がバグ（spec 生成のはずがハンドラを
 * 実行した）なので、黙って何もしないダミーではなく throw にしてある。
 */
export async function buildOpenApiDocument(): Promise<unknown> {
  const stubManagers: ManagerPool = {
    start() {
      throw new Error('spec 生成専用のスタブ: マネージャーは起こさない');
    },
    send() {
      throw new Error('spec 生成専用のスタブ: マネージャーには送らない');
    },
    abort() {
      throw new Error('spec 生成専用のスタブ: マネージャーは止めない');
    },
    list() {
      throw new Error('spec 生成専用のスタブ: マネージャー一覧は持たない');
    },
    transcript() {
      throw new Error('spec 生成専用のスタブ: 生ログは持たない');
    },
    restore() {
      throw new Error('spec 生成専用のスタブ: 引き継ぎはしない');
    },
    stop() {
      throw new Error('spec 生成専用のスタブ');
    },
  };

  const stubClone: CloneHost = {
    managers: stubManagers,
    post() {
      throw new Error('spec 生成専用のスタブ: 受信箱には積まない');
    },
    subscribe() {
      throw new Error('spec 生成専用のスタブ: 購読は無い');
    },
    endConversation() {
      throw new Error('spec 生成専用のスタブ');
    },
    answerApproval() {
      throw new Error('spec 生成専用のスタブ');
    },
    stop() {
      throw new Error('spec 生成専用のスタブ');
    },
  };

  const app = createApp({
    clone: stubClone,
    stores: createMemoryStores(),
    token: 'spec-generation',
    shutdown: () => undefined,
  });

  const response = await app.request('/openapi.json');
  return response.json();
}
