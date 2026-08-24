import { randomUUID } from 'node:crypto';

import type {
  AccountUsageState,
  ChatStreamEvent,
  CloneHost,
  JournalEntry,
  JournalEntryType,
  ManagerPool,
  ManagerSummary,
  ProfileService,
  RunnerClient,
  RunnerRegistry,
  Scheduler,
  Stores,
  TokenPoolService,
} from '@alteroid/core';
import {
  RESERVED_SCHEDULE_KINDS,
  DEFAULT_SSE_HEARTBEAT_MS,
  DEFAULT_TOKEN_ROTATION_SETTINGS,
  TokenPoolInputError,
  approvalUpdatedAt,
  chatStreamEventSchema,
  collectConversations,
  commitmentUpdatedAt,
  conversationMessages,
  createAuthProviderRegistry,
  createAuthService,
  reachedStart,
  isAccountGranted,
  isDailyReport,
  journalEntrySchema,
  localDayRange,
  memorySlugSchema,
  fingerprintOf,
  noteDroppedRecord,
  reasonOf,
  reportRunnerRevision,
  resolveBuildRevision,
  runnerSetCredentialsCommandSchema,
  accountUsageStateSchema,
  scheduleKindSchema,
  scheduleSpecSchema,
  startSseHeartbeat,
  summarizeUsage,
  tokenRotationSettingsSchema,
  usageAggregateSchema,
  usageBreakdownSchema,
  usageDateSchema,
  usageLayerSchema,
  usageSiteSchema,
  type AuthAccount,
  type AuthService,
} from '@alteroid/core';

import { bearerOf, isOperator, type AuthPlan, type AuthVariables } from './auth.js';
import type { JournalBus } from './journal-bus.js';
import { Scalar } from '@scalar/hono-api-reference';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { createMiddleware } from 'hono/factory';
import { streamSSE } from 'hono/streaming';
import { describeRoute, openAPIRouteHandler, resolver, validator } from 'hono-openapi';
import { z } from 'zod';

import {
  accessAccountResponseSchema,
  accessListResponseSchema,
  approvalsAnswerResponseSchema,
  approvalsResponseSchema,
  archiveListResponseSchema,
  authProvidersResponseSchema,
  badRequestResponseSchema,
  commitmentListResponseSchema,
  commitmentOpenedResponseSchema,
  conversationDetailResponseSchema,
  conversationsResponseSchema,
  errorResponseSchema,
  eventAcceptedResponseSchema,
  healthResponseSchema,
  journalListResponseSchema,
  loginClaimResponseSchema,
  loginStartResponseSchema,
  managerActionResponseSchema,
  managerDetailResponseSchema,
  managersListResponseSchema,
  memoryDeleteResponseSchema,
  memoryListResponseSchema,
  memoryReadResponseSchema,
  meResponseSchema,
  okResponseSchema,
  openApiDocumentation,
  openApiExcludePaths,
  profileErrorResponseSchema,
  profileResponseSchema,
  profileUpdateRequestSchema,
  profileUpdateResponseSchema,
  reportsResponseSchema,
  runnersCredentialsResponseSchema,
  runnersListResponseSchema,
  scheduleListResponseSchema,
  tokensPolicyUpdateRequestSchema,
  tokensResponseSchema,
  tokensUpdateRequestSchema,
  validationErrorResponseSchema,
} from './openapi.js';
import { compareDailyReportsNewestFirst, listDailyReports } from './reports.js';

/**
 * HTTP API（hono）。CLI も外部アプリもここを叩く。
 *
 * 入口は CLI・HTTP API・Web UI（apps/web）の3つで、**どれも等しくこの API の
 * 上に乗る**。CLI は core を埋め込まずこの API の薄いクライアントに徹する —
 * でないと chat のたびに脳が分岐する（docs/architecture.md「脳は1インスタンス」）。
 * Web UI も同じ理由で、独自の経路をここへ足さない（足したら入口ごとに
 * できることが変わる）。
 *
 * 可観測性の3層（日報・日誌・セッションログ）はすべてここから読める必要がある
 * （PRD「可観測性」）。M3 で最上段の日報が揃い、3層が全部この API から読める。
 *
 * ここには**外部イベントの入口**もある（`POST /events`）。仕事の起点を人間に
 * 限らないための口であり、開いている先は 127.0.0.1 だけである。外から叩かせるなら、
 * 手前に境界（リバースプロキシ・トンネル・認証）を置くのが正しい — 能力側で
 * 絞るのではなく実行環境の境界で守る（north_star 禁止2）。
 *
 * **仕様は `GET /openapi.json`（OpenAPI 3.1）で外から読める。** 人間向けの画面は
 * `GET /docs`（Scalar）。経路の入出力は zod スキーマ（`hono-openapi` の
 * `describeRoute` / `validator`）から機械生成する — 手書きの spec を別に持つと、
 * 経路を直したのに spec だけ古いままという事故が起きる（Issue #20 の設計上の注意）。
 * 応答スキーマは `./openapi.ts` にまとめてある（ここに全部書くと配線が読めなくなる）。
 */
export interface AppDeps {
  clone: CloneHost;
  stores: Stores;
  /**
   * 起動ごとの本人確認用トークン。CLI は PID ではなくこれで
   * 「いま応答しているのが自分が起こしたデーモンか」を確かめる。
   */
  token: string;
  /** `daemon stop` の受け口。 */
  shutdown: () => void;
  /** 時間起点のジョブ。テストの HTTP 層検証では省略できる。 */
  scheduler?: Scheduler;
  /**
   * 記憶がどこにあるか（ローカルのパス / PostgreSQL）。
   * CLI がこれを見せるので、人間が器を取り違えない。接続情報は含めない。
   */
  storage?: string;
  /**
   * 委譲先の名簿。**マネージャーの道具の鍵を、器を作り直さずに回すための口**が
   * ここから生える（`GET /runners` / `POST /runners/credentials`）。
   *
   * デーモンが鍵を保管するのではない。降ろすだけである — 保管すると、記憶の器に
   * GitHub の書き込み権が並ぶ（railway/README.md「daemon 側には置かない」）。
   */
  runners?: RunnerRegistry;
  /**
   * 日誌の追記を購読する口（`GET /journal/stream`）。
   *
   * 無ければその経路だけが 503 を返す。**能力を落とすのではなく、配線されて
   * いないことを黙って隠さない**ため（テストの HTTP 層検証では省略できる）。
   */
  journalEvents?: Pick<JournalBus, 'subscribe'>;
  /**
   * アカウント全体の利用状況（claude.ai 側の値）を読む口。
   *
   * 無ければ `GET /usage` の `account` が `{ state: 'unknown' }` を返す。
   * **能力を落とすのではなく、配線されていないことを黙って隠さない**ため
   * （0 を返すと「枠を使っていない」と読める）。
   */
  accountUsage?: () => AccountUsageState;
  /**
   * ブラウザから叩いてよいオリジンの**明示列挙**（`ALTEROID_ALLOWED_ORIGINS`）。
   *
   * 空（既定）なら CORS ヘッダを一切返さない。**そこが今までの姿勢であり、
   * 既定では1バイトも変わらない。**
   *
   * 画面（apps/web）とデーモンを別オリジンに置く配置があるので必要になった。
   * ここで守っているものは3つある。
   *
   * 1. **ワイルドカードを受け付けない。** 列挙されたオリジンだけを、そのまま
   *    エコーする。`*` を許すと `deliberateClient` の前提（preflight が通らない）
   *    が消え、人間が開いた任意のページからクローンのターンを起こせる
   * 2. **`credentials` を付けない。** Cookie を運ばせない設計なので、
   *    `Access-Control-Allow-Credentials` は返さない（資格情報はヘッダで運ぶ）
   * 3. **`allowHeaders` は最小。** `content-type` を通すのは `deliberateClient` が
   *    それを要求するためで、増やすなら理由が要る
   *
   * これは能力の削除ではなく**実行環境の境界の設定**である（north_star 禁止2）。
   * 開けるかどうかは人間が決め、開けた先は列挙した相手だけに限られる。
   */
  allowedOrigins?: readonly string[];
  /**
   * ログインとアクセス許可（`./auth.ts`）。
   *
   * 省略すると認証を要求しない（＝この機能が入る前と同じ振る舞い）。**能力を
   * 削らないための既定**であって、設定していない人の `alteroid chat` が突然
   * 通らなくなる方が北極星に反する（境界の導入が実質のデグレードになっていないか、
   * という問い）。
   */
  auth?: { plan: AuthPlan; service?: AuthService };
  /**
   * 実行環境プロファイルを置いて配るまでの1本道。
   *
   * **クローンの道具（`profile_write`）と同じインスタンスを渡すこと。** 別々だと
   * 直列化の意味が消え、同時更新で層ごとに違う本文が残る。
   */
  profile?: ProfileService;
  /**
   * 認証トークンのプール（Issue #393「PR1 プールの器」）。**回さない**——ここが
   * 生やすのは器の読み書きの口だけで、検知・切替は無い。
   *
   * **人間の口（`PUT /tokens`）とクローンの道具（後続の PR）は同じインスタンスを
   * 渡すこと。** `profile` と同じ理由——別々だと直列化の意味が消える。
   */
  tokens?: TokenPoolService;
  /**
   * SSE のコメント行 heartbeat の間隔（ms）。省略時は `DEFAULT_SSE_HEARTBEAT_MS`
   * （`@alteroid/core` の `sse-heartbeat.ts`）。**環境変数は増やさない** —— テストで短くする以外に
   * 差し替える理由が無い設定なので、実行環境プロファイルの対象にもしない。
   */
  sseHeartbeatMs?: number;
}

/**
 * `ALTEROID_ALLOWED_ORIGINS` を読む。
 *
 * 受け付けるのは `scheme://host[:port]` だけである。**`*` と、経路を含む値と、
 * 解釈できない値は捨てる**（捨てたことは呼び出し側が警告に出す）。ここを緩めると
 * 「許可したつもりの範囲」と「実際に通る範囲」がずれ、境界が境界でなくなる。
 */
export function parseAllowedOrigins(raw: string | undefined): {
  origins: string[];
  rejected: string[];
} {
  const origins: string[] = [];
  const rejected: string[] = [];

  for (const entry of (raw ?? '').split(',')) {
    const candidate = entry.trim();
    if (candidate === '') continue;

    let url: URL;
    try {
      url = new URL(candidate);
    } catch {
      rejected.push(candidate);
      continue;
    }

    // `new URL('https://a.example.com/path').origin` は経路を落とすので、
    // 元の文字列がオリジンそのものだったときだけ通す（打ち間違いを飲み込まない）。
    const normalized = url.origin;
    if (normalized === 'null' || candidate.replace(/\/+$/, '') !== normalized) {
      rejected.push(candidate);
      continue;
    }
    if (!origins.includes(normalized)) origins.push(normalized);
  }

  return { origins, rejected };
}

const chatBody = z.object({
  text: z.string().min(1),
  conversationId: z.string().min(1).optional(),
});

const memoryBody = z.object({ content: z.string() });
const answerBody = z.object({ answer: z.string().min(1) });
/** まとめて答える（溜まった保留を人間が一度に片付けるための口）。 */
const answersBody = z.object({
  answers: z
    .array(z.object({ id: z.string().min(1), answer: z.string().min(1) }))
    .min(1)
    .max(200),
});
const eventBody = z.object({
  /** 何から届いたか。クローンが判断の手がかりにする。 */
  source: z.string().min(1),
  payload: z.unknown().optional(),
});
const reportsQuery = z.object({ limit: z.coerce.number().int().min(1).max(365).default(7) });
const journalQuery = z.object({
  limit: z.coerce.number().int().min(1).max(1000).default(50),
  /** ISO 8601。ここより古いエントリまで遡って読むための足がかり。 */
  since: z.string().optional(),
  /**
   * ISO 8601。窓の終端。
   *
   * **`since` だけでは過去の一区間を取れない。** 新しい順に返すので、手前に
   * 積まれた最新のものが `limit` を食い尽くし、狙った時刻には届かない。
   */
  until: z.string().optional(),
  /** カンマ区切りの日誌エントリ種別。 */
  type: z.string().optional(),
});
const approvalsQuery = z.object({ pending: z.enum(['true', 'false']).default('true') });
/**
 * 会話は日誌から組み立てる。`scan` はどこまで遡るかで、`limit` は返す本数。
 * **黙って打ち切らない** — 応答に `scanned` を返して、遡り切れていないことが
 * 呼ぶ側に見えるようにしてある。
 */
const conversationsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(20),
  scan: z.coerce.number().int().min(1).max(10000).default(2000),
});
const conversationQuery = z.object({
  scan: z.coerce.number().int().min(1).max(10000).default(2000),
});
/**
 * 利用状況の照会。
 *
 * **既定で期間を絞らない。** 絞ると「今日いくら使ったか」を聞いたつもりの人へ
 * 全期間の合計を返す、という取り違えが起きやすい。呼ぶ側が `from` / `to` を
 * 明示する形にして、返り値の `byDate` で日別が読めるようにしてある。
 */
const usageQuery = z.object({
  from: usageDateSchema.optional(),
  to: usageDateSchema.optional(),
  managerId: z.string().min(1).optional(),
  /**
   * **誰が**（層）・**どこで**（場所）で絞る。
   *
   * **4つの口（API / CLI / Web / クローンの道具）へ同時に置くこと。** 片方にだけ
   * 足すと、そこにしかできない分析が生まれる（PRD「インターフェース」）。
   */
  layer: usageLayerSchema.optional(),
  site: usageSiteSchema.optional(),
});
const usageResponseSchema = usageAggregateSchema.extend({
  breakdown: usageBreakdownSchema,
  /**
   * アカウント全体の残り（claude.ai 側が言っている値）。
   *
   * **台帳と足さない。** こちらは向こうが言っている値で、台帳は自分で数えた
   * 推定値である。`state` が `ok` 以外なら「取れなかった」であって「0」ではない。
   */
  account: accountUsageStateSchema,
});
const journalStreamQuery = z.object({
  /** カンマ区切りの種別。指定しなければ全部流れる。 */
  type: z.string().optional(),
});
const managerMessageBody = z.object({
  text: z.string().min(1),
  /** 許可確認への回答なら付ける。複数を待っているときは省略できない。 */
  requestId: z.string().min(1).optional(),
  decision: z.enum(['allow', 'deny']).optional(),
});
const abortBody = z.object({ reason: z.string().min(1).optional() });
/**
 * 継続中の依頼の仕込み（人間の手からも同じことができる口）。
 *
 * クローンの `schedule_create` と同じものを人間も置ける。自分が出した「これから
 * ずっと」の依頼を人間が見て直せないと、可観測性の穴になる（PRD「権限境界」の
 * 人間の制御手段④）。
 */
const scheduleBody = z.object({
  kind: scheduleKindSchema,
  request: z.string().min(1),
  spec: scheduleSpecSchema,
});

/**
 * 台帳へ1件積む（クローンの `commitment_open` と同じことを人間の手からも）。
 *
 * **人間が頼んだことは chat から自動で載るが、それだけでは片道になる。** 人間が
 * 後から思い出した宿題や、chat 以外の場（issue・口頭）で決まったことを台帳へ置く手が
 * 無いと、「クローンは自分で積めるのに人間は積めない」という差が残る。
 */
const commitmentBody = z.object({
  body: z.string().min(1),
  /** どこから来たか（会話 id・issue 番号など。分かるときだけ）。 */
  source: z.string().min(1).optional(),
});

/**
 * 閉じるときの理由。**空を許さない。**
 *
 * 「閉じた」だけを残すと、何をもって終わりとしたのかが残らない。人間が後から否定
 * できることが最終承認の実体である以上（north_star）、否定する材料の無い閉じ方を
 * 受け付けてはいけない（`commitmentSchema` の `closedReason` の注記）。
 */
const commitmentCloseBody = z.object({ reason: z.string().min(1) });

/**
 * 片付けたものも返すか。
 *
 * **`z.coerce.boolean()` を使わない。** あれは空でない文字列をすべて true にするので、
 * `?includeClosed=false` が true になる（＝既定は未了だけ、という約束が黙って壊れ、
 * 一覧が片付いたもので埋まる）。`/approvals` の `pending` と同じ形に揃えてある。
 */
const commitmentsQuery = z.object({ includeClosed: z.enum(['true', 'false']).default('false') });

const loginBody = z.object({
  provider: z.string().min(1),
  /** どの端末から始めたか、人間が後から見分けるための覚書。 */
  label: z.string().max(200).optional(),
});
const claimBody = z.object({ claimSecret: z.string().min(1) });

function loginErrorDetail(reason: string): string {
  switch (reason) {
    case 'invalid_state':
      return 'ログイン要求が見つかりません（やり直してください）。';
    case 'expired':
      return 'ログイン要求の期限が切れています（やり直してください）。';
    case 'already_used':
      return 'このログイン要求は既に使われています。';
    case 'unknown_provider':
      return '設定されていないログイン手段です。';
    default:
      return 'プロバイダとのトークン交換に失敗しました。';
  }
}

/** 日誌に残す人間向けの名前。 */
function describeAccount(account: AuthAccount): string {
  const name = account.email ?? account.displayName;
  return name === null || name === undefined ? account.id : `${name} (${account.id})`;
}

function claimErrorDetail(reason: string): string {
  switch (reason) {
    case 'invalid_secret':
      return 'claimSecret が違う';
    case 'expired':
      return 'ログイン要求の期限が切れている';
    case 'failed':
      return 'ログインに失敗している';
    default:
      return 'ログイン要求が見つからない（既に引き取り済みの可能性）';
  }
}

/**
 * 本文検査を持たない POST の門番。
 *
 * 待ち受けているのは 127.0.0.1 だけだが、**それはブラウザからの保護にならない。**
 * 人間が開いた任意のページから `fetch(..., { mode: 'no-cors' })` や HTML form で
 * ここへ POST できてしまい（CORS の単純リクエスト）、応答が読めなくても送信は成立する。
 * 見ていないクローンのターンを他人が起こせる状態は、観測の口ではなく実行の口である。
 *
 * `application/json` を要求すると preflight が必須になり、CORS ヘッダを返さない
 * このデーモンでは preflight が通らない。**ツールや能力を削るのではなく、
 * 実行環境の境界で塞ぐ**（north_star 禁止2）。
 *
 * `validator('json', ...)` を持つ経路は hono が同じ検査をするので、こちらは要らない。
 * **本文検査の無い POST を足すときは、必ずこれを付けること。**
 */
const deliberateClient = createMiddleware(async (c, next) => {
  if (mimeEssence(c.req.header('content-type')) !== 'application/json') {
    return c.json({ error: 'content-type: application/json が要る' as const }, 415);
  }
  await next();
});

/**
 * `Content-Type` の MIME essence（`;` より前）だけを取り出す。
 *
 * **部分一致で判定してはいけない。** ブラウザが単純リクエストか否かを決めるのは
 * essence だけなので、`text/plain; note=application/json` は safelist のまま
 * preflight 無しで飛ぶ。`includes('application/json')` はこれを通してしまい、
 * 門番があるつもりで穴が空く。
 */
function mimeEssence(contentType: string | undefined): string {
  return (contentType ?? '').split(';', 1)[0]?.trim().toLowerCase() ?? '';
}

// **`isDailyReport` は `@alteroid/core` の1本を使う**（ここに写しを持たない）。
// 日報の行には「書けなかった」の印（`unavailable`）が付くことがあり、**数える側と
// 出す側で扱いが違う** — 出す側（この経路）は印の行も出し、数える側
// （`clone.ts` / `schedule.ts`）は数えない。判定が3か所に散ると、その違いが
// どこか1か所で静かに逆になる。

/**
 * 本文検査が無い POST / DELETE（`deliberateClient` のみ）に共通の requestBody。
 *
 * **門番を足したら必ずこれも付けること。** 片方だけの経路があると「門番つきなら本文必須」が
 * 例外つきの規則になり、生成クライアントはその経路でだけ 415 に当たる。
 * `packages/api-client/src/client.test.ts` が7経路すべてを型の側で数え上げている。
 *
 * **サーバは本文を読まないが、`content-type: application/json` は要る。** それを
 * 415 の description（散文）だけで伝えると、spec から起こした他言語のクライアントは
 * ヘッダを付けずに叩いて 415 に当たる。機械可読な形で「application/json で来い」と
 * 言うためにここを置いてある。
 *
 * **`required: true` でなければ契約にならない。** OpenAPI では requestBody を省略
 * した呼び出しに、その media type の `content-type` を送る義務が無い。つまり
 * `required: false` だと生成クライアントは本文もヘッダも省略でき、直したはずの
 * 415 がそのまま残る（実際 `openapi-fetch` は「body が無ければ `Content-Type` を
 * 付けない」実装である）。だから**中身は縛らないまま `required: true`** にして、
 * 「送るものが無くても `{}` は置く」を型の側から強制する。
 *
 * **サーバの方が緩いのは意図的。** 本文は読まないので空でも `{}` でも通る。spec が
 * サーバより厳しい向きなら、spec から起こしたクライアントは必ず門番を素通りできる
 * （逆向きにすると、spec が許した呼び方がサーバに弾かれる）。
 *
 * **門番を緩める変更ではない。** `deliberateClient` は無改変で、これは spec 側が
 * 門番の存在を表現していなかったことへの追随である。
 *
 * 関数にしてある理由は `noBodyPostResponses` と同じ（モジュールの初期化順）。
 */
function noBodyPostRequestBody(description: string) {
  return {
    required: true,
    description,
    // 中身は縛らない（free-form）。ここで伝えたいのは形ではなく content-type である。
    content: { 'application/json': { schema: {} } },
  };
}

/**
 * 本文検査が無い POST（`deliberateClient` のみ）に共通の 415 応答。
 *
 * **関数にしてあるのは意図的。** `app.ts` と `openapi.ts` は互いを import する
 * （app.ts は応答スキーマを、openapi.ts は spec 生成のため `createApp` を読む）。
 * モジュールの初期化順によっては、片方のトップレベルで即座に評価する定数が
 * まだ空の相手の export を読んでしまう。`describeRoute(...)` は
 * `createApp` の呼び出し時（＝両モジュールの初期化が終わった後）まで実行を
 * 遅らせるので、ここも定数ではなく関数にして遅延させる。
 */
function noBodyPostResponses() {
  return {
    415: {
      description:
        'content-type が application/json ではない（ブラウザの単純リクエスト対策 — ' +
        '状態を変える POST は必ずここを通す）。',
      content: { 'application/json': { schema: resolver(errorResponseSchema) } },
    },
  } as const;
}

/**
 * 認証を要求しない経路。
 *
 * `/health` は CLI が「自分の起こしたデーモンか」を確かめる口で、ログインの前に
 * 必ず通る（応答に秘密は載っていない）。`/auth/*` はログインそのものの経路なので、
 * ここを閉じるとログインできない。`/openapi.json` と `/docs` は仕様の公開である。
 *
 * **`/auth/me` だけは例外で認証が要る。** 「いま自分が誰か」は認証済みでなければ
 * 答えようが無い。
 */
function isPublicPath(path: string): boolean {
  if (path === '/health' || path === '/openapi.json' || path === '/docs') return true;
  if (path === '/auth/me') return false;
  return path === '/auth' || path.startsWith('/auth/');
}

/**
 * 一覧・詳細で返すマネージャー（状態に、確認へ上がらず止められた件数を**添える**）。
 *
 * **2つの出どころを外向きの面でだけ合流させる。** 状態は台帳から作った
 * `ManagerSummary`、拒否はデーモンのプロセス内にしか無い像で、`denials()` という
 * 別の口から読む（`ManagerPool`）。core の interface へ混ぜないのは、台帳へ持ち
 * 越さない設計をそのまま保つためである（器を作り直せば数え直しになる）。
 *
 * **拒否が無いときはキーごと載せない。** 常に `[]` を載せると「0 件だった」と
 * 読めるが、デーモンから見えているのは「この器では数えていない」でもありうる。
 * `manager_list` が拒否ゼロの行に何も足さないのと同じ扱いにする。
 */
function managerView(managers: ManagerPool, summary: ManagerSummary) {
  const denials = managers.denials(summary.managerId);
  return denials.length === 0 ? summary : { ...summary, denials };
}

/** 一覧・詳細で返すアカウント（identity を畳んで、秘密は載せない）。 */
async function accountView(
  stores: Stores,
  account: AuthAccount,
): Promise<
  AuthAccount & {
    granted: boolean;
    identities: {
      provider: string;
      subject: string;
      email: string | null;
      emailVerified: boolean;
      lastLoginAt: string;
    }[];
  }
> {
  const identities = await stores.auth.listIdentities(account.id);
  return {
    ...account,
    granted: isAccountGranted(account),
    identities: identities.map(({ provider, subject, email, emailVerified, lastLoginAt }) => ({
      provider,
      subject,
      email,
      emailVerified,
      lastLoginAt,
    })),
  };
}

/** ブラウザに返す終了画面。**ここで alteroid を操作させない**（Web UI は非ゴール）。 */
function callbackPage(title: string, detail: string): string {
  const escape = (value: string) =>
    value.replace(/[&<>"]/g, (ch) =>
      ch === '&' ? '&amp;' : ch === '<' ? '&lt;' : ch === '>' ? '&gt;' : '&quot;',
    );
  return `<!doctype html>
<html lang="ja"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>alteroid</title>
<style>
 body{font-family:system-ui,-apple-system,"Hiragino Kaku Gothic ProN",sans-serif;
      display:grid;place-items:center;min-height:100vh;margin:0;color:#1a1a1a;background:#fafafa}
 main{max-width:32rem;padding:2rem;text-align:center}
 h1{font-size:1.25rem;margin:0 0 .75rem}
 p{margin:0;color:#555;line-height:1.7}
</style></head>
<body><main><h1>${escape(title)}</h1><p>${escape(detail)}</p></main></body></html>`;
}

/**
 * runner を1回叩いて、**叩けたかどうかごと**返す。
 *
 * **戻り値を1つの値に畳まない。** `credentials` / `profile` は「空」と
 * 「聞けなかった」が同じ形になりやすく、実際に `GET /runners` はそこを潰していた。
 * ここで `*Probe` を必ず一緒に組み立てるので、**片方だけ足して片方を忘れる**形に
 * ならない（呼ぶ側は展開するだけで、判断を省略できない）。
 *
 * **理由は `reasonOf` を通す。** 例外は失敗した呼び出しのパラメータを添えて
 * くることがあるので、素の `String(error)` を応答へ載せない
 * （`dropped-record.ts` の `reasonOf` の doc）。
 */
async function probe(
  runner: RunnerClient | undefined,
  kind: 'credentials' | 'profile',
): Promise<Record<string, unknown>> {
  const key = kind === 'credentials' ? 'credentialsProbe' : 'profileProbe';
  const empty = kind === 'credentials' ? { credentials: [] } : {};
  if (runner === undefined) return { ...empty, [key]: { status: 'unheard' } };
  try {
    if (kind === 'credentials') {
      return { credentials: await runner.credentials(), credentialsProbe: { status: 'asked' } };
    }
    const value = await runner.profile();
    return {
      ...(value === undefined ? {} : { profile: value }),
      profileProbe: { status: 'asked' },
    };
  } catch (error) {
    return { ...empty, [key]: { status: 'failed', error: reasonOf(error) } };
  }
}

export function createApp(deps: AppDeps) {
  const { clone, stores } = deps;
  const sseHeartbeatMs = deps.sseHeartbeatMs ?? DEFAULT_SSE_HEARTBEAT_MS;

  const authPlan: AuthPlan = deps.auth?.plan ?? {
    enabled: false,
    providers: [],
    publicBaseUrl: '',
    tokenTtlDays: 30,
    description: '認証は無効（未設定）',
  };
  const authService: AuthService =
    deps.auth?.service ??
    createAuthService({
      store: stores.auth,
      providers: createAuthProviderRegistry(authPlan.providers),
      tokenTtlDays: authPlan.tokenTtlDays,
    });
  const providerList = authPlan.providers.map(({ id, label, kind }) => ({ id, label, kind }));
  /**
   * プロバイダへ登録する戻り先。**1プロバイダにつき1本だけ**にしてある。
   * 用途ごとに URL を増やすと、token 交換時の `redirect_uri` 不一致が起きやすい。
   */
  const callbackUrl = (provider: string) => `${authPlan.publicBaseUrl}/auth/${provider}/callback`;

  /**
   * 入口の門番。
   *
   * **通す条件は2つだけである。** ①実行環境の持ち主（状態ファイルの token を
   * 提示できる）②許可されたアカウントのアクセストークン。行為ごとの許可表は
   * 持たない — 持った瞬間に PRD「権限境界」が言う「確認が要る行為の一覧」と
   * 同じ形になり、クローンの判断を設定で置き換えることになる。
   */
  const authenticate = createMiddleware<{ Variables: AuthVariables }>(async (c, next) => {
    if (isOperator(c, deps.token)) {
      c.set('principal', { kind: 'operator' });
      await next();
      return;
    }
    if (!authPlan.enabled) {
      // 認証を設定していない構成では、この機能が入る前とまったく同じに振る舞う。
      // 守りは待ち受け先（既定 127.0.0.1）と手前に置く境界の側にある。
      c.set('principal', { kind: 'operator' });
      await next();
      return;
    }
    if (isPublicPath(c.req.path)) {
      await next();
      return;
    }

    const bearer = bearerOf(c.req.header('authorization'));
    if (bearer === null) {
      return c.json({ error: 'ログインが要る（alteroid login）' as const }, 401);
    }
    const account = await authService.authenticate(bearer);
    if (account === null) {
      return c.json({ error: 'トークンが無効か期限切れ（alteroid login をやり直す）' }, 401);
    }
    if (!isAccountGranted(account)) {
      // ログインは通っているが使う許可が無い。**401 ではなく 403** で返す
      // （やり直しても解決しない。人間が alteroid access grant を実行する）。
      return c.json({ error: 'このアカウントには alteroid を使う許可が無い' }, 403);
    }
    c.set('principal', { kind: 'account', account });
    await next();
  });

  /** 許可の付与・剥奪は実行環境の持ち主だけ（最初の1人を誰が通すかの出口）。 */
  const requireOperator = createMiddleware<{ Variables: AuthVariables }>(async (c, next) => {
    if (c.get('principal').kind !== 'operator') {
      return c.json({ error: '実行環境の持ち主だけが操作できる' as const }, 403);
    }
    await next();
  });

  const base = new Hono<{ Variables: AuthVariables }>();

  // **CORS は認証より先に登録する。** ブラウザの preflight（OPTIONS）は
  // `Authorization` を積んで来ないので、門番が先に立つと preflight が 401 になり、
  // 本リクエストが一度も飛ばない。hono の `cors()` は OPTIONS にその場で答えて
  // `next()` を呼ばないので、ここに置けば門番も素通りしない。
  //
  // 列挙が空なら**何も登録しない** — CORS ヘッダを返さない今までの姿勢のまま。
  const allowedOrigins = deps.allowedOrigins ?? [];
  if (allowedOrigins.length > 0) {
    base.use(
      '*',
      cors({
        // 列挙にあるものだけをそのまま返す。`*` は返さない（`AppDeps` の注記）。
        origin: (origin) => (allowedOrigins.includes(origin) ? origin : null),
        allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
        // `content-type` は `deliberateClient` が、`authorization` は門番が要求する。
        // 後者を落とすと、別オリジンの画面はログイン済みでも何も呼べない。
        allowHeaders: ['content-type', 'authorization'],
        // Cookie は運ばせない。資格情報はヘッダで運ぶ（apps/web/app/lib/config.ts）。
        credentials: false,
        maxAge: 600,
      }),
    );
  }

  const app = base
    .use('*', authenticate)

    .get(
      '/health',
      describeRoute({
        tags: ['system'],
        summary: '死活監視と本人確認',
        description:
          'デーモンが応答しているかと、その pid・記憶の置き場・認証の状態を返す。' +
          '`Authorization: Bearer <state/daemon.json の token>` を添えると `operator` が ' +
          'true になり、CLI はこれで「自分が起こしたデーモンか」を確かめる（PID は信用しない）。' +
          '**トークンそのものは返さない** — この値は許可を付与できる資格そのものなので、' +
          '無認証で読める応答には置けない。',
        security: [],
        responses: {
          200: {
            description: '応答している。',
            content: { 'application/json': { schema: resolver(healthResponseSchema) } },
          },
        },
      }),
      (c) =>
        c.json({
          ok: true,
          pid: process.pid,
          operator: isOperator(c, deps.token),
          storage: deps.storage ?? '',
          auth: { enabled: authPlan.enabled, providers: providerList },
        }),
    )

    // --- chat（SSE） -------------------------------------------------------
    .post(
      '/chat',
      describeRoute({
        tags: ['chat'],
        summary: 'クローンと話す（SSE）',
        description:
          '人間の発言をクローンの受信箱へ積み、クローンの応答を SSE で流す。' +
          '**SSE。** `event:` にイベント名（`open` / `queued` / `text` / `thinking` / `tool` / ' +
          '`ask_human` / `done` / `error`）、`data:` に対応する JSON が入る。`data:` の ' +
          '形は下記スキーマ（`open` は `{conversationId}` のみで別枠、他は ' +
          '`chatStreamEventSchema` の各枝）。人間が chat を閉じてもクローンのターンは' +
          '走り続ける（人間の不在で止まるのは承認待ちの仕事だけ）。' +
          '**`queued` と `thinking` は別の状態である。** `queued` は受信箱に積んだ' +
          '（受理したが順番待ち。先客のターンが走っていれば、ここで数分待つことがある）、' +
          '`thinking` は入力がモデルへ渡って最初の出力を待っている。前者の後に後者が来る。' +
          '**発言が日誌に載るのも `queued` の時点である**ので、`GET /conversations` には' +
          'ターンの順番を待たずに現れる。**コメント行（`:` で始まる行）の heartbeat が' +
          '周期的に流れる。SSE の仕様上クライアントは読み捨ててよい**（無音のまま死んだ' +
          '接続を掃除するための送信でもある）。',
        responses: {
          200: {
            description: 'SSE ストリーム。',
            content: {
              'text/event-stream': { schema: resolver(chatStreamEventSchema) },
            },
          },
          400: {
            description: '`text` が空、または本文が JSON として不正。',
            content: { 'application/json': { schema: resolver(validationErrorResponseSchema) } },
          },
        },
      }),
      validator('json', chatBody),
      async (c) => {
        const { text, conversationId: given } = c.req.valid('json');
        const conversationId = given ?? randomUUID();

        return streamSSE(c, async (stream) => {
          const queue: ChatStreamEvent[] = [];
          let wake: (() => void) | null = null;
          let finished = false;

          const unsubscribe = clone.subscribe(conversationId, (event) => {
            queue.push(event);
            if (event.type === 'done' || event.type === 'error') finished = true;
            wake?.();
          });

          // **`try` は `subscribe()` の直後から始める。** 以前はここより後ろに
          // あり、`clone.post` や `open` の書き込みが投げたら購読が漏れていた
          // （現行の実装では投げないので今は踏まれないが、将来ここに検査や
          // 変換が増えたときに静かにリークへ転化する）。
          try {
            // 人間が chat を閉じても、クローンのターンは走り続ける（人間の不在で
            // 止まるのは承認待ちの仕事だけ）。ここで手放すのは購読だけである。
            stream.onAbort(() => {
              finished = true;
              wake?.();
            });

            // heartbeat は SSE のコメント行を流す（クライアントは読み捨てる）。
            // 死んだ接続の掃除の契機でもある（詳細は `@alteroid/core` の `sse-heartbeat.ts`）。
            const stopHeartbeat = startSseHeartbeat(stream, sseHeartbeatMs, () => wake?.());

            try {
              /*
               * **`open` を書く前に積む。順序に意味がある。**
               *
               * `open` は「この呼びの投函はもう済んだ」の合図として読まれる。受信中に
               * 続けて打った発言を投函だけしたい呼び（Web UI の追送。2本目の購読を
               * 張ると同じ応答が二度流れるので張らない）は、`open` を見た時点で接続を
               * 捨てる。**逆順だと、捨てるのが `clone.post` より先になりうる** —
               * `stream.onAbort` が走った後にここへ来ると、積む前にこの関数から抜ける
               * 経路が生まれ、発言が黙って消える。
               *
               * 積むのを先にしておけば、以後どこで切られても発言は受信箱に在る。
               * 購読（上の `clone.subscribe`）はさらに手前で張ってあるので、`#record`
               * が出す `queued` も取りこぼさない。
               *
               * **heartbeat をこれより手前で起こしているのは順序に影響しない** —
               * heartbeat が書くのはコメント行だけで、`open` の代わりにはならない。
               */
              clone.post({
                type: 'human_message',
                id: randomUUID(),
                at: new Date().toISOString(),
                text,
                conversationId,
              });

              await stream.writeSSE({ event: 'open', data: JSON.stringify({ conversationId }) });

              for (;;) {
                if (stream.aborted || stream.closed) break;
                const event = queue.shift();
                if (event === undefined) {
                  if (finished) break;
                  await new Promise<void>((resolve) => {
                    wake = resolve;
                  });
                  wake = null;
                  continue;
                }
                await stream.writeSSE({ event: event.type, data: JSON.stringify(event) });
                if (event.type === 'done' || event.type === 'error') break;
              }
            } finally {
              stopHeartbeat();
            }
          } finally {
            unsubscribe();
          }
        });
      },
    )

    /** 会話の終了 = 蒸留の契機。CLI が chat を抜けるときに叩く。 */
    .post(
      '/chat/:conversationId/end',
      describeRoute({
        tags: ['chat'],
        summary: '会話の終了（蒸留の契機）',
        description:
          '会話の終了 = 蒸留の契機。CLI が chat を抜けるときに叩く。運ぶ情報は無い（`{}` を送る）。',
        requestBody: noBodyPostRequestBody(
          '**中身は読まないので `{}` を送ればよい。** 本文そのものではなく ' +
            '`content-type: application/json` が要る（ブラウザの単純リクエストで蒸留ターンを' +
            '起こされないため）。',
        ),
        responses: {
          200: {
            description: '蒸留を促した。',
            content: { 'application/json': { schema: resolver(okResponseSchema) } },
          },
          ...noBodyPostResponses(),
        },
      }),
      deliberateClient,
      async (c) => {
        await clone.endConversation(c.req.param('conversationId'));
        return c.json({ ok: true });
      },
    )

    // --- 会話（続きから話せること自体が要件） -------------------------------
    /**
     * 会話の一覧。
     *
     * **`POST /chat` の SSE は流すだけで、後から読み直す口が無かった。** その口が
     * 無いと、器（端末・タブ・アプリ）を替えた瞬間に会話が消える。人間が同じ
     * クローンと話し続けられないなら、それは器の都合が能力を削っている
     * （north_star 禁止1）。
     *
     * 日誌から組み立てているので、新しく持つ状態は無い。追記専用の記録が
     * そのまま会話の履歴になる。
     */
    .get(
      '/conversations',
      describeRoute({
        tags: ['conversations'],
        summary: '会話の一覧',
        description:
          '`POST /chat` の SSE は流すだけで読み直す口が無かった。器（端末・タブ・アプリ）' +
          'を替えても続きから話せるための一覧。日誌から組み立てるので新しい状態は持たない。' +
          '新しい順。`scanned` で遡り切れていないことが分かる（黙って打ち切らない）。',
        responses: {
          200: {
            description: '会話の一覧（新しい順）。',
            content: { 'application/json': { schema: resolver(conversationsResponseSchema) } },
          },
          400: {
            description: 'クエリが不正。',
            content: { 'application/json': { schema: resolver(validationErrorResponseSchema) } },
          },
        },
      }),
      validator('query', conversationsQuery),
      async (c) => {
        const { limit, scan } = c.req.valid('query');
        const entries = await stores.journal.list({ limit: scan, types: ['exchange'] });

        /**
         * 畳み直しの規則そのものは `@alteroid/core` の `conversation.ts` が持つ。
         *
         * **こことクローンの道具（`conversation_read`）で同じ関数を呼ぶ。** 規則を
         * 両側に写すと、片方を直してもう片方を忘れたときに「人間には見えるが
         * クローンには見えない」がまた1つ増える — それは、その道具を足す動機に
         * なった欠陥そのものである。日誌の順序をそのまま会話の順序にする理由
         * （同じミリ秒の前後は時刻からは決められない）も、移設先に書いてある。
         */
        return c.json({
          conversations: collectConversations(entries).slice(0, limit),
          /** 遡った範囲。ここより古い会話は出てこない（`scan` を増やせば見える）。 */
          scanned: entries.length,
        });
      },
    )

    /** 1つの会話の中身（古い順）。器を替えても続きから話せるための口。 */
    .get(
      '/conversations/:id',
      describeRoute({
        tags: ['conversations'],
        summary: '1つの会話の中身（古い順）',
        description:
          '1つの会話の中身（古い順）。器を替えても続きから話せるための口。' +
          '**黙って打ち切らない** — `scanned` でどこまで遡ったか、`reachedStart` で' +
          '窓が日誌の先頭に届いたかを返す。`404` は `reachedStart` が真のときだけ' +
          '返る（「無い」と「遡り切れていない」を同じ応答にしないため）。',
        responses: {
          200: {
            description:
              '会話の中身。`reachedStart` が偽なら、窓の外に続きが残っている可能性がある。' +
              '`messages` が空でこれが偽の場合は「無い」ではなく**判定できない**。',
            content: {
              'application/json': { schema: resolver(conversationDetailResponseSchema) },
            },
          },
          400: {
            description: 'クエリが不正。',
            content: { 'application/json': { schema: resolver(validationErrorResponseSchema) } },
          },
          404: {
            description:
              '該当する会話が無い（内部ターン `self` は含まれない）。**遡り切れた場合だけ** — ' +
              '窓の外かもしれないときは 200 で `reachedStart: false` を返す。',
            content: { 'application/json': { schema: resolver(errorResponseSchema) } },
          },
        },
      }),
      validator('query', conversationQuery),
      async (c) => {
        const id = c.req.param('id');
        const { scan } = c.req.valid('query');
        const entries = await stores.journal.list({ limit: scan, types: ['exchange'] });
        /**
         * 絞り込みと並べ直しは `@alteroid/core` の `conversationMessages` が持つ
         * （クローンの `conversation_read` と同じ関数である。上の一覧と同じ理由）。
         *
         * **応答に載せる項目はここで選び直す。** 共有の型は `conversationId` も
         * 持っているが、この口の応答スキーマ（`conversationMessageSchema`）は
         * 4項目だけなので、**移設で応答が1項目増えることのないよう**明示して写す。
         */
        const messages = conversationMessages(entries, id).map((message) => ({
          id: message.id,
          at: message.at,
          /** `inbound` = 人間の発言 / `outbound` = クローンの返答。 */
          role: message.role,
          text: message.text,
        }));

        /*
         * **窓が日誌の先頭に届いたかを、返す件数から言う。**
         *
         * ストアは新しい順に最大 `limit` 件返すので、返ってきた数が頼んだ数に
         * 届かなければ、それ以上は無い＝先頭まで見た、と言える。ちょうど同数の
         * ときは**まだあるかもしれない**ので届いていない側へ倒す（安全側）。
         * 全件がぴったり `scan` 件だった場合に「判定できない」と答えるのは、
         * 実際には見切っているのに保守的に言いすぎるだけで、逆はやらない。
         *
         * 判定そのものは `reachedStart`（`@alteroid/core`）が持つ。
         */
        const reached = reachedStart(entries.length, scan);

        /*
         * **「無い」と「遡り切れていない」を同じ応答にしない。**
         *
         * ここを一律 404 にしていたので、`scan` の窓より古い会話が「そんな会話は
         * 無い」として返っていた。呼ぶ側から見ると、消えた会話と、まだ見ていない
         * 会話が区別できない（判定できないことが出力から消えていた）。
         *
         * 遡り切れているなら「無い」と言ってよい。切れていないなら、空の結果に
         * `reachedStart: false` を添えて返し、判定は呼ぶ側へ渡す。
         */
        if (messages.length === 0 && reached) {
          return c.json({ error: 'not found' as const }, 404);
        }
        return c.json({
          conversationId: id,
          messages,
          scanned: entries.length,
          reachedStart: reached,
        });
      },
    )

    /**
     * 出来事の流れ（SSE）。**日誌に載ったものがそのまま流れる。**
     *
     * 聞きに行かないと分からない状態だと、承認待ちが出たことに人間は気づけない。
     * 画面が数秒ごとに聞き直すのは、その穴を器の側で埋めているだけである。
     *
     * ここで種別を選り分ける表を持たない（`type` の絞り込みは**呼ぶ側**が指定する）。
     * 見えない層を作らないための口で選別を始めたら、意味が消える。
     */
    .get(
      '/journal/stream',
      describeRoute({
        tags: ['journal'],
        summary: '日誌の追記をそのまま流す（SSE）',
        description:
          '日誌に載ったものがそのまま流れる（聞きに行かなくても承認待ちの発生に気づける）。' +
          '**SSE。** `event:` に日誌エントリ種別（`open` に加え、`exchange` / `decision` / ' +
          '`escalation` / `tool_use` / `memory_update` / `daily_report` / ' +
          '`external_event`）、`data:` に日誌エントリ本体（`open` は `{ok:true}` のみ別枠）。' +
          '`type` クエリで絞り込めるが、選り分ける表は持たない（絞り込みは呼ぶ側が決める）。' +
          '**コメント行（`:` で始まる行）の heartbeat が周期的に流れる。SSE の仕様上' +
          'クライアントは読み捨ててよい**（無音のまま死んだ接続を掃除するための送信でもある）。',
        responses: {
          200: {
            description: 'SSE ストリーム。',
            content: { 'text/event-stream': { schema: resolver(journalEntrySchema) } },
          },
          400: {
            description: 'クエリが不正。',
            content: { 'application/json': { schema: resolver(validationErrorResponseSchema) } },
          },
          503: {
            description: '出来事の流れが配線されていない（能力を落とさず、黙って隠さない）。',
            content: { 'application/json': { schema: resolver(errorResponseSchema) } },
          },
        },
      }),
      validator('query', journalStreamQuery),
      (c) => {
        const bus = deps.journalEvents;
        if (bus === undefined) {
          return c.json({ error: '出来事の流れが配線されていない' as const }, 503);
        }
        const types = c.req
          .valid('query')
          .type?.split(',')
          .filter((value) => value.length > 0);

        return streamSSE(c, async (stream) => {
          const queue: JournalEntry[] = [];
          let wake: (() => void) | null = null;
          let closed = false;

          const unsubscribe = bus.subscribe((entry) => {
            if (types !== undefined && !types.includes(entry.type)) return;
            queue.push(entry);
            wake?.();
          });

          // **`try` は `subscribe()` の直後から始める。**（`/chat` と同じ理由。
          // `open` の書き込みが将来投げても、購読が漏れないようにする。）
          try {
            stream.onAbort(() => {
              closed = true;
              wake?.();
            });

            // heartbeat は SSE のコメント行を流す（クライアントは読み捨てる）。
            // 死んだ接続の掃除の契機でもある（詳細は `@alteroid/core` の `sse-heartbeat.ts`）。
            const stopHeartbeat = startSseHeartbeat(stream, sseHeartbeatMs, () => wake?.());

            try {
              await stream.writeSSE({ event: 'open', data: JSON.stringify({ ok: true }) });

              for (;;) {
                if (closed || stream.aborted || stream.closed) break;
                const entry = queue.shift();
                if (entry === undefined) {
                  await new Promise<void>((resolve) => {
                    wake = resolve;
                  });
                  wake = null;
                  continue;
                }
                await stream.writeSSE({ event: entry.type, data: JSON.stringify(entry) });
              }
            } finally {
              stopHeartbeat();
            }
          } finally {
            unsubscribe();
          }
        });
      },
    )

    // --- 記憶（人間が読んで直せること自体が要件） ---------------------------
    .get(
      '/memory',
      describeRoute({
        tags: ['memory'],
        summary: '記憶文書の一覧',
        description: '記憶（PersonaStore）の文書一覧。本文は含まない（メタ情報だけ）。',
        responses: {
          200: {
            description: '記憶文書のメタ情報一覧。',
            content: { 'application/json': { schema: resolver(memoryListResponseSchema) } },
          },
        },
      }),
      async (c) => c.json({ documents: await stores.persona.list() }),
    )

    .get(
      '/memory/:slug',
      describeRoute({
        tags: ['memory'],
        summary: '記憶文書を1つ読む',
        responses: {
          200: {
            description: '記憶文書。',
            content: { 'application/json': { schema: resolver(memoryReadResponseSchema) } },
          },
          404: {
            description: '該当する記憶が無い。',
            content: { 'application/json': { schema: resolver(errorResponseSchema) } },
          },
        },
      }),
      async (c) => {
        const doc = await stores.persona.read(c.req.param('slug'));
        if (!doc) return c.json({ error: 'not found' as const }, 404);
        return c.json({ document: doc });
      },
    )

    .put(
      '/memory/:slug',
      describeRoute({
        tags: ['memory'],
        summary: '記憶文書を全文置換で書く',
        description: '人間が API から記憶を書き換える口。書き換えは日誌に残る（`cause: human`）。',
        responses: {
          200: {
            description: '書き換え後の記憶文書。',
            content: { 'application/json': { schema: resolver(memoryReadResponseSchema) } },
          },
          400: {
            description: '記憶のスラッグが不正、または本文が JSON として不正。',
            content: { 'application/json': { schema: resolver(badRequestResponseSchema) } },
          },
        },
      }),
      validator('json', memoryBody),
      async (c) => {
        const slug = c.req.param('slug');
        if (!memorySlugSchema.safeParse(slug).success) {
          return c.json({ error: '記憶のスラッグが不正' as const }, 400);
        }
        const before = await stores.persona.read(slug);
        const doc = await stores.persona.write(slug, c.req.valid('json').content);
        const entry = await stores.journal.append({
          type: 'memory_update',
          slug,
          cause: 'human',
          action: 'write',
          // クローンの道具（tools.ts の memory_write）と同じ機械可読な面。
          // 片方だけ足すと「人間の書き込みだけ数えられない」が生まれる。
          bytesBefore: before === null ? 0 : Buffer.byteLength(before.content, 'utf8'),
          bytesAfter: Buffer.byteLength(doc.content, 'utf8'),
          summary: 'HTTP API 経由で人間が記憶を書き換えた',
        });
        // **保護状態の派生値を追いつかせる。** 新しい真実を作るのではなく、
        // いま journal.append が書いた cause:'human' の記録そのものを読み出し
        // やすい形にキャッシュしている（一度立てたら降ろさない。`store.ts` の
        // `PersonaStore.markHumanTouched` の doc）。
        await stores.persona.markHumanTouched(slug, entry.at);
        return c.json({ document: doc });
      },
    )

    /**
     * 記憶を1つ消す。
     *
     * 書けるのに消せないと、間違って作った記憶が**永久に判断の材料に残る**。
     * 人間が読んで直せることが要件なのだから、直すことには消すことも含まれる。
     * 消した事実は日誌に残るので、記憶から消えても記録からは消えない。
     */
    .delete(
      '/memory/:slug',
      describeRoute({
        tags: ['memory'],
        summary: '記憶文書を消す',
        description:
          '書けるのに消せないと、間違って作った記憶が永久に判断の材料に残る。消した事実は' +
          '日誌に残る（`cause: human`）ので、記憶から消えても記録からは消えない。',
        responses: {
          200: {
            description: '消した。',
            content: { 'application/json': { schema: resolver(memoryDeleteResponseSchema) } },
          },
          400: {
            description: '記憶のスラッグが名前として成立しない（「無い」とは区別する）。',
            content: { 'application/json': { schema: resolver(errorResponseSchema) } },
          },
          404: {
            description: '該当する記憶が無い。',
            content: { 'application/json': { schema: resolver(errorResponseSchema) } },
          },
        },
      }),
      async (c) => {
        const slug = c.req.param('slug');
        if (!memorySlugSchema.safeParse(slug).success) {
          return c.json({ error: '記憶のスラッグが不正' as const }, 400);
        }
        const existing = await stores.persona.read(slug);
        if (existing === null) return c.json({ error: 'not found' as const }, 404);
        // **`markHumanTouched` はここでは呼ばない。** `PersonaStore.remove` は
        // 保護状態の派生値も一緒に消す（実体の無い印は監査上の嘘になるため）ので、
        // ここで印を立てても同じ操作の中で消える。人間がこの slug を書いた事実
        // そのものは日誌（下の `memory_update`）に残り続けるので、
        // デーモン再起動時の backfill がこの slug の履歴を再び舐めても
        // `action:'remove'` のこのエントリからは印を立て直さない（`storage.ts` の
        // backfill の doc）——delete は「人間の意思で消した」であって、
        // 将来ここに書かれる新しい内容を無条件に保護する理由にはならない。
        await stores.persona.remove(slug);
        await stores.journal.append({
          type: 'memory_update',
          slug,
          cause: 'human',
          action: 'remove',
          bytesBefore: Buffer.byteLength(existing.content, 'utf8'),
          bytesAfter: 0,
          summary: 'HTTP API 経由で人間が記憶を削除した',
        });
        return c.json({ ok: true, slug });
      },
    )

    // --- 日誌 --------------------------------------------------------------
    .get(
      '/journal',
      describeRoute({
        tags: ['journal'],
        summary: '日誌を読む',
        description: '日誌（追記専用の記録）を新しい順に読む。`type` `since` `until` で掘れる。',
        responses: {
          200: {
            description: '日誌エントリの一覧（新しい順）。',
            content: { 'application/json': { schema: resolver(journalListResponseSchema) } },
          },
          400: {
            description: 'クエリが不正。',
            content: { 'application/json': { schema: resolver(validationErrorResponseSchema) } },
          },
        },
      }),
      validator('query', journalQuery),
      async (c) => {
        const { limit, since, until, type } = c.req.valid('query');
        const types = type?.split(',').filter((value) => value.length > 0) as
          JournalEntryType[] | undefined;
        return c.json({
          entries: await stores.journal.list({
            limit,
            ...(since === undefined ? {} : { since }),
            ...(until === undefined ? {} : { until }),
            ...(types === undefined || types.length === 0 ? {} : { types }),
          }),
        });
      },
    )

    // --- 利用状況（いくら使ったか） --------------------------------------------
    /**
     * **経路は1本だけにする。** 画面のために別の口を足すと、その瞬間に
     * 「CLI ではできないこと」が生まれる（PRD「インターフェース」）。CLI・Web UI・
     * クローンの道具（`usage_read`）はすべてここを通る。
     *
     * **クローンからも同じものが見えること自体が要件である。** 人間が
     * `claude.ai/settings/usage` を見て、その写像であるクローンが見られないのは
     * 能力の削除（north_star 禁止1）。
     */
    .get(
      '/usage',
      describeRoute({
        tags: ['usage'],
        summary: '利用状況（alteroid が使った分）',
        description:
          'SDK の `result.modelUsage` を積んだ台帳を、日 × マネージャー × モデルで返す。' +
          '**推定値であり請求明細ではない**（`notice` に同じ但し書きが載る）。' +
          '台帳の始点は `since`、照会範囲が始点より前にかかっていれば `beforeLedger` が真になる — ' +
          'そのときは 0 ではなく「記録が無い」と読むこと（過去分の掘り起こしはしていない）。' +
          '層と場所の軸は台帳より後から入ったので、始点は `layersSince`、' +
          '照会範囲がそれより前にかかっていれば `beforeLayers` が真になる — ' +
          'そのときの `layer` / `site` は既定値であって観測ではない。',
        responses: {
          200: {
            description: '台帳の集計。',
            content: { 'application/json': { schema: resolver(usageResponseSchema) } },
          },
          400: {
            description: 'クエリが不正。',
            content: { 'application/json': { schema: resolver(validationErrorResponseSchema) } },
          },
        },
      }),
      validator('query', usageQuery),
      async (c) => {
        const { from, to, managerId, layer, site } = c.req.valid('query');
        const aggregate = await stores.usage.aggregate({
          ...(from === undefined ? {} : { from }),
          ...(to === undefined ? {} : { to }),
          ...(managerId === undefined ? {} : { managerId }),
          ...(layer === undefined ? {} : { layer }),
          ...(site === undefined ? {} : { site }),
        });
        return c.json({
          ...aggregate,
          // 内訳は core の1つの実装で作る（口ごとに足し直すと食い違う）。
          breakdown: summarizeUsage(aggregate.rows),
          // **配線されていなければ「まだ分からない」を返す。** 0 や null にすると
          // 「枠を使っていない」と読める（テストの HTTP 層検証では省略できる）。
          account: deps.accountUsage?.() ?? { state: 'unknown' as const },
        });
      },
    )

    // --- 日報（可観測性の最上段。人間の普段の接点はほぼこれだけ） --------------
    .get(
      '/reports',
      describeRoute({
        tags: ['reports'],
        summary: '日報の一覧',
        description:
          '日報（可観測性の最上段）を**日付の新しい順**に読む（同じ日に複数あれば書いた時刻の新しい方が先）。日誌の並び（書いた順）とは一致しない — 遡り生成では前の日ぶんの日報が今日書かれる（`reports.ts`）。',
        responses: {
          200: {
            description: '日報の一覧（日付の新しい順）。',
            content: { 'application/json': { schema: resolver(reportsResponseSchema) } },
          },
          400: {
            description: 'クエリが不正。',
            content: { 'application/json': { schema: resolver(validationErrorResponseSchema) } },
          },
        },
      }),
      validator('query', reportsQuery),
      async (c) => {
        // **並べ直しはここが持つ**（`reports.ts`）。日誌の並びは書いた順なので、
        // そのまま返すと遡り生成の日報が新しい日の上に来る。画面や CLI の側で
        // 並べ直すと「最新の日報」が口ごとに食い違う。
        const reports = await listDailyReports(stores.journal, c.req.valid('query').limit);
        return c.json({ reports });
      },
    )

    .get(
      '/reports/:date',
      describeRoute({
        tags: ['reports'],
        summary: '1日分の日報',
        responses: {
          200: {
            description: 'その日の日報。',
            content: { 'application/json': { schema: resolver(reportsResponseSchema) } },
          },
          400: {
            description: '日付が `YYYY-MM-DD` 形式ではない（黙って別の日にずらさない）。',
            content: { 'application/json': { schema: resolver(errorResponseSchema) } },
          },
          404: {
            description: 'その日の日報が無い。',
            content: { 'application/json': { schema: resolver(errorResponseSchema) } },
          },
        },
      }),
      async (c) => {
        const date = c.req.param('date');
        const range = localDayRange(date);
        if (range === null) return c.json({ error: '日付は YYYY-MM-DD で指定する' as const }, 400);

        // その日以降だけを読む（日報は1日1件なので、遡る量は日数で収まる）
        const entries = await stores.journal.list({
          types: ['daily_report'],
          since: range.since.toISOString(),
        });
        // 同じ日に複数あるとき（締めと遡り生成）は書いた時刻の新しい方を先に出す。
        // 日誌の並びが既にそうなっているが、**一覧（`/reports`）と同じ比較で並べる** —
        // 画面は「その日の先頭」を既定で開くので、口ごとに違うと開くものが変わる。
        const reports = entries
          .filter(isDailyReport)
          .filter((entry) => entry.date === date)
          .sort(compareDailyReportsNewestFirst);
        if (reports.length === 0) return c.json({ error: 'not found' as const }, 404);
        return c.json({ reports });
      },
    )

    // --- 承認待ちキュー ----------------------------------------------------
    .get(
      '/approvals',
      describeRoute({
        tags: ['approvals'],
        summary: '承認待ちの一覧',
        description: '`ask_human` が積んだ承認待ち。既定では未回答のみ（`pending=false` で全部）。',
        responses: {
          200: {
            description: '承認待ちの一覧。',
            content: { 'application/json': { schema: resolver(approvalsResponseSchema) } },
          },
          400: {
            description: 'クエリが不正。',
            content: { 'application/json': { schema: resolver(validationErrorResponseSchema) } },
          },
        },
      }),
      validator('query', approvalsQuery),
      async (c) => {
        const approvals = await stores.jobs.listApprovals({
          pendingOnly: c.req.valid('query').pending !== 'false',
        });
        return c.json(
          approvalsResponseSchema.parse({
            approvals: approvals.map((approval) => ({
              ...approval,
              updatedAt: approvalUpdatedAt(approval),
            })),
          }),
        );
      },
    )

    /**
     * 溜まった保留をまとめて片付ける。1件が駄目でも残りは進める（人間の不在で
     * 止まっていたそれぞれの仕事が、答えた順に独立に再開する）。
     */
    .post(
      '/approvals/answer',
      describeRoute({
        tags: ['approvals'],
        summary: '溜まった承認待ちにまとめて答える',
        description:
          '1件が駄目でも残りは進める（人間の不在で止まっていたそれぞれの仕事が、答えた順に' +
          '独立に再開する）。結果は `answers` と同じ順で返る。',
        responses: {
          200: {
            description: '各件の結果（1件ごとの成否）。',
            content: {
              'application/json': { schema: resolver(approvalsAnswerResponseSchema) },
            },
          },
          400: {
            description: '本文が JSON として不正。',
            content: { 'application/json': { schema: resolver(validationErrorResponseSchema) } },
          },
        },
      }),
      validator('json', answersBody),
      async (c) => {
        const results: { id: string; ok: boolean; error?: string }[] = [];
        for (const { id, answer } of c.req.valid('json').answers) {
          const approval = await stores.jobs.getApproval(id);
          if (!approval) {
            results.push({ id, ok: false, error: 'not found' });
            continue;
          }
          if (approval.answeredAt !== undefined) {
            results.push({ id, ok: false, error: 'already answered' });
            continue;
          }
          try {
            await clone.answerApproval(id, answer);
            results.push({ id, ok: true });
          } catch (error) {
            results.push({ id, ok: false, error: String(error) });
          }
        }
        return c.json({ results });
      },
    )

    .post(
      '/approvals/:id/answer',
      describeRoute({
        tags: ['approvals'],
        summary: '承認待ちに1件答える',
        description:
          '二度答えると、既に再開した仕事へ同じ回答がもう一度流れ、記録上の回答も上書きされる。' +
          '答え直したいなら新しい確認として来るのが正しい（→ 409）。',
        responses: {
          200: {
            description: '答えた。',
            content: { 'application/json': { schema: resolver(okResponseSchema) } },
          },
          400: {
            description: '本文が JSON として不正。',
            content: { 'application/json': { schema: resolver(validationErrorResponseSchema) } },
          },
          404: {
            description: '該当する承認待ちが無い。',
            content: { 'application/json': { schema: resolver(errorResponseSchema) } },
          },
          409: {
            description: '既に回答済み。',
            content: { 'application/json': { schema: resolver(errorResponseSchema) } },
          },
        },
      }),
      validator('json', answerBody),
      async (c) => {
        const id = c.req.param('id');
        const approval = await stores.jobs.getApproval(id);
        if (!approval) return c.json({ error: 'not found' as const }, 404);
        // 二度答えると、既に再開した仕事へ同じ回答がもう一度流れ、記録上の回答も
        // 上書きされる。答え直したいなら新しい確認として来るのが正しい。
        if (approval.answeredAt !== undefined) {
          return c.json({ error: 'already answered' as const }, 409);
        }
        await clone.answerApproval(id, c.req.valid('json').answer);
        return c.json({ ok: true });
      },
    )

    // --- 外部イベントの入口（起点③） ----------------------------------------
    /**
     * 自作ツール・ショートカット・CI からクローンへ出来事を届ける。
     * 何をするかはここで決めない（対応表を持った瞬間に自動化ジョブに戻る）。
     */
    .post(
      '/events',
      describeRoute({
        tags: ['events'],
        summary: '外部イベントをクローンへ届ける',
        description:
          '自作ツール・ショートカット・CI からクローンへ出来事を届ける。何をするかはここで' +
          '決めない（対応表を持った瞬間に自動化ジョブに戻る）。',
        responses: {
          200: {
            description: '受信箱へ積んだ。',
            content: { 'application/json': { schema: resolver(eventAcceptedResponseSchema) } },
          },
          400: {
            description: '本文が JSON として不正。',
            content: { 'application/json': { schema: resolver(validationErrorResponseSchema) } },
          },
        },
      }),
      validator('json', eventBody),
      (c) => {
        const { source, payload } = c.req.valid('json');
        const id = randomUUID();
        clone.post({ type: 'external', id, at: new Date().toISOString(), source, payload });
        return c.json({ ok: true, id });
      },
    )

    /**
     * 他人が形を決めている webhook 用。本文をそのまま payload として運ぶので、
     * 送り元を改造できなくても届く（GitHub や CI からそのまま叩ける）。
     */
    .post(
      '/events/:source',
      describeRoute({
        tags: ['events'],
        summary: '本文の形を選べない webhook 用の入口',
        description:
          '他人が形を決めている webhook 用。本文をそのまま payload として運ぶので、送り元を' +
          '改造できなくても届く（GitHub や CI からそのまま叩ける）。JSON として読めない本文は' +
          '文字列のまま渡す。',
        requestBody: noBodyPostRequestBody(
          '**本文まるごとが payload になる。** 送り元が形を決めているので中身は縛らない。' +
            'JSON として読めない本文は文字列のまま渡す。`content-type: application/json` は' +
            '必要（ブラウザの単純リクエストで判断材料を書き込まれないため）。サーバは空の' +
            '本文も受けて空文字列にするが、**spec としては本文を必須にしてある** — 生成' +
            'クライアントに content-type を必ず付けさせるため（運ぶものが無いなら `{}`）。',
        ),
        responses: {
          200: {
            description: '受信箱へ積んだ。',
            content: { 'application/json': { schema: resolver(eventAcceptedResponseSchema) } },
          },
          ...noBodyPostResponses(),
        },
      }),
      deliberateClient,
      async (c) => {
        const source = c.req.param('source');
        const raw = await c.req.text();
        let payload: unknown = raw;
        try {
          payload = raw.length > 0 ? JSON.parse(raw) : '';
        } catch {
          // JSON でなければ本文のまま渡す
        }
        const id = randomUUID();
        clone.post({ type: 'external', id, at: new Date().toISOString(), source, payload });
        return c.json({ ok: true, id });
      },
    )

    // --- 時間起点のジョブ ---------------------------------------------------
    .get(
      '/schedule',
      describeRoute({
        tags: ['schedule'],
        summary: '定期ジョブの一覧と次の発火時刻',
        responses: {
          200: {
            description: '定期ジョブの一覧。',
            content: { 'application/json': { schema: resolver(scheduleListResponseSchema) } },
          },
        },
      }),
      (c) => c.json(scheduleListResponseSchema.parse({ entries: deps.scheduler?.list() ?? [] })),
    )

    /**
     * 継続中の依頼を仕込む・直す（同じ kind なら置き換わる）。
     *
     * 真実はストア側にあり、スケジューラはそれを読み直すだけである。ここで
     * スケジューラへ直接足すと、デーモンを再起動した瞬間に消える仕込みができる。
     */
    .post(
      '/schedule',
      describeRoute({
        tags: ['schedule'],
        summary: '継続中の依頼を仕込む・直す',
        description:
          '「定期的に〜しておいて」をクローンの記憶任せにせず、時刻が来れば必ず届く形で置く。' +
          '同じ kind なら置き換わる（前回動いた時刻は保つ）。真実はストア側にあり、' +
          'スケジューラはそれを読み直すだけなので、デーモンを作り直しても残る。' +
          '既定の定期ジョブ（daily_report / self_initiative）の名前は奪えない（→ 409）。',
        responses: {
          200: {
            description: '仕込んだ。次の発火は `GET /schedule` で見える。',
            content: { 'application/json': { schema: resolver(okResponseSchema) } },
          },
          400: {
            description: '本文が JSON として不正（kind の形・時刻の範囲もここで弾く）。',
            content: { 'application/json': { schema: resolver(validationErrorResponseSchema) } },
          },
          409: {
            description: '既定の定期ジョブの名前。',
            content: { 'application/json': { schema: resolver(errorResponseSchema) } },
          },
        },
      }),
      validator('json', scheduleBody),
      async (c) => {
        const { kind, request, spec } = c.req.valid('json');
        if (RESERVED_SCHEDULE_KINDS.includes(kind)) {
          return c.json({ error: 'reserved kind' as const }, 409);
        }
        const now = new Date().toISOString();
        const existing = await stores.schedules.get(kind);
        await stores.schedules.put({
          kind,
          spec,
          request,
          createdAt: existing?.createdAt ?? now,
          updatedAt: now,
          // **これまでの記録を引き継ぐ。** 落とすと、直した瞬間に定期の基準が消えて
          // 位相が createdAt から引き直され（＝直後に1回余分に起きる）、引き受けたまま
          // 終わっていない発火の印も消える（＝その回が失われる）。
          ...(existing?.lastRunAt === undefined ? {} : { lastRunAt: existing.lastRunAt }),
          ...(existing?.lastScheduledRunAt === undefined
            ? {}
            : { lastScheduledRunAt: existing.lastScheduledRunAt }),
          ...(existing?.pendingRun === undefined ? {} : { pendingRun: existing.pendingRun }),
        });
        await stores.journal.append({
          type: 'decision',
          decision: `人間が定期の依頼を${existing ? '直した' : '仕込んだ'}: ${kind}: ${request}`,
          grounds: '人間が直接 API から仕込んだ',
        });
        // 次の刻みを待たずに効かせる（人間が仕込んだのに1分間存在しないのは嘘になる）
        await deps.scheduler?.refresh().catch(() => undefined);
        return c.json(okResponseSchema.parse({ ok: true }));
      },
    )

    .delete(
      '/schedule/:kind',
      describeRoute({
        tags: ['schedule'],
        summary: '継続中の依頼を外す',
        description:
          '済んだ依頼・もう要らない依頼をここで外す。既定の定期ジョブは仕込みではないので' +
          'ここでは外せない（間隔と締め時刻はデーモンの設定である）。',
        requestBody: noBodyPostRequestBody(
          '**中身は読まないので `{}` を送ればよい。** `DELETE` だが本文が必須なのは、' +
            '門番（`deliberateClient`）が `content-type: application/json` を要求することを' +
            'spec の機械可読部で表す手段がこれしか無いからである（`DELETE /managers/{id}` も' +
            '本文を要求する）。',
        ),
        responses: {
          200: {
            description: '外した。',
            content: { 'application/json': { schema: resolver(okResponseSchema) } },
          },
          404: {
            description: 'その kind の継続中の依頼が無い。',
            content: { 'application/json': { schema: resolver(errorResponseSchema) } },
          },
          ...noBodyPostResponses(),
        },
      }),
      deliberateClient,
      async (c) => {
        const kind = c.req.param('kind');
        const existing = await stores.schedules.get(kind);
        if (!existing) return c.json({ error: 'not found' as const }, 404);
        await stores.schedules.remove(kind);
        await stores.journal.append({
          type: 'decision',
          decision: `人間が定期の依頼を外した: ${kind}: ${existing.request}`,
          grounds: '人間が直接 API から外した',
        });
        await deps.scheduler?.refresh().catch(() => undefined);
        return c.json(okResponseSchema.parse({ ok: true }));
      },
    )

    /**
     * 定期ジョブを今すぐ起こす（人間が待たずに確かめるための口）。
     *
     * これは観測ではなく**実行**である。起こせばクローンのターンが走り、記憶に
     * 基づく委譲や外部への操作の判断まで動く。ブラウザから叩けてはいけない。
     */
    .post(
      '/schedule/:kind/run',
      describeRoute({
        tags: ['schedule'],
        summary: '定期ジョブを今すぐ起こす',
        description:
          'これは観測ではなく実行である。起こせばクローンのターンが走り、記憶に基づく委譲や' +
          '外部への操作の判断まで動く。予定はずらさない（余分に1回起こす）。',
        requestBody: noBodyPostRequestBody(
          '**中身は読まないので `{}` を送ればよい。** 本文そのものではなく ' +
            '`content-type: application/json` が要る（ブラウザの単純リクエストで自律ターンを' +
            '起こされないため）。',
        ),
        responses: {
          200: {
            description: '起こした。',
            content: { 'application/json': { schema: resolver(okResponseSchema) } },
          },
          404: {
            description: '知らない kind。',
            content: { 'application/json': { schema: resolver(errorResponseSchema) } },
          },
          ...noBodyPostResponses(),
        },
      }),
      deliberateClient,
      (c) => {
        const kind = c.req.param('kind');
        if (deps.scheduler?.run(kind) !== true) return c.json({ error: 'not found' as const }, 404);
        return c.json(okResponseSchema.parse({ ok: true }));
      },
    )

    // --- 引き受けたまま終わっていない仕事の台帳 ------------------------------
    //
    // **クローンが持っている手（`commitment_list` / `commitment_open` /
    // `commitment_close`）を、人間の側にもそのまま置く。** 片方にしか無いと、
    // 頼んだことがまだ残っているのか片付いたのかを人間が確かめられず、
    // 台帳がクローンの内側だけの器になる（PRD「可観測性」）。
    //
    // **資格は `/schedule` と同じ（`authenticate` だけ）。`requireOperator` にしない。**
    // あちらは実行環境そのものを差し替える資格（`/profile` `/access`）であって、
    // 台帳の読み書きはそこまでの資格ではない。ここを持ち主だけにすると、
    // 「使ってよい」の2値を通ったアカウントから台帳だけが見えなくなる。
    //
    // **これは「やることの一覧」ではない。** 器が持つのは「何を頼まれたか」と
    // 「まだ片付いていない」の2値だけで、順序も優先度も締切も持たない。だから
    // 並べ替えや絞り込みの引数をここへ足さないこと（判断がクローンから器へ移る）。
    .get(
      '/commitments',
      describeRoute({
        tags: ['commitments'],
        summary: '引き受けたまま終わっていない仕事の一覧',
        description:
          'クローンの `commitment_list` と同じものを人間の側から読む。既定は**未了だけ**で、' +
          '古い順に返る（齢が判断の材料なので、古いものから見せる）。`includeClosed=true` を' +
          '付けると片付けたものが未了の後ろに新しい順で続く。順序や優先度は器が持たない。' +
          '`unreadable` は台帳の行が読めなかったもの（issue #296）。**「無い」でも' +
          '「片付いた」でもない第3の状態**で、0件でも欄自体は必ず返る。',
        responses: {
          200: {
            description: '台帳の中身。',
            content: { 'application/json': { schema: resolver(commitmentListResponseSchema) } },
          },
          400: {
            description: 'クエリが不正（`includeClosed` は `true` / `false` だけ）。',
            content: { 'application/json': { schema: resolver(validationErrorResponseSchema) } },
          },
        },
      }),
      validator('query', commitmentsQuery),
      async (c) => {
        // **`list()` は `{ entries, unreadable }` を返す（issue #296）。**
        // `unreadable` もそのまま応答へ含める — 人間の側（Web UI・API を
        // 直接叩く側）にもクローンと同じ「読めない行が在る」という事実が
        // 見えるようにする（`commitmentListResponseSchema` の doc）。
        const { entries, unreadable } = await stores.commitments.list(
          c.req.valid('query').includeClosed === 'true' ? { includeClosed: true } : undefined,
        );
        return c.json(
          commitmentListResponseSchema.parse({
            entries: entries.map((entry) => ({ ...entry, updatedAt: commitmentUpdatedAt(entry) })),
            unreadable,
          }),
        );
      },
    )

    /**
     * 人間が台帳へ1件積む。
     *
     * **積むだけで、クローンのターンは起こさない。** ここは器であって仕事の起点では
     * ないので、いま考えさせたいなら `POST /chat` か `POST /events` を使う（起点を
     * 増やすと、同じことを2つの経路で起こせる状態になる）。積んだものは次のターンの
     * 冒頭に件数と齢として載り、`commitment_list` で全文が読める。
     */
    .post(
      '/commitments',
      describeRoute({
        tags: ['commitments'],
        summary: '引き受けた仕事として台帳へ積む',
        description:
          'クローンの `commitment_open` と同じものを人間の手から。**積むだけで、' +
          'クローンのターンは起こさない**（いま考えさせたいなら `POST /chat` か ' +
          '`POST /events`）。`origin` は `human` で固定され、id はここで振る。',
        responses: {
          200: {
            description: '積んだ。返る id が閉じるときの宛先になる。',
            content: { 'application/json': { schema: resolver(commitmentOpenedResponseSchema) } },
          },
          400: {
            description: '本文が JSON として不正（`body` は空にできない）。',
            content: { 'application/json': { schema: resolver(validationErrorResponseSchema) } },
          },
        },
      }),
      validator('json', commitmentBody),
      async (c) => {
        const { body, source } = c.req.valid('json');
        // **`origin` は本文から取らない。** ここを人間に選ばせると、人間が積んだものが
        // `self` を名乗れてしまい、「これは人間との約束か、自分で思い立ったことか」を
        // クローンが区別する手立てが消える（`commitmentOriginSchema` の注記）。
        const entry = {
          id: randomUUID(),
          at: new Date().toISOString(),
          origin: 'human' as const,
          ...(source === undefined ? {} : { source }),
          body,
        };
        await stores.commitments.open(entry);
        // 人間が chat の外から積んだものは、日誌に残さなければどこにも跡が無い
        // （chat 経由の依頼には `exchange` が残るが、この口には対応する発言が無い）。
        await stores.journal.append({
          type: 'decision',
          decision: `人間が引き受けた仕事を台帳へ積んだ（${entry.id}）: ${body}`,
          grounds: '人間が直接 API から積んだ',
        });
        return c.json(commitmentOpenedResponseSchema.parse({ ok: true, id: entry.id }));
      },
    )

    /**
     * 人間が1件を片付ける。
     *
     * **先に読んで判断しない。** 「読む → 未了だと分かる → 閉じる」に割ると、同じ id へ
     * 同時に届いた2つの close が両方とも「まだ未了だ」と読んでから両方書きにいき、
     * 後から来たほうの理由で上書きされる（＝人間が読む「何をもって終わりとしたか」が
     * 静かに入れ替わる）。**判定は台帳の1操作（`close`）に任せ**、読むのは 404 と 409 を
     * 書き分けるためだけにする。
     */
    .post(
      '/commitments/:id/close',
      describeRoute({
        tags: ['commitments'],
        summary: '引き受けた仕事を片付いたことにする',
        description:
          'クローンの `commitment_close` と同じものを人間の手から。**行は消さない** — ' +
          '消すと「何を片付けたか」が日報の材料から落ちる。`reason` は必須で、' +
          '人間はこれを読んで後から否定する。',
        responses: {
          200: {
            description: '閉じた。以後は `includeClosed=true` でだけ見える。',
            content: { 'application/json': { schema: resolver(okResponseSchema) } },
          },
          400: {
            description: '本文が JSON として不正（`reason` は空にできない）。',
            content: { 'application/json': { schema: resolver(validationErrorResponseSchema) } },
          },
          404: {
            description: 'その id は台帳に無い。',
            content: { 'application/json': { schema: resolver(errorResponseSchema) } },
          },
          409: {
            description: '既に片付いている（いつ・どう片付けたかを本文に入れて返す）。',
            content: { 'application/json': { schema: resolver(errorResponseSchema) } },
          },
        },
      }),
      validator('json', commitmentCloseBody),
      async (c) => {
        const id = c.req.param('id');
        const { reason } = c.req.valid('json');
        if (!(await stores.commitments.close(id, new Date().toISOString(), reason, 'human'))) {
          // 閉じられなかった理由は台帳に聞く（無いのか、既に閉じているのか）。
          const existing = await stores.commitments.get(id);
          if (existing === null) return c.json({ error: 'not found' as const }, 404);
          return c.json(
            {
              error:
                `${id} は既に ${existing.closedAt ?? '不明な時刻'} に片付いている` +
                `（${existing.closedReason ?? '理由の記録なし'}）`,
            },
            409,
          );
        }
        await stores.journal.append({
          type: 'decision',
          decision: `人間が引き受けた仕事を片付けた（${id}）: ${reason}`,
          grounds: '人間が直接 API から閉じた',
        });
        return c.json(okResponseSchema.parse({ ok: true }));
      },
    )

    // --- マネージャー（可観測性の中段から下段へ降りる経路） ------------------
    //
    // **応答は返す前に宣言したスキーマを通す（`.parse()`）。**
    //
    // `describeRoute` の `resolver()` は `openapi.json` を作るだけで、ハンドラが
    // 実際に何を返したかは見ていない。だから `c.json(await ...list())` は、
    // `ManagerSummary`（core の TS interface）にフィールドが1つ増えた日に、
    // spec に書いていないものを黙って外へ出す。「宣言」と「実物」を繋いでいるのが
    // 人間の注意力しかない状態で、ずれても誰も気づかない。
    //
    // `.parse()` を通せば、`z.object` が宣言に無いキーを落とす。以降このスキーマは
    // 「外へ出るものの定義」であって「外へ出るものの説明」ではない。
    //
    // ここで通しているのは `/managers` と `/managers/:id` の2本だけである
    // （ほかの経路は同じ穴を持ったまま。Issue に上げる）。
    .get(
      '/managers',
      describeRoute({
        tags: ['managers'],
        summary: '委譲先マネージャーの一覧',
        responses: {
          200: {
            description: 'マネージャーの一覧と状態。',
            content: { 'application/json': { schema: resolver(managersListResponseSchema) } },
          },
        },
      }),
      async (c) => {
        const managers = await clone.managers.list();
        return c.json(
          managersListResponseSchema.parse({
            managers: managers.map((summary) => managerView(clone.managers, summary)),
          }),
        );
      },
    )

    .get(
      '/managers/:id',
      describeRoute({
        tags: ['managers'],
        summary: '1本のマネージャーの状態',
        responses: {
          200: {
            description: 'マネージャーの状態。',
            content: { 'application/json': { schema: resolver(managerDetailResponseSchema) } },
          },
          404: {
            description: '該当するマネージャーが無い。',
            content: { 'application/json': { schema: resolver(errorResponseSchema) } },
          },
        },
      }),
      async (c) => {
        const id = c.req.param('id');
        const manager = (await clone.managers.list()).find((entry) => entry.managerId === id);
        if (!manager) return c.json({ error: 'not found' as const }, 404);
        return c.json(
          managerDetailResponseSchema.parse({ manager: managerView(clone.managers, manager) }),
        );
      },
    )

    /**
     * manager_id からそのセッションの生ログへ。走行中ならファイルの上、
     * 退避済みならアーカイブから返る（可観測性3層の最下段）。
     */
    .get(
      '/managers/:id/transcript',
      describeRoute({
        tags: ['managers'],
        summary: 'マネージャーの生ログ',
        description:
          'manager_id からそのセッションの生ログへ。走行中ならファイルの上、退避済みなら' +
          'アーカイブから返る（可観測性3層の最下段）。',
        responses: {
          200: {
            description: '生ログ（JSONL の生テキスト）。',
            content: { 'text/plain': { schema: resolver(z.string()) } },
          },
          404: {
            description: '該当するマネージャーの生ログが無い。',
            content: { 'application/json': { schema: resolver(errorResponseSchema) } },
          },
        },
      }),
      async (c) => {
        const body = await clone.managers.transcript(c.req.param('id'));
        if (body === null) return c.json({ error: 'not found' as const }, 404);
        return c.text(body);
      },
    )

    /**
     * 人間からマネージャーへ直接話しかける。
     *
     * **これが無いと、人間の言葉はクローンを経由してしか届かない。** クローンが
     * 取り込み中のときも、クローンの伝え方が間違っているときも、人間は手を出せない。
     * 実際に「マネージャーが正しく 403 を報告しているのに、伝言が間違っていて
     * 一晩噛み合わなかった」ということが起きている。
     *
     * クローンの代わりに判断するための口ではない（判断はクローンの仕事のまま）。
     * 人間が自分の言葉を自分で届けるための口である。
     */
    .post(
      '/managers/:id/messages',
      describeRoute({
        tags: ['managers'],
        summary: '人間からマネージャーへ直接話しかける',
        description:
          'これが無いと、人間の言葉はクローンを経由してしか届かない。クローンの代わりに判断' +
          'するための口ではない（判断はクローンの仕事のまま）。人間が自分の言葉を自分で届ける' +
          'ための口である。許可確認への回答なら `requestId` を付ける。',
        responses: {
          200: {
            description: '届いた（`answered` / `delivered`）。',
            content: { 'application/json': { schema: resolver(managerActionResponseSchema) } },
          },
          400: {
            description: '本文が JSON として不正。',
            content: { 'application/json': { schema: resolver(validationErrorResponseSchema) } },
          },
          404: {
            description: '該当するマネージャーが無い。',
            content: { 'application/json': { schema: resolver(errorResponseSchema) } },
          },
        },
      }),
      validator('json', managerMessageBody),
      async (c) => {
        const { text, requestId, decision } = c.req.valid('json');
        const result = await clone.managers.send(c.req.param('id'), text, {
          ...(requestId === undefined ? {} : { requestId }),
          ...(decision === undefined ? {} : { decision }),
        });
        if (result.outcome === 'unknown') return c.json({ error: result.detail }, 404);
        return c.json({ outcome: result.outcome, detail: result.detail });
      },
    )

    /**
     * この仕事をやめさせる。
     *
     * runner には `DELETE /managers/:id` があるのに、人間が届く側には無かった。
     * 暴走を止める手段が「器ごと落とす」しか無いと、**関係の無い仕事まで道連れ**
     * になる（それで M5 の作業が3回消えている）。止めた事実は日誌に残る。
     */
    .delete(
      '/managers/:id',
      describeRoute({
        tags: ['managers'],
        summary: 'この仕事をやめさせる',
        description:
          '暴走を止める手段が「器ごと落とす」しか無いと、関係の無い仕事まで道連れになる。' +
          'この口は1本だけを止める。止めた事実は日誌に残る。',
        responses: {
          200: {
            description:
              '止める指示は処理できた。`outcome` を読むこと — `stopped`（止まったと確かめた）/ ' +
              '`not_stopped`（止まっていないと確かめた）/ `unknown`（確かめられなかった）のどれかで、' +
              '止まったと機械可読に言えるのは `stopped` のときだけである。',
            content: { 'application/json': { schema: resolver(managerActionResponseSchema) } },
          },
          400: {
            description: '本文が JSON として不正。',
            content: { 'application/json': { schema: resolver(validationErrorResponseSchema) } },
          },
          404: {
            description: '該当するマネージャー（`absent`）が無い。',
            content: { 'application/json': { schema: resolver(errorResponseSchema) } },
          },
        },
      }),
      validator('json', abortBody),
      async (c) => {
        const { reason } = c.req.valid('json');
        const result = await clone.managers.abort(
          c.req.param('id'),
          ...(reason === undefined ? [] : ([reason] as const)),
        );
        // **`'absent'` だけが 404。** `'not_stopped'` / `'unknown'` は「そのものは
        // 居るが、止まった/止まっていない/確かめられなかった」という観測結果で
        // あって、リクエスト自体は正しく処理できている（200 で `outcome` を返す）。
        if (result.outcome === 'absent') return c.json({ error: result.detail }, 404);
        return c.json({ outcome: result.outcome, detail: result.detail });
      },
    )

    // --- 委譲先の器と、そこへ配る鍵 ----------------------------------------
    /**
     * runner の一覧と、**そこで配られている鍵の指紋**。
     *
     * 指紋を出すのは、人間が置いた鍵とマネージャーが握っている鍵が同じかどうかを
     * 確かめる手段が他に無いからである。無いと「鍵の権限が足りない」のか「鍵が
     * 届いていない」のかを誰も切り分けられず、人間とマネージャーが両方正しいまま
     * 何時間もすれ違う（実際に起きた）。**値は返らない。**
     */
    .get(
      '/runners',
      describeRoute({
        tags: ['runners'],
        summary: '委譲先 runner の一覧と、配られている鍵の指紋',
        description:
          '指紋を出すのは、人間が置いた鍵とマネージャーが握っている鍵が同じかどうかを確かめる' +
          '手段が他に無いからである。**値は返らない。**',
        responses: {
          200: {
            description: 'runner の一覧。',
            content: { 'application/json': { schema: resolver(runnersListResponseSchema) } },
          },
        },
      }),
      async (c) => {
        // デーモン自身の版。**自分のことなので取りに行く必要が無い**
        // （`resolveBuildRevision()` を直に呼ぶ。`known` / `unknown` の2状態）。
        // runner の一覧が空でも、この値だけは常に出す——「自分がどの版で
        // 走っているか」は runner の登録有無と無関係な事実である。
        const daemonRevision = reportRunnerRevision(resolveBuildRevision());

        const registry = deps.runners;
        if (registry === undefined) {
          return c.json(runnersListResponseSchema.parse({ runners: [], daemonRevision }));
        }
        // **名簿に載っている全部を返す**（開けている分だけではない）。上がって
        // こない runner が一覧から消えるだけだと、人間には「設定し忘れた」のか
        // 「上がってこない」のかが区別できない。
        const open = new Map((await registry.list()).map((runner) => [runner.runnerId, runner]));
        return c.json(
          runnersListResponseSchema.parse({
            runners: await Promise.all(
              registry.entries().map(async (entry) => {
                const runner = entry.runnerId === undefined ? undefined : open.get(entry.runnerId);
                return {
                  label: entry.label,
                  state: entry.state,
                  since: entry.since,
                  ...(entry.error === undefined ? {} : { error: entry.error }),
                  ...(entry.runnerId === undefined ? {} : { runnerId: entry.runnerId }),
                  ...(entry.workspacePath === undefined
                    ? {}
                    : { workspacePath: entry.workspacePath }),
                  // **繋がっていない相手のぶんも出す。** 黙った器について「最後に
                  // どのプロセスが応えていたか」は、戻ってきたときに同じ器かを
                  // 突き合わせる材料である（消すと、黙っている間だけ材料が消える）。
                  ...(entry.instanceId === undefined ? {} : { instanceId: entry.instanceId }),
                  ...(entry.instanceSince === undefined
                    ? {}
                    : { instanceSince: entry.instanceSince }),
                  // **繋がっていない相手には聞きに行かない**（指紋は runner が
                  // 持つ）。**そして聞かなかったことと、聞いて失敗したことと、
                  // 聞いて0件だったことを、同じ表現へ潰さない** — 潰すと読む側は
                  // 「鍵が配られていない」のか「確かめられなかった」のかを
                  // 区別できない（`runnerProbeSchema` の doc）。
                  ...(await probe(runner, 'credentials')),
                  ...(await probe(runner, 'profile')),
                  // **名簿に既にある値をそのまま出す**（heartbeat が拾った分）。
                  // ここで新たに runner を叩かない——`fingerprints` と同じ「未接続
                  // ／頼んで失敗／頼んでいない」が潰れる穴を増やさないため。
                  revision: entry.revision,
                };
              }),
            ),
            daemonRevision,
          }),
        );
      },
    )

    /**
     * マネージャーの道具の鍵を差し替える。**器を作り直さない。**
     *
     * これが無いと、鍵の更新に再デプロイが要る＝「鍵を直す」と「走行中の仕事を
     * 失う」が同じ操作になる。走っている人の仕事をデーモンの都合で殺さないのと
     * 同じ理由で、鍵の都合でも殺さない。
     *
     * 鍵はここに保管しない。受け取って runner へ降ろすだけである（デーモンの器に
     * 記憶の鍵と GitHub の書き込み権を並べない）。
     */
    .post(
      '/runners/credentials',
      describeRoute({
        tags: ['runners'],
        summary: 'マネージャーの道具の鍵を差し替える',
        description:
          '器を作り直さない。鍵はここに保管せず、受け取って全 runner へ降ろすだけである' +
          '（デーモンの器に記憶の鍵と GitHub の書き込み権を並べない）。',
        responses: {
          200: {
            description: '各 runner への配布結果。',
            content: {
              'application/json': { schema: resolver(runnersCredentialsResponseSchema) },
            },
          },
          400: {
            description: '本文が JSON として不正。',
            content: { 'application/json': { schema: resolver(validationErrorResponseSchema) } },
          },
          503: {
            description: 'runner が登録されていない。',
            content: { 'application/json': { schema: resolver(errorResponseSchema) } },
          },
        },
      }),
      validator('json', runnerSetCredentialsCommandSchema),
      async (c) => {
        const registry = deps.runners;
        if (registry === undefined) {
          return c.json({ error: 'runner が登録されていない' as const }, 503);
        }
        const runners = await registry.list();
        const { credentials } = c.req.valid('json');
        const results = await Promise.all(
          runners.map(async (runner) => {
            try {
              return {
                runnerId: runner.runnerId,
                ok: true as const,
                credentials: await runner.setCredentials(credentials),
              };
            } catch (error) {
              return { runnerId: runner.runnerId, ok: false as const, error: String(error) };
            }
          }),
        );
        return c.json(runnersCredentialsResponseSchema.parse({ results }));
      },
    )

    // --- 実行環境プロファイル（/profile） ----------------------------------

    /**
     * 人間が置いた実行環境プロファイル（`.zprofile` 相当）。
     *
     * **実行環境の持ち主だけ**（`requireOperator`）。`/access/*` と同じ資格である。
     *
     * 単一の持ち主しか許可できない以上、`access grant` 済みのアカウントも同じ人間の
     * はずだが、**この口だけは「使ってよい」より一段強い**。理由は下の `PUT` にある
     * とおりで、読み側も同じ扱いにする — 本文には `GH_TOKEN` のような鍵が丸ごと
     * 入りうるので、`GET` が緩いと `PUT` を締めても意味が無い。
     *
     * **本文を返す。** 自分が書いたものを読み直せないと typo ひとつ直せない。
     * 指紋しか返さないのは runner の制御面のほうで、あちらは「マネージャーが
     * 読めてはいけない」からそうしている（守っている相手が違う）。
     *
     * **デグレードではない。** 人間が `.zshenv` を直すのは、その人が持っている
     * 箱の上である。ここも同じで、遠隔から直したいなら `access grant` と同じく
     * `docker compose exec app alteroid profile edit` を通る。
     */
    .get(
      '/profile',
      describeRoute({
        tags: ['profile'],
        summary: '実行環境プロファイル（.zprofile 相当）を読む',
        description:
          '器の環境変数を増やす代わりに、シェルスクリプト1本を記憶ストアへ置く。' +
          'クローン・マネージャー・作業者のすべてに効く。',
        responses: {
          200: {
            description: 'プロファイルの本文。置かれていなければ空文字。',
            content: { 'application/json': { schema: resolver(profileResponseSchema) } },
          },
          403: {
            description: '実行環境の持ち主ではない。',
            content: { 'application/json': { schema: resolver(errorResponseSchema) } },
          },
        },
      }),
      requireOperator,
      async (c) => {
        const stored = await deps.stores.profile.read();
        if (stored === null) return c.json(profileResponseSchema.parse({ script: '' }));
        return c.json(
          profileResponseSchema.parse({
            script: stored.script,
            updatedAt: stored.updatedAt,
            sha256: fingerprintOf(stored.script),
            bytes: Buffer.byteLength(stored.script),
          }),
        );
      },
    )

    /**
     * プロファイルを差し替える。**器を作り直さない。**
     *
     * これが無いと、道具の鍵や `PATH` を1つ足すたびに `compose.yaml` を直して
     * 器を焼き直すことになる＝「環境を直す」と「走行中の仕事を失う」が同じ操作に
     * なる。鍵の差し替え（`POST /runners/credentials`）と同じ理由で口を開けてある。
     *
     * **実行環境の持ち主だけ**（`requireOperator`）。ここは「alteroid を使ってよい」
     * より一段強い口である — 受け取った本文はデーモンの `process.env` を土台に
     * その場で評価されるので、**記憶ストアの鍵を持つプロセスでの任意コマンド実行**
     * そのものであり、評価中の出力は応答にも返る。`access grant` を通っただけの
     * アカウントに、実行環境そのものを差し替える資格まで渡さない
     * （許可が持っているのは「使ってよい」の2値だけである）。
     *
     * **壊れているものは保存もしない。** プロファイルは人間が書いたシェル
     * スクリプトなので、構文を間違えれば読めない。それを保存すると、以後の
     * 再接続のたびに配布が失敗し、器を作り直した瞬間に環境が黙って痩せる。
     * 先に評価して、通らなければ 400 で理由を返す（前のものが残る）。
     */
    .put(
      '/profile',
      describeRoute({
        tags: ['profile'],
        summary: '実行環境プロファイルを差し替える',
        description:
          '置く前に評価する。読めなければ保存も配布もせず、理由を返す（前のものが残る）。',
        responses: {
          200: {
            description: 'クローンと各 runner への反映結果。',
            content: { 'application/json': { schema: resolver(profileUpdateResponseSchema) } },
          },
          400: {
            description: 'プロファイルが読めなかった（保存していない）。',
            content: { 'application/json': { schema: resolver(profileErrorResponseSchema) } },
          },
          403: {
            description: '実行環境の持ち主ではない。',
            content: { 'application/json': { schema: resolver(errorResponseSchema) } },
          },
        },
      }),
      requireOperator,
      validator('json', profileUpdateRequestSchema),
      async (c) => {
        // **クローンの道具（`profile_write`）とまったく同じ経路を通る。** 別々に
        // 書くと、片方だけに検査が入って「人間が置くと弾かれるのにクローンが置くと
        // 通る」が生まれる。ここは境界を確かめる場所なので、経路が2本あること自体が
        // 穴になる。
        if (deps.profile === undefined) {
          return c.json({ error: 'プロファイルの器が無い' as const, detail: '' }, 400);
        }
        const result = await deps.profile.apply(c.req.valid('json').script);

        if (!result.stored) {
          return c.json(
            {
              error: 'プロファイルが読めなかったので保存していない' as const,
              detail: [result.clone.error ?? '理由不明', result.clone.output ?? '']
                .join('\n')
                .trim(),
            },
            400,
          );
        }

        return c.json(
          profileUpdateResponseSchema.parse({
            updatedAt: result.updatedAt as string,
            ...(result.sha256 === undefined
              ? {}
              : { sha256: result.sha256, bytes: result.bytes as number }),
            clone: result.clone,
            runners: result.runners,
          }),
        );
      },
    )

    // --- 認証トークンのプール（/tokens） ------------------------------------
    // Issue #393「PR1 プールの器」。**回さない。** 検知も切替もここには無い。

    /**
     * プールの一覧と、回す契機・冷却の設定。
     *
     * **実行環境の持ち主だけ**（`requireOperator`）——課金の主体を決める操作
     * なので、`access grant` を通しただけのアカウントには開けない（`/profile`
     * と同じ強さ）。
     *
     * **値は決して出さない。** `TokenPoolService.list()` が返すのは
     * `AgentTokenView`（label と指紋だけ）で、`AgentToken`（`value` 付き）は
     * サービスの外へ一度も出ない。
     */
    .get(
      '/tokens',
      describeRoute({
        tags: ['tokens'],
        summary: '認証トークンのプールと設定を読む',
        description:
          'プールが空でも 200 を返し、既定の設定（`free_exhausted`）を返す' +
          '（受け入れ基準7: プールが空の既定構成の挙動を変えない）。',
        responses: {
          200: {
            description: 'プール（値は出さない）と設定。',
            content: { 'application/json': { schema: resolver(tokensResponseSchema) } },
          },
          403: {
            description: '実行環境の持ち主ではない。',
            content: { 'application/json': { schema: resolver(errorResponseSchema) } },
          },
        },
      }),
      requireOperator,
      async (c) => {
        if (deps.tokens === undefined) {
          return c.json(
            tokensResponseSchema.parse({ tokens: [], settings: DEFAULT_TOKEN_ROTATION_SETTINGS }),
          );
        }
        const { tokens, settings } = await deps.tokens.list();
        return c.json(tokensResponseSchema.parse({ tokens, settings }));
      },
    )

    /**
     * プールを全文置換する。**`value` を省略できる**——並べ替え・改名・
     * `disabled` の切り替えのたびに、他の行の秘密を貼り直さずに済む
     * （`agentTokenInputSchema` の doc）。
     *
     * `normalizeTokenPool` が投げたら 400 で理由を返す——**理由の本文にトークン
     * の値は含めない**（投げるメッセージは id / label だけを含む）。
     */
    .put(
      '/tokens',
      describeRoute({
        tags: ['tokens'],
        summary: '認証トークンのプールを全文置換する',
        description:
          '入力に無い行は消える。壊れた入力（新規行に value が無い・消えた id を' +
          '指す・id 重複）は 400 で理由を返し、保存しない。',
        responses: {
          200: {
            description: '置き換え後のプール（値は出さない）と設定。',
            content: { 'application/json': { schema: resolver(tokensResponseSchema) } },
          },
          400: {
            description: '入力が壊れている（保存していない）。',
            content: { 'application/json': { schema: resolver(errorResponseSchema) } },
          },
          500: {
            description:
              '保存に失敗した。**理由の本文は返さない**（ドライバの例外は失敗した' +
              'クエリの束縛パラメータを添えてくることがあるため）。跡は stderr に残る。',
            content: { 'application/json': { schema: resolver(errorResponseSchema) } },
          },
          403: {
            description: '実行環境の持ち主ではない。',
            content: { 'application/json': { schema: resolver(errorResponseSchema) } },
          },
        },
      }),
      requireOperator,
      /**
       * **既定の 400 を使わない。** `hook` を渡さないと
       * `@hono/standard-validator` は
       * `c.json({ data: <リクエスト本文そのもの>, error, success: false }, 400)`
       * を返す（実測 2026-08-24 観測、`@hono/standard-validator@0.4.0` の
       * `dist/index.mjs`。`sanitizeIssues` が見る `RESTRICTED_DATA_FIELDS` は
       * `header: ['cookie']` だけで、`json` は素通しになる）。
       *
       * **⟹ `label` を1つ書き忘れただけで、その回に送った *全部* の値が
       * 応答へ載る。** ここはトークンの本体を運ぶ唯一の口なので、既定の
       * 形をそのまま使えない。**どこが不正だったかは返す（`path` だけ）が、
       * 送られてきた本文は1文字も返さない。**
       */
      validator('json', tokensUpdateRequestSchema, (result, c) => {
        if (result.success) return;
        const where = result.error
          .map((issue) => issue.path?.map((part) => String(part)).join('.') ?? '')
          .filter((path) => path.length > 0)
          .join(', ');
        return c.json(
          {
            error:
              'トークンのプールの入力の形が不正（保存していない）' +
              (where === '' ? '' : `: ${where}`),
          },
          400,
        );
      }),
      async (c) => {
        if (deps.tokens === undefined) {
          return c.json({ error: 'トークンのプールの器が無い' as const }, 400);
        }
        try {
          const { tokens, settings } = await deps.tokens.replace(c.req.valid('json').tokens);
          return c.json(tokensResponseSchema.parse({ tokens, settings }));
        } catch (error) {
          // **返してよい例外だけを返す。型で分ける。**
          //
          // `TokenPoolInputError` は「`message` をそのまま応答へ返してよい」と
          // いう約束が型に付いている（`token-pool.ts` のその型の doc）。それ以外
          // ——保存の失敗——は**本文を1文字も返さない**。ドライバの例外は失敗した
          // クエリの束縛パラメータを添えてくるので（実測 2026-08-24 観測、
          // `drizzle-orm@0.45.2` の `PgPreparedQuery` が `Failed query: …` の
          // 次の行に `params: …` を置く）、素の `String(error)` を返すと
          // トークンの値がそのまま 400 の本文に載る。
          //
          // **`reasonOf` を通すだけにしないのは、それが偶然で効いているからである。**
          // `reasonOf` は1行目だけを採るので上の形では値が落ちるが、それは
          // ドライバがメッセージのどこで改行するかに依存していて、こちらが
          // 制御していない。**投げ直すのも駄目である**——`.onError` が無いので
          // 既定のハンドラへ回るだけで、本文を出さない保証がここから消える。
          if (error instanceof TokenPoolInputError) {
            return c.json({ error: error.message }, 400);
          }
          // **跡は残す。ただし本文は出さない**（`dropped-record.ts` の作法）。
          // detail は**本文を含まない見分け**だけ（`dropped-record.ts` の doc）。
          noteDroppedRecord(
            '認証トークンのプール',
            `count=${String(c.req.valid('json').tokens.length)}`,
            error,
          );
          return c.json({ error: 'トークンのプールを保存できなかった' as const }, 500);
        }
      },
    )

    /**
     * 回す契機・冷却の既定を変える。3つとも部分更新（省略した項目は現状維持）。
     *
     * **実行環境の持ち主だけ**（`/tokens` と同じ強さ）。
     */
    .put(
      '/tokens/policy',
      describeRoute({
        tags: ['tokens'],
        summary: '回す契機・冷却の既定を変える',
        description: '省略した項目は現状のまま変えない。',
        responses: {
          200: {
            description: '更新後の設定。',
            content: { 'application/json': { schema: resolver(tokenRotationSettingsSchema) } },
          },
          400: {
            description: 'トークンのプールの器が配線されていない。',
            content: { 'application/json': { schema: resolver(errorResponseSchema) } },
          },
          403: {
            description: '実行環境の持ち主ではない。',
            content: { 'application/json': { schema: resolver(errorResponseSchema) } },
          },
        },
      }),
      requireOperator,
      validator('json', tokensPolicyUpdateRequestSchema),
      async (c) => {
        if (deps.tokens === undefined) {
          return c.json({ error: 'トークンのプールの器が無い' as const }, 400);
        }
        const settings = await deps.tokens.setSettings(c.req.valid('json'));
        return c.json(tokenRotationSettingsSchema.parse(settings));
      },
    )

    // --- セッションログ（アーカイブ） --------------------------------------
    .get(
      '/archive',
      describeRoute({
        tags: ['archive'],
        summary: 'アーカイブ済みセッション生ログの一覧',
        description: 'セッション生ログ（可観測性の最下段）の id 一覧。',
        responses: {
          200: {
            description: 'アーカイブ id の一覧。',
            content: { 'application/json': { schema: resolver(archiveListResponseSchema) } },
          },
        },
      }),
      async (c) =>
        c.json(archiveListResponseSchema.parse({ entries: await stores.archive.list() })),
    )

    .get(
      '/archive/:id',
      describeRoute({
        tags: ['archive'],
        summary: 'アーカイブ済み生ログを1件読む',
        responses: {
          200: {
            description: '生ログ（JSONL の生テキスト）。',
            content: { 'text/plain': { schema: resolver(z.string()) } },
          },
          404: {
            description: '該当するアーカイブが無い。',
            content: { 'application/json': { schema: resolver(errorResponseSchema) } },
          },
        },
      }),
      async (c) => {
        const body = await stores.archive.read(c.req.param('id'));
        if (body === null) return c.json({ error: 'not found' as const }, 404);
        return c.text(body);
      },
    )

    // --- ログイン（/auth） --------------------------------------------------
    //
    // 経路はデーモンが持つ。ブラウザは**この口へ戻ってくるだけ**で、alteroid を
    // 操作する画面は無い（Web UI は非ゴール。`gh auth login` と同じ形である）。
    //
    // **規則: 宣言された成功応答（200/202）はすべて宣言スキーマの `.parse()` を
    // 通す。エラー応答（400/403/404/409）はその場のリテラルなので通さない。**
    // `/managers` `/managers/:id`（#61）と同じ理由 — `describeRoute` の
    // `resolver()` は spec を作るだけでハンドラの戻り値を検査しないので、通して
    // いない経路では宣言に無いフィールドが黙って外へ出る。ここで使う応答スキーマ
    // （`openapi.ts` の `accountViewSchema` 系）は core の永続化スキーマから
    // 独立させてあるので、account の行が増えても外へは載らない。

    .get(
      '/auth/providers',
      describeRoute({
        tags: ['auth'],
        summary: '使えるログイン手段の一覧',
        description:
          '設定されているログイン手段を返す。`enabled` が false なら認証を要求していない。',
        security: [],
        responses: {
          200: {
            description: 'ログイン手段の一覧。',
            content: { 'application/json': { schema: resolver(authProvidersResponseSchema) } },
          },
        },
      }),
      (c) =>
        c.json(
          authProvidersResponseSchema.parse({ enabled: authPlan.enabled, providers: providerList }),
        ),
    )

    .post(
      '/auth/login',
      describeRoute({
        tags: ['auth'],
        summary: 'ログインを始める',
        description:
          'ブラウザで開く認可 URL と、結果を引き取るための秘密（`claimSecret`）を返す。' +
          '**この経路は認証を要求しない** — ログインの前に持っている資格が無いのは当たり前で、' +
          'ここを閉じると誰も入れない。得られるのはアカウントの作成までで、' +
          '使う許可は別に人間が与える（`alteroid access grant`）。',
        security: [],
        responses: {
          200: {
            description: 'ログインを開始した。',
            content: { 'application/json': { schema: resolver(loginStartResponseSchema) } },
          },
          400: {
            description: '未知のログイン手段、または手段が1つも設定されていない。',
            content: { 'application/json': { schema: resolver(badRequestResponseSchema) } },
          },
        },
      }),
      validator('json', loginBody),
      async (c) => {
        const { provider, label } = c.req.valid('json');
        if (authPlan.providers.length === 0) {
          return c.json({ error: 'ログイン手段が設定されていない' as const }, 400);
        }
        const known = authPlan.providers.some((it) => it.id === provider);
        if (!known) return c.json({ error: `未知のログイン手段: ${provider}` }, 400);

        const started = await authService.startLogin({
          provider,
          label: label ?? '',
          redirectUri: callbackUrl(provider),
        });
        return c.json(loginStartResponseSchema.parse(started));
      },
    )

    .get(
      '/auth/:provider/callback',
      describeRoute({
        tags: ['auth'],
        summary: 'プロバイダからの戻り先',
        description:
          'ブラウザがここへ戻ってくる。応答は人間が読む HTML で、端末（CLI）側が ' +
          '`/auth/login/{requestId}/claim` で結果を引き取る。**トークンはここでは返さない** ' +
          '— ブラウザの履歴や Referer に鍵を載せないため。',
        security: [],
        responses: {
          200: {
            description: 'ログインの成否を人間に伝える画面。',
            content: { 'text/html': { schema: resolver(z.string()) } },
          },
        },
      }),
      async (c) => {
        const denied = c.req.query('error');
        if (denied !== undefined && denied.length > 0) {
          return c.html(
            callbackPage('ログインを中止しました', `プロバイダからの応答: ${denied}`),
            400,
          );
        }

        const code = c.req.query('code');
        const state = c.req.query('state');
        if (code === undefined || state === undefined) {
          return c.html(
            callbackPage('ログインに失敗しました', 'code と state が足りません。'),
            400,
          );
        }

        const result = await authService.completeLogin({ state, code });
        if (result.status === 'error') {
          return c.html(
            callbackPage('ログインに失敗しました', loginErrorDetail(result.reason)),
            400,
          );
        }
        return c.html(
          callbackPage(
            'ログインしました',
            result.granted
              ? 'この画面を閉じて端末に戻ってください。'
              : 'この画面を閉じて端末に戻ってください。なお、このアカウントにはまだ alteroid を使う許可がありません（alteroid access grant で付与します）。',
          ),
        );
      },
    )

    .post(
      '/auth/login/:requestId/claim',
      describeRoute({
        tags: ['auth'],
        summary: 'ログイン結果を引き取る',
        description:
          'ブラウザ側が終わっていればアクセストークンを返す。**返るのはこの1回だけ**で、' +
          'ストアには sha256 しか残らない。まだ終わっていなければ 202 と `pending`。',
        security: [],
        responses: {
          200: {
            description: 'トークンを発行した。',
            content: { 'application/json': { schema: resolver(loginClaimResponseSchema) } },
          },
          202: {
            description: 'まだブラウザ側が終わっていない。少し待って再試行する。',
            content: { 'application/json': { schema: resolver(loginClaimResponseSchema) } },
          },
          400: {
            description: '秘密が違う、期限切れ、または既に引き取り済み。',
            content: { 'application/json': { schema: resolver(badRequestResponseSchema) } },
          },
        },
      }),
      validator('json', claimBody),
      async (c) => {
        const result = await authService.claim({
          requestId: c.req.param('requestId'),
          claimSecret: c.req.valid('json').claimSecret,
        });
        if (result.status === 'pending') {
          return c.json(loginClaimResponseSchema.parse({ status: 'pending' as const }), 202);
        }
        if (result.status === 'error')
          return c.json({ error: claimErrorDetail(result.reason) }, 400);
        return c.json(
          loginClaimResponseSchema.parse({
            status: 'ready' as const,
            token: result.token,
            account: result.account,
            granted: isAccountGranted(result.account),
          }),
        );
      },
    )

    .get(
      '/auth/me',
      describeRoute({
        tags: ['auth'],
        summary: 'いま自分が誰として認識されているか',
        responses: {
          200: {
            description: '認証を通った相手。',
            content: { 'application/json': { schema: resolver(meResponseSchema) } },
          },
          401: {
            description: '資格が無い。',
            content: { 'application/json': { schema: resolver(errorResponseSchema) } },
          },
        },
      }),
      (c) => {
        const principal = c.get('principal');
        if (principal.kind === 'operator') {
          return c.json(meResponseSchema.parse({ kind: 'operator' as const }));
        }
        return c.json(
          meResponseSchema.parse({
            kind: 'account' as const,
            account: principal.account,
            granted: isAccountGranted(principal.account),
          }),
        );
      },
    )

    // --- アクセス許可（/access） --------------------------------------------
    //
    // **持つのは許可されているか否かの2値だけ。** 「chat は可・記憶の編集は不可」の
    // ような行為別のスコープを足したくなったら手を止める — それは PRD「権限境界」が
    // 禁じている「確認が要る行為の一覧」と同じ形であり、クローンの判断を設定で
    // 置き換えることになる。

    .get(
      '/access',
      describeRoute({
        tags: ['access'],
        summary: 'ログインしたアカウントと許可の一覧',
        description: '実行環境の持ち主だけが読める（メールと identity が並ぶため）。',
        responses: {
          200: {
            description: 'アカウントの一覧。',
            content: { 'application/json': { schema: resolver(accessListResponseSchema) } },
          },
          403: {
            description: '実行環境の持ち主ではない。',
            content: { 'application/json': { schema: resolver(errorResponseSchema) } },
          },
        },
      }),
      requireOperator,
      async (c) => {
        const accounts = await stores.auth.listAccounts();
        return c.json(
          accessListResponseSchema.parse({
            accounts: await Promise.all(accounts.map((account) => accountView(stores, account))),
          }),
        );
      },
    )

    .post(
      '/access/:accountId/grant',
      describeRoute({
        tags: ['access'],
        summary: 'alteroid を使う許可を与える',
        description:
          'ログインしただけでは使えない。ここで初めて使えるようになる。運ぶ情報は無い' +
          '（`{}` を送る）。\n\n' +
          '**許可できるアカウントは高々1つ。** alteroid は単一の持ち主のものであり、' +
          'マルチユーザー / チーム利用は非ゴールである（docs/PRD.md「スコープ外」）。' +
          '既に別のアカウントが許可されていれば 409 を返す — 持ち主を移すなら先に取り消す。',
        requestBody: noBodyPostRequestBody(
          '**中身は読まないので `{}` を送ればよい。** 本文そのものではなく ' +
            '`content-type: application/json` が要る（ブラウザの単純リクエストで持ち主を' +
            '足されないため）。',
        ),
        responses: {
          200: {
            description: '許可した（既に許可済みでも 200）。',
            content: { 'application/json': { schema: resolver(accessAccountResponseSchema) } },
          },
          403: {
            description: '実行環境の持ち主ではない。',
            content: { 'application/json': { schema: resolver(errorResponseSchema) } },
          },
          404: {
            description: '該当するアカウントが無い。',
            content: { 'application/json': { schema: resolver(errorResponseSchema) } },
          },
          409: {
            description: '既に別のアカウントが許可されている（先に revoke する）。',
            content: { 'application/json': { schema: resolver(errorResponseSchema) } },
          },
          ...noBodyPostResponses(),
        },
      }),
      requireOperator,
      deliberateClient,
      async (c) => {
        const result = await authService.grant(c.req.param('accountId'), 'operator');
        if (result.status === 'not_found') return c.json({ error: 'not found' as const }, 404);
        if (result.status === 'conflict') {
          return c.json(
            {
              error:
                `既に ${describeAccount(result.owner)} が許可されている。` +
                'alteroid は単一の持ち主のものなので、許可できるアカウントは1つだけ。' +
                `移すなら先に取り消す: alteroid access revoke ${result.owner.id}`,
            },
            409,
          );
        }
        // 誰を通したかは必ず残す。事後に追えることが「最終承認」の実体である
        // （PRD「可観測性」）。
        await stores.journal.append({
          type: 'decision',
          decision: `アクセス許可を付与: ${describeAccount(result.account)}`,
          grounds: '実行環境の持ち主による操作（alteroid access grant）',
        });
        return c.json(
          accessAccountResponseSchema.parse({ account: await accountView(stores, result.account) }),
        );
      },
    )

    .post(
      '/access/:accountId/revoke',
      describeRoute({
        tags: ['access'],
        summary: 'alteroid を使う許可を取り消す',
        description:
          '発行済みトークンは消さない。**許可はリクエストごとに見ているので、' +
          'これだけで即座に通らなくなる**（消し忘れたトークンが生き残らない）。運ぶ情報は' +
          '無い（`{}` を送る）。',
        requestBody: noBodyPostRequestBody(
          '**中身は読まないので `{}` を送ればよい。** 本文そのものではなく ' +
            '`content-type: application/json` が要る（ブラウザの単純リクエストで持ち主の' +
            '許可を落とされないため）。',
        ),
        responses: {
          200: {
            description: '取り消した（既に未許可でも 200）。',
            content: { 'application/json': { schema: resolver(accessAccountResponseSchema) } },
          },
          403: {
            description: '実行環境の持ち主ではない。',
            content: { 'application/json': { schema: resolver(errorResponseSchema) } },
          },
          404: {
            description: '該当するアカウントが無い。',
            content: { 'application/json': { schema: resolver(errorResponseSchema) } },
          },
          ...noBodyPostResponses(),
        },
      }),
      requireOperator,
      deliberateClient,
      async (c) => {
        const account = await authService.revoke(c.req.param('accountId'));
        if (account === null) return c.json({ error: 'not found' as const }, 404);
        await stores.journal.append({
          type: 'decision',
          decision: `アクセス許可を取り消し: ${describeAccount(account)}`,
          grounds: '実行環境の持ち主による操作（alteroid access revoke）',
        });
        return c.json(
          accessAccountResponseSchema.parse({ account: await accountView(stores, account) }),
        );
      },
    )

    .post(
      '/shutdown',
      describeRoute({
        tags: ['system'],
        summary: 'デーモンを止める',
        description: '`daemon stop` の受け口。運ぶ情報は無い（`{}` を送る）。',
        requestBody: noBodyPostRequestBody(
          '**中身は読まないので `{}` を送ればよい。** 本文そのものではなく ' +
            '`content-type: application/json` が要る（ブラウザの単純リクエストでデーモンを' +
            '止められないため）。',
        ),
        responses: {
          200: {
            description: '停止を受け付けた（実際の停止は少し遅れる）。',
            content: { 'application/json': { schema: resolver(okResponseSchema) } },
          },
          ...noBodyPostResponses(),
        },
      }),
      deliberateClient,
      (c) => {
        setTimeout(() => deps.shutdown(), 10);
        return c.json({ ok: true });
      },
    );

  // --- OpenAPI 自体の配信 ---------------------------------------------------
  //
  // **チェーンに載せない。** `.get(...)` をチェーンへ差し込むと、以降の
  // メソッドの型引数が積み重なって `AppType`（CLI の `hc<AppType>` が依存する
  // 型）の推論が壊れかねない。別文で呼んで `app` を返す（Issue #20 の指示）。
  //
  // `describeRoute` を付けていないので、この2本は spec に自動では載らない
  // （hono-openapi は describeRoute の無い経路を素通りする）。`exclude` は
  // その動作を明示するための二重の安全策である。
  app.get(
    '/openapi.json',
    openAPIRouteHandler(app, {
      documentation: openApiDocumentation,
      exclude: openApiExcludePaths,
    }),
  );
  app.get('/docs', Scalar({ url: '/openapi.json' }));

  return app;
}

export type AppType = ReturnType<typeof createApp>;
