import { randomUUID } from 'node:crypto';

import { Readable } from 'node:stream';
import type { ReadableStream as NodeWebReadableStream } from 'node:stream/web';
import type {
  AccountUsageState,
  PluginDistributionService,
  PluginFetcher,
  CloneHost,
  CredentialService,
  CodexChatgptAuthService,
  McpServerService,
  DelegatedPermissionRuleService,
  InboxEvent,
  ProfileService,
  RunnerRegistry,
  Scheduler,
  Stores,
  TokenPoolService,
} from '@alteroid/core';
import {
  createPluginPreviewStore,
  describeAttachmentAlreadyGoneRetraction,
  describeAttachmentForJournal,
  DAEMON_ATTACHMENT_USAGE_SOURCE,
  isAccountGranted,
  noteDroppedRecord,
  reasonOf,
  redactErrorText,
  integrationKeyLimits,
  looksLikeIntegrationKey,
  resolveIntegrationKey,
  type IntegrationKeyRecord,
  type AuthService,
} from '@alteroid/core';
import {
  AttachmentContentRemoveError,
  AttachmentCursorError,
  AttachmentRejectedError,
  ATTACHMENT_INTEGRATION_NOTICE_BYTES_DEFAULT,
  removeAttachmentCopy,
  type AttachmentLimits,
  writeStderrLine,
} from '@alteroid/core';
import { bearerOf, isOperator, type AuthPlan, type AuthVariables } from './auth.js';
import { createFixedWindowRateLimiter, judgeIntegrationRoute } from './integration-gate.js';
import { type JournalBus } from './journal-bus.js';
import { httpTimingMiddleware, type HttpTimingRecorder } from './http-timing.js';
import { Scalar } from '@scalar/hono-api-reference';
import { Hono, type Context, type Next } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { cors } from 'hono/cors';
import { createMiddleware } from 'hono/factory';
import { describeRoute, openAPIRouteHandler } from 'hono-openapi';
import { z } from 'zod';
import {
  attachmentErrorResponseSchema,
  attachmentKeptBodySchema,
  attachmentLimitsSchema,
  attachmentListQuery,
  attachmentListResponseSchema,
  attachmentMetaSchema,
  healthResponseSchema,
  statusResponseSchema,
  openApiDocumentation,
  openApiExcludePaths,
} from './openapi.js';
import { type WorkerToolBus } from './topology-activity.js';
import { createAppContext, principalRefOf } from './app-context.js';
import {
  mimeEssence,
  jsonResponse,
  errorResponse,
  journalWriteFailedResponse,
  jsonBody,
  queryParams,
  describeActor,
  appendJournalOrDrop,
  journalWriteFailedBody,
  kindOfError,
} from './app-shared.js';
import { adminRoutes } from './app-routes-admin.js';
import { memoryRoutes } from './app-routes-memory.js';
import { authRoutes } from './app-routes-auth.js';
import { workspaceRoutes } from './app-routes-workspace.js';
import { tokensRoutes } from './app-routes-tokens.js';
import { profileRoutes } from './app-routes-profile.js';
import { pluginsRoutes } from './app-routes-plugins.js';
import { credentialsRoutes } from './app-routes-credentials.js';
import { managersRoutes } from './app-routes-managers.js';
import { tasksRoutes } from './app-routes-tasks.js';
import { scheduleRoutes } from './app-routes-schedule.js';
import { approvalsRoutes } from './app-routes-approvals.js';
import { integrationRoutes } from './app-routes-integration.js';
import { journalRoutes } from './app-routes-journal.js';
import { practicesRoutes } from './app-routes-practices.js';
import { topologyRoutes } from './app-routes-topology.js';
import { conversationsRoutes } from './app-routes-conversations.js';
import { chatRoutes } from './app-routes-chat.js';

export { humanActionOf } from './app-shared.js';
// 外から叩かせるなら境界は手前（リバースプロキシ・トンネル・認証）に置く: 能力側で絞らず実行環境の境界で守る（north_star 禁止2）。
export interface AppDeps {
  clone: CloneHost;
  stores: Stores;
  token: string;
  shutdown: () => void;
  now?: () => Date;
  attachmentLimits?: AttachmentLimits;
  /** 要求ごとの時間の受け手（#5089）。無くても `Server-Timing` は付ける */
  httpTiming?: HttpTimingRecorder;
  scheduler?: Scheduler;
  storage?: string;
  // デーモンが鍵を保管しない（降ろすだけ）: 保管すると記憶の器に GitHub の書き込み権が並ぶため（railway/README.md「daemon 側には置かない」）。
  runners?: RunnerRegistry;
  cloneModel?: string;
  // 無ければその経路だけ 503: 配線されていないことを黙って隠さないため。
  journalEvents?: Pick<JournalBus, 'subscribe'>;
  // 日誌は通らない（プールが `WorkerToolBus` へ流す）。
  workerToolEvents?: Pick<WorkerToolBus, 'subscribe'>;
  // 無ければ `account` は `{ state: 'unknown' }`: 0 を返すと「枠を使っていない」と読めるため。
  accountUsage?: () => AccountUsageState;
  // ワイルドカードを受け付けない: `*` を許すと `deliberateClient` の前提（preflight が通らない）が消え、任意のページからクローンのターンを起こせる。
  // `credentials` を付けない: Cookie を運ばせない設計（資格情報はヘッダで運ぶ）。
  // `allowHeaders` は最小: `content-type` は `deliberateClient` が要求するので通すだけで、増やすなら理由が要る。
  allowedOrigins?: readonly string[];
  // 省略すると認証を要求しない: 設定していない人の `alteroid chat` が突然通らなくなる方が北極星に反するため。
  auth?: { plan: AuthPlan; service?: AuthService };
  // クローンの道具（`profile_write`）と同じインスタンスを渡す: 別々だと直列化が効かず、同時更新で層ごとに違う本文が残る。
  profile?: ProfileService;
  // マネージャーのプールと同じインスタンスを渡す（`profile` と同じ理由）。
  credentials?: CredentialService;
  // マネージャーのプールと同じインスタンスを渡す（`profile` と同じ理由）。渡さなければ保存だけして配らない（`runners: []`）。
  mcpServers?: McpServerService;
  // 委譲先の許可規則（#4952）。マネージャーのプールと同じインスタンスを渡す（`profile` と同じ理由）。渡さなければ取り消しを runner へ配らない（次の名乗りで降りる）。
  permissionRules?: DelegatedPermissionRuleService;
  pluginFetcher?: PluginFetcher;
  // マネージャーのプールと同じインスタンスを渡す（`profile` と同じ理由）。
  pluginDistribution?: PluginDistributionService;
  // マネージャーのプールと同じインスタンスを渡す（`profile` と同じ理由）。
  codexAuth?: CodexChatgptAuthService;
  // 回さない: ここが生やすのは器の読み書きの口だけで、検知・切替は無い。
  tokens?: TokenPoolService;
  // 無ければ `storage.state` は `unknown`: 確かめる手段が無いことを `ok` に化けさせない。毎リクエストでは叩かない。
  storageProbe?: () => Promise<void>;
  clearSessionLog?: () => Promise<number>;
  // 省略すれば写しは消さない: 写しは本体から取り出し直せる。
  attachmentCopiesDir?: string;
}

// `*` と、経路を含む値と、解釈できない値は捨てる: 緩めると「許可したつもりの範囲」と「実際に通る範囲」がずれ、境界が境界でなくなる。
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

    // `.origin` は経路を落とす: 元の文字列がオリジンそのものだったときだけ通し、打ち間違いを飲み込まない。
    const normalized = url.origin;
    if (normalized === 'null' || candidate.replace(/\/+$/, '') !== normalized) {
      rejected.push(candidate);
      continue;
    }
    if (!origins.includes(normalized)) origins.push(normalized);
  }

  return { origins, rejected };
}

const attachmentUploadQuery = z.object({
  keep: z
    .enum(['1', 'true', '0', 'false'])
    .transform((value) => value === '1' || value === 'true')
    .optional(),
  name: z.string().optional(),
  type: z.string().regex(/^[\w!#$&^.+-]+\/[\w!#$&^.+-]+(\s*;.*)?$/, 'MIME の形ではない'),
});

// 宣言された MIME は人間が決めた文字列なので、ヘッダに入れて壊れない形でなければ `application/octet-stream` に倒す。
const SAFE_MEDIA_TYPE = /^[\w!#$&^.+-]+\/[\w!#$&^.+-]+$/;

function attachmentDisposition(name: string): string {
  const fallback = name.replace(/[^\x20-\x7e]|["\\%]/g, '_');
  const encoded = encodeURIComponent(name).replace(
    /['()*]/g,
    (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

// `application/octet-stream` だけを受ける（`deliberateClient` と同じ考え方）: CORS の単純リクエストの content-type に入らず preflight が必ず要るので、任意のページから `no-cors` の fetch や form で添付を預けられない。`multipart` を受けないのも同じ理由。
const octetStreamClient = createMiddleware(async (c, next) => {
  if (mimeEssence(c.req.header('content-type')) !== 'application/octet-stream') {
    return c.json({ error: 'content-type: application/octet-stream が要る' as const }, 415);
  }
  await next();
});

const GONE_OR_EXPIRED_DESCRIPTION = '無い（消えた・期限切れ）。';

// `/auth/me` と `/auth/logout` だけは認証が要る: logout は提示している資格そのものを失効させる設計なので、提示なしに叩ける素通しの口にしない。
function isPublicPath(path: string): boolean {
  if (path === '/health' || path === '/openapi.json' || path === '/docs') return true;
  if (path === '/auth/me' || path === '/auth/logout') return false;
  return path === '/auth' || path.startsWith('/auth/');
}

/**
 * 連携の鍵1本あたりの、期限内の添付の預かりがこれを越えたら知らせる（#4005。オーナーの判断で 1GiB から始める）。
 * 既定値。実際の値は `ALTEROID_ATTACHMENT_INTEGRATION_NOTICE_BYTES` で変えられる（`readIntegrationAttachmentNoticeBytes`）
 */
export const INTEGRATION_ATTACHMENT_NOTICE_BYTES = ATTACHMENT_INTEGRATION_NOTICE_BYTES_DEFAULT;

/**
 * 連携の鍵が上げた添付で、その鍵の預かり（期限内）が閾値を越えたら、日誌とクローンへ1回知らせる（#4005）。
 * 断らない: 枠を置かないのがオーナーの決定で、これは決め直すための材料と契機である。
 * 状態を持たず「この1件で越えたか」だけを見る（上げる前は閾値未満・上げた後は閾値以上）: 越えるのは一度きりで、デーモンの再起動をまたいでも二度鳴らないため。
 * 掃除で下がってからもう一度越えれば、もう一度鳴る。
 */
export async function noteIntegrationAttachmentUsage(
  stores: Pick<Stores, 'attachments' | 'journal'>,
  post: (event: InboxEvent) => void,
  keyId: string,
  addedBytes: number,
  threshold: number = INTEGRATION_ATTACHMENT_NOTICE_BYTES,
): Promise<void> {
  let total: number;
  try {
    total = (await stores.attachments.usage()).byIntegrationKey[keyId]?.totalBytes ?? 0;
  } catch (error) {
    noteDroppedRecord('連携の鍵の添付の使用量', `keyId=${keyId}`, error);
    return;
  }
  const before = total - addedBytes;
  if (!(before < threshold && total >= threshold)) return;
  const text =
    `連携の鍵 ${keyId} が上げた添付の預かり（期限内）が ${String(total)} バイトになり、` +
    `閾値 ${String(threshold)} バイトを越えた。上げることは断っていない。` +
    '鍵ごとの内訳は GET /attachments の usage.byIntegrationKey で見られる。止めるなら、その鍵を失効させる。';
  await appendJournalOrDrop(
    stores,
    {
      type: 'decision',
      decision: text,
      grounds: `keyId=${keyId} totalBytes=${String(total)} threshold=${String(threshold)}`,
    },
    '連携の鍵の添付の閾値の知らせ',
    `keyId=${keyId}`,
  );
  post({
    type: 'external',
    id: randomUUID(),
    at: new Date().toISOString(),
    source: DAEMON_ATTACHMENT_USAGE_SOURCE,
    payload: { text, keyId, totalBytes: total },
  });
}

export function createApp(deps: AppDeps) {
  const ctx = createAppContext(deps);
  const {
    clone,
    stores,
    attachmentLimits,
    integrationAttachmentNoticeBytes,
    attachmentUploadSizeGate,
    authPlan,
    clock,
    authService,
    providerList,
  } = ctx;

  const integrationRateLimiter = createFixedWindowRateLimiter(() => clock().getTime());
  // 鍵の値は出さない（id だけ）。
  function noteIntegrationRefusal(
    c: Context,
    status: 401 | 403 | 413 | 429,
    why: string,
    keyId?: string,
  ): void {
    writeStderrLine(
      `alteroid: 連携の鍵の要求を断った（${String(status)}、${why}）: ` +
        `${c.req.method} ${c.req.path}${keyId === undefined ? '' : ` keyId=${keyId}`}\n`,
    );
  }

  // 通す条件は2つだけ（実行環境の持ち主の token・許可されたアカウントのアクセストークン）: 行為ごとの許可表を持たない。持つと「確認が要る行為の一覧」と同じ形になり、クローンの判断を設定で置き換えることになる。
  const authenticate = createMiddleware<{ Variables: AuthVariables }>(async (c, next) => {
    if (isOperator(c, deps.token)) {
      c.set('principal', { kind: 'operator', auth: 'operator-token' });
      await next();
      return;
    }
    // 認証が無効の構成でも `altk_` の bearer が付いていれば照合と制限を掛ける（bearer が無ければ素通し）。
    if (!isPublicPath(c.req.path)) {
      const presented = bearerOf(c.req.header('authorization'));
      if (presented !== null && looksLikeIntegrationKey(presented)) {
        return authenticateIntegrationKey(c, next, presented);
      }
    }
    if (!authPlan.enabled) {
      // 守りは待ち受け先（既定 127.0.0.1）と手前に置く境界の側にある。
      c.set('principal', { kind: 'operator', auth: 'disabled' });
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
    // `POST /auth/logout` だけは許可の無いアカウントも通す: 403 にすると許可待ちのトークンが失効させられず、後から `access grant` した瞬間に捨てたつもりのトークンが生き返る（CLI の `logout` も 403 を失敗と読む）。logout は提示したトークン自身を失効させるだけなので何も許さない。
    if (!isAccountGranted(account) && c.req.path !== '/auth/logout') {
      // 401 ではなく 403: やり直しても解決しない（人間が `access grant` を実行する）。
      return c.json({ error: 'このアカウントには alteroid を使う許可が無い' }, 403);
    }
    c.set('principal', { kind: 'account', account });
    await next();
  });

  // 既定で拒否し、この資格にだけ制限を掛ける（人間・operator の経路に新しい制限は足さない）。通すのは `POST /events`（source の一致はハンドラが判定）・`POST /events/:source` と、添付のアップロード `POST /attachments`（読み出しは通さない）だけ。`maxBodyBytes` は `/events*` にだけ掛ける: 添付のアップロードにも掛けると 1 MiB 超の画像を上げられず添付の意味が無い。断った試みは日誌に書かずデーモンのログへ。
  async function authenticateIntegrationKey(
    c: Context<{ Variables: AuthVariables }>,
    next: Next,
    presented: string,
  ): Promise<Response | void> {
    const refuse = (status: 401 | 403 | 413 | 429, why: string, key?: IntegrationKeyRecord) => {
      noteIntegrationRefusal(c, status, why, key?.id);
    };
    const key = await resolveIntegrationKey({
      store: stores.integrationKeys,
      bearer: presented,
      now: clock(),
    });
    if (key === null) {
      refuse(401, '未知・失効・期限切れ');
      return c.json({ error: '連携の鍵が無効か期限切れ' as const }, 401);
    }
    const limits = integrationKeyLimits(key);
    c.set('principal', {
      kind: 'integration',
      keyId: key.id,
      name: key.name,
      source: key.source,
      limits,
    });
    const routeVerdict = judgeIntegrationRoute(c.req.method, c.req.path, key.source);
    if (!routeVerdict.allowed) {
      refuse(403, 'この鍵が通れない口');
      return c.json(
        {
          error:
            'この連携の鍵では、この操作はできない（固定の source への外部イベントと、それに付ける添付のアップロードだけ）' as const,
        },
        403,
      );
    }
    const verdict = integrationRateLimiter.consume(key.id, limits.ratePerMinute);
    if (!verdict.ok) {
      refuse(429, '回数の上限', key);
      c.header('Retry-After', String(verdict.retryAfterSeconds));
      return c.json(
        { error: '連携の鍵の回数の上限を超えた（Retry-After の後でやり直す）' as const },
        429,
      );
    }
    // 添付のアップロードの本文上限は、その口自身の `attachmentUploadSizeGate`（と置き場の流しながらの数え）が持つ。
    if (routeVerdict.via === 'attachment-upload') {
      await next();
      return;
    }
    return bodyLimit({
      maxSize: limits.maxBodyBytes,
      onError: (ctx) => {
        refuse(413, '本文の上限', key);
        return ctx.json({ error: '本文が連携の鍵の上限を超えた' as const }, 413);
      },
    })(c, next);
  }

  // 経路の本数をここで数え直さない: 数え上げの持ち主は `scripts/require-operator-routes.test.ts` の `EXPECTED_OPERATOR_ROUTES`。いまこの門を付けた経路は無い（#2948 で持ち主の宣言の口を畳んだ）。門そのものは、応答本文に鍵が丸ごと載るか実行環境そのものを差し替える口を作るときのために残してある。
  // 配線した経路がいまは無いので未使用になる（#2948）。門そのものは残す。外すと、実行環境そのものを差し替える口を作り直すときに門から書き直すことになる。
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const requireOperator = createMiddleware<{ Variables: AuthVariables }>(async (c, next) => {
    if (c.get('principal').kind !== 'operator') {
      return c.json({ error: '実行環境の持ち主だけが操作できる' as const }, 403);
    }
    await next();
  });

  // 確定は取り直さず預かったものをそのまま保存する: 確認から確定までに取り元が動いても、見せたものと入れるものがずれない。
  const pluginPreviews = createPluginPreviewStore();

  // 二重の門: `authenticate` が既定で拒否するが、配線のずれ・将来の変更で鍵が管理の口へ入れないよう口の側でも断る（鍵が仲間の鍵を発行・失効できたら配布範囲の境界が崩れる）。
  const humanOnly = createMiddleware<{ Variables: AuthVariables }>(async (c, next) => {
    if (c.get('principal').kind === 'integration') {
      return c.json({ error: '連携の鍵では、鍵の管理はできない' as const }, 403);
    }
    await next();
  });

  const base = new Hono<{ Variables: AuthVariables }>();

  // hono の既定のハンドラの `console.error(err)` を使わない: 例外を丸ごと stderr へ出すので、リクエストの値を抱えた例外（`fetch` / DB ドライバ / `execFile`）がそのまま器の外へ出る。`reasonOf` は既存の口をそのまま使う: 同じ判断（1行目だけ・200字）を2箇所に持つとずれる。
  base.onError(async (err, c) => {
    if ('getResponse' in err) {
      const res = err.getResponse();
      // hono の validator が壊れた JSON に投げる `HTTPException` は `text/plain` で `jsonBody` の `hook` には届かないので、`text/plain` のときだけ `{ error }` の JSON に畳む。
      if ((res.headers.get('content-type') ?? '').startsWith('text/plain')) {
        const message = await res.text();
        return c.json({ error: message === '' ? res.statusText : message }, res.status as 400);
      }
      return c.newResponse(res.body, res);
    }
    writeStderrLine(
      `alteroidd: HTTP 経路で例外を捕まえました（本文は出しません）: ${reasonOf(err)}\n`,
    );
    return c.json({ error: 'Internal Server Error' }, 500);
  });

  base.notFound((c) => c.json({ error: 'not found' }, 404));

  // 時間の計測は CORS・認証より前に置く: 認証の DB 引きも、preflight も、その要求の時間として数えるため（#5089）
  base.use('*', httpTimingMiddleware(deps.httpTiming));

  // CORS は認証より先に登録する: preflight（OPTIONS）は `Authorization` を積んで来ないので、門番が先に立つと 401 になり本リクエストが飛ばない。`cors()` は OPTIONS に答えて `next()` を呼ばないので門番も素通りしない。列挙が空なら何も登録しない（CORS ヘッダを返さない姿勢のまま）。
  const allowedOrigins = deps.allowedOrigins ?? [];
  if (allowedOrigins.length > 0) {
    base.use(
      '*',
      cors({
        // `*` は返さない（`AppDeps` の注記）。
        origin: (origin) => (allowedOrigins.includes(origin) ? origin : null),
        // 新しいメソッドの経路を足したらここも一緒に見る: 更新し忘れると、別オリジンの画面からの操作だけが preflight に静かに落とされる（`app.test.ts` の「アプリが出しているメソッドは全部 CORS が許している」が拾う）。
        allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
        // `content-type` は `deliberateClient` が、`authorization` は門番が要求する: 後者を落とすと別オリジンの画面はログイン済みでも何も呼べない。
        allowHeaders: ['content-type', 'authorization'],
        // Cookie は運ばせない。資格情報はヘッダで運ぶ。
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
          'デーモンが応答しているかと、その pid・認証の状態を返す。' +
          '**記憶の置き場は返さない**（無認証で読める応答に、内部のホスト名・DB 名・ホームのパスを' +
          '置かない。#2869）。認証の要る `GET /status` が返す。' +
          '`Authorization: Bearer <state/daemon.json の token>` を添えると `operator` が ' +
          'true になり、CLI はこれで「自分が起こしたデーモンか」を確かめる（PID は信用しない）。' +
          '**トークンそのものは返さない** — この値は許可を付与できる資格そのものなので、' +
          '無認証で読める応答には置けない。',
        security: [],
        responses: {
          200: jsonResponse('応答している。', healthResponseSchema),
        },
      }),
      (c) =>
        c.json({
          ok: true,
          pid: process.pid,
          operator: isOperator(c, deps.token),
          auth: { enabled: authPlan.enabled, providers: providerList },
        }),
    )

    // `isPublicPath` に入れない: 内部のホスト名・DB 名・ホームのパスは、ログインしていない相手に読ませない。
    .get(
      '/status',
      describeRoute({
        tags: ['system'],
        summary: 'デーモン自身の説明（記憶の置き場。資格が要る）',
        description:
          '記憶の置き場（PostgreSQL なら `host:port/db`、ファイルなら記憶ディレクトリのパス）を返す。' +
          '接続情報（パスワード等）は含めない。無認証の `GET /health` は置き場を返さないので、' +
          '置き場を知りたい呼び出し元はログインの後ろのここから取る。',
        responses: {
          200: jsonResponse('認証を通った相手への説明。', statusResponseSchema),
          401: errorResponse('資格が無い。'),
        },
      }),
      (c) => {
        const refusal = clone.sessionRefusal?.() ?? null;
        return c.json(
          statusResponseSchema.parse({
            storage: deps.storage ?? '',
            ...(refusal === null ? {} : { cloneSessionRefusal: refusal }),
          }),
        );
      },
    )

    .post(
      '/attachments',
      describeRoute({
        tags: ['attachments'],
        summary: '添付を預かる（生のバイト列）',
        description:
          '本文は**生のバイト列**で、名前と MIME はクエリ（`name` / `type`）で運ぶ。' +
          '**`content-type` は `application/octet-stream` だけを受ける**（それ以外は 415）——' +
          'CORS の単純リクエストにさせず、ブラウザが必ず preflight を通すため（`deliberateClient` と同じ考え）。' +
          '認証は他の経路と同じ。本文の上限は添付1つぶんの最大値（超えたら 413）。画像（png / jpeg / webp / gif）は' +
          '宣言と中身の先頭が一致しなければ 400。宣言が画像で、幅か高さが 8000 px を超えるものも 400（`code`: `image_dimension_too_large`。' +
          '寸法が読めないものは通す。宣言が画像以外ならこの検査は掛からず、ターンでファイルとして渡る）。0バイトの本文も 400（`code`: `empty`。Web・CLI・TUI と揃えて断る）。返った `id` を `POST /chat` の `attachments` に渡すと発言へ結び付く。' +
          '結び付けないまま 1 時間たったものは掃除される。' +
          'クエリ `keep=1` を付けると、預けた時点で保存の印が付く（期限なし。未結び付けの掃除にも掛からない。' +
          '外すのは `PATCH /attachments/:id`、消すのは `DELETE /attachments/:id`）。**連携の鍵は `keep` を付けられない**（403）。' +
          '**連携の鍵（`altk_`）もこの口だけは通れる**（自分の外部イベントに付ける添付を上げるため。#3113 段3）：' +
          '`uploadedBy` は `integration:<keyId>` になり、その鍵が `POST /events` で付けられるのは自分が上げた添付だけ。' +
          '本文の上限は鍵の `maxBodyBytes` ではなく添付の上限（上記）に従い、1 回として鍵の回数（429）に数える。' +
          '鍵は添付を読み出せない（`GET /attachments/:id` は 403）。',
        requestBody: {
          required: true,
          description: '添付の中身（生のバイト列）。',
          content: {
            'application/octet-stream': { schema: { type: 'string', format: 'binary' } },
          },
        },
        responses: {
          200: jsonResponse('預かった。控え（中身を含まない）を返す。', attachmentMetaSchema),
          400: jsonResponse(
            'クエリが不正、または受け付けない中身（`code`: `magic_mismatch` / `image_dimension_too_large` / `media_type_missing` / `empty`＝0バイト）。',
            attachmentErrorResponseSchema,
          ),
          413: jsonResponse('大きすぎる（`code`: `too_large`）。', attachmentErrorResponseSchema),
          403: errorResponse('連携の鍵が `keep` を付けた（鍵は保存の印を付けられない）。'),
          415: errorResponse('content-type が application/octet-stream ではない。'),
        },
      }),
      octetStreamClient,
      attachmentUploadSizeGate,
      queryParams(attachmentUploadQuery),
      async (c) => {
        const { name, type, keep } = c.req.valid('query');
        const principal = c.get('principal');
        // 連携の鍵は保存の印を付けられない: 期限なしで預けられると、鍵ごとの預け量の枠が無い前提が崩れるため
        if (keep === true && principal.kind === 'integration') {
          return c.json(
            {
              error: '連携の鍵は保存の印（keep）を付けられない（期限なしで預けられない）' as const,
            },
            403,
          );
        }
        // 本文は流したまま置き場へ渡す（上限は置き場が流しながら数える）。
        const raw = c.req.raw.body;
        const body: AsyncIterable<Uint8Array> =
          raw === null ? Readable.from([]) : Readable.fromWeb(raw as NodeWebReadableStream);
        try {
          const meta = await stores.attachments.putStream({
            name: name ?? '',
            mediaType: type,
            body,
            ...(keep === true ? { kept: true } : {}),
            uploadedBy: principalRefOf(c.get('principal')),
          });
          if (principal.kind === 'integration') {
            // 応答を待たせない: 知らせは上げた結果を変えず、使用量の集計の時間を鍵の呼び手へ負わせないため
            void noteIntegrationAttachmentUsage(
              stores,
              (event) => clone.post(event),
              principal.keyId,
              meta.size,
              integrationAttachmentNoticeBytes,
            );
          }
          return c.json(meta, 200);
        } catch (error) {
          if (error instanceof AttachmentRejectedError) {
            // `reasonOf` ではなく `redactErrorText`: `reasonOf` は型名と code で包むので、Web・CLI・TUI がそのまま出す理由に混ざる。伏せ字は外さない。
            return c.json(
              { error: redactErrorText(error.message, process.env), code: error.code },
              error.code === 'too_large' ? 413 : 400,
            );
          }
          throw error;
        }
      },
    )

    // `/attachments/limits` と `/attachments/:id` より前に置く: あとから足す経路で取り違えない並びを固定する（Hono は定義順に当てる）。
    .get(
      '/attachments',
      describeRoute({
        tags: ['attachments'],
        summary: '添付の一覧と使用量',
        description:
          '預かっている添付の控え（中身を含まない）を新しい順に返す。期限切れは含まない。' +
          '会話（`conversationId`）・出所（`from`: `human` / `clone` / `manager` / `integration` / `unknown`）・' +
          '保存の有無（`kept`）・名前の部分一致（`q`。大文字小文字を問わない）で絞れる。' +
          '`limit` は既定 50・上限 200。続きがあるときだけ `nextCursor` が付く（次の呼び出しの `cursor` に渡す）。' +
          '`usage` は絞り込みに関わらず、期限内の全体の使用量（合計と出所ごと）。' +
          '**保存した添付に期限は無く、全体の容量の上限も置かない**——使用量を見て、不要なものを消すのは人間とクローンの判断である。' +
          '連携の鍵は 403（鍵は上げるだけで、預かったものを見られない）。',
        responses: {
          200: jsonResponse('控えの一覧と使用量。', attachmentListResponseSchema),
          400: errorResponse('クエリが不正（`cursor` が読めない、`limit` が範囲外など）。'),
        },
      }),
      queryParams(attachmentListQuery),
      async (c) => {
        const query = c.req.valid('query');
        let page;
        try {
          page = await stores.attachments.list({
            limit: query.limit,
            ...(query.kept === undefined ? {} : { kept: query.kept }),
            ...(query.from === undefined ? {} : { from: query.from }),
            ...(query.conversationId === undefined ? {} : { conversationId: query.conversationId }),
            ...(query.q === undefined ? {} : { q: query.q }),
            ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
          });
        } catch (error) {
          if (error instanceof AttachmentCursorError) {
            return c.json({ error: '入力の形が不正: cursor' as const }, 400);
          }
          throw error;
        }
        const usage = await stores.attachments.usage();
        return c.json(attachmentListResponseSchema.parse({ ...page, usage }));
      },
    )

    // `/attachments/:id` より前に置く: `limits` を id と取り違えない。
    .get(
      '/attachments/limits',
      describeRoute({
        tags: ['attachments'],
        summary: '添付の上限（このデーモンが実際に使っている値）',
        description:
          '環境変数（`ALTEROID_ATTACHMENT_MAX_*`）で変えた値を含む、`POST /attachments` と `POST /chat` が' +
          '実際に使っている上限を返す。CLI・TUI・Web が送る前の検査に使う（最終判定はこのデーモン）。' +
          '認証は他の経路と同じ（連携の鍵は 403）。',
        responses: {
          200: jsonResponse('上限。', attachmentLimitsSchema),
        },
      }),
      (c) => c.json(attachmentLimitsSchema.parse(attachmentLimits)),
    )

    .get(
      '/attachments/:id/meta',
      describeRoute({
        tags: ['attachments'],
        summary: '添付の控え（メタデータだけ）',
        description: '中身を読まずに、名前・MIME・大きさ・sha256・結び付き・期限を返す。',
        responses: {
          200: jsonResponse('控え。', attachmentMetaSchema),
          404: errorResponse(GONE_OR_EXPIRED_DESCRIPTION),
        },
      }),
      async (c) => {
        const meta = await stores.attachments.getMeta(c.req.param('id'));
        if (meta === undefined) return c.json({ error: 'not found' as const }, 404);
        return c.json(meta);
      },
    )

    .get(
      '/attachments/:id',
      describeRoute({
        tags: ['attachments'],
        summary: '添付の中身を返す',
        description:
          '預かった中身をそのまま返す。`content-type` は控えの MIME。**`content-disposition: attachment`**' +
          '（ファイル名は RFC 5987）と **`x-content-type-options: nosniff`** を付ける——人間が上げた中身を' +
          'ブラウザがこのオリジンの文書として開かないため。',
        responses: {
          200: {
            description: '中身。',
            content: {
              'application/octet-stream': { schema: { type: 'string', format: 'binary' } },
            },
          },
          404: errorResponse(GONE_OR_EXPIRED_DESCRIPTION),
        },
      }),
      async (c) => {
        const found = await stores.attachments.open(c.req.param('id'));
        if (found === undefined) return c.json({ error: 'not found' as const }, 404);
        const { meta, stream } = found;
        return c.body(Readable.toWeb(stream) as ReadableStream, 200, {
          'content-type': SAFE_MEDIA_TYPE.test(meta.mediaType)
            ? meta.mediaType
            : 'application/octet-stream',
          'content-length': String(meta.size),
          'content-disposition': attachmentDisposition(meta.name),
          'x-content-type-options': 'nosniff',
        });
      },
    )

    .patch(
      '/attachments/:id',
      describeRoute({
        tags: ['attachments'],
        summary: '添付の保存の印を付ける・外す',
        description:
          '`kept: true` で保存の印を付ける（期限を持たなくなり、期限でも未結び付け 1 時間の掃除でも消えない）。' +
          '`kept: false` で外す（外した時刻から保持日数後が期限になる）。すでにその状態なら何も変えない。' +
          '更新後の控えを返す。連携の鍵は 403。',
        responses: {
          200: jsonResponse('更新後の控え。', attachmentMetaSchema),
          400: errorResponse('本文が不正（`kept` は真偽値）。'),
          404: errorResponse(GONE_OR_EXPIRED_DESCRIPTION),
        },
      }),
      jsonBody(attachmentKeptBodySchema),
      async (c) => {
        const { kept } = c.req.valid('json');
        const meta = await stores.attachments.setKept(c.req.param('id'), kept, clock());
        if (meta === undefined) return c.json({ error: 'not found' as const }, 404);
        return c.json(meta);
      },
    )

    .delete(
      '/attachments/:id',
      describeRoute({
        tags: ['attachments'],
        summary: '添付を消す（保存したものも）',
        description:
          '預かっている中身と控えを消す。保存の印が付いていても消す。`attachment_fetch` で取り出した写しも消す。' +
          '取り消せない。連携の鍵は 403。' +
          '消す前に、控え（id・名前・種類・大きさ・sha256・出所・保存中だったか。中身は書かない）と誰が消したかを日誌（`decision`）へ残す' +
          '（クローンの `file_delete` と同じ）。日誌に書けなければ消さずに 500 を返す。' +
          '外部の置き場に預けた中身は先に消す: 消せなかったとき（置き場の障害・設定が無い）は、消さずに 503 で断り（控えも残す）、理由を返す。もう一度消すと再試行する。',
        responses: {
          204: { description: '消した（中身が消えたときだけ）。' },
          404: errorResponse(GONE_OR_EXPIRED_DESCRIPTION),
          500: journalWriteFailedResponse(
            '日誌が書けなかった（**消していない**。中身も控えも残っている）。',
          ),
          503: errorResponse(
            '中身を置き場から消せなかったので、消していない（控えも残した）。本文の `error` に理由。もう一度消すと再試行する。',
          ),
        },
      }),
      async (c) => {
        const id = c.req.param('id');
        const actor = `${describeActor(c.get('principal'))}（DELETE /attachments/:id）`;
        // 消す前に控えを日誌へ書き、書けなければ消さずに 500（#5280）: 消した後では名前も大きさも sha256 も辿れない（`file_delete` と同じ順序）。
        // 控えが無い（404 になる）回は書かない: 消すものが無い
        const meta = await stores.attachments.getMeta(id);
        if (meta !== undefined) {
          try {
            await stores.journal.append({
              type: 'decision',
              decision: `添付の中身と控えを消す: ${meta.name}（id=${meta.id}）`,
              grounds: `${actor}。消す前の控え: ${describeAttachmentForJournal(meta)}`,
            });
          } catch (error) {
            noteDroppedRecord('添付の削除の日誌（消していない）', `id=${id}`, kindOfError(error));
            return c.json(journalWriteFailedBody(), 500);
          }
        }
        let removed: boolean;
        try {
          removed = await stores.attachments.remove(id);
        } catch (error) {
          if (!(error instanceof AttachmentContentRemoveError)) throw error;
          // 断ったことを日誌に残す（先に書いた「消す」の行だけでは、消したように読まれるため）。書けなくても断りは変えない。
          await appendJournalOrDrop(
            stores,
            {
              type: 'decision',
              decision: `添付を消せなかった（中身を置き場から消せないので、消していない。控えも残した）: ${meta === undefined ? '' : `${meta.name}、`}id=${id}`,
              grounds:
                `${actor}。理由: ${error.reason}。` +
                (meta === undefined ? '' : '直前の「消す」の行は実行されていない。') +
                'もう一度消すと再試行する。',
            },
            '添付の削除の断りの日誌',
            `id=${id}`,
          );
          return c.json(
            {
              error: `中身を置き場から消せなかったので消していない（控えも残した）。理由: ${error.reason}。もう一度消すと再試行する`,
            },
            503,
          );
        }
        // 写しは本体が無かったときも消す: 本体だけ先に消えて取り残された写しを片付ける。
        if (deps.attachmentCopiesDir !== undefined) {
          await removeAttachmentCopy(deps.attachmentCopiesDir, id);
        }
        if (!removed) {
          // 控えを読んだ後に別の手で消えていた回: 先に書いた「消す」の行はこの呼びでは実行されていない
          if (meta !== undefined) {
            await appendJournalOrDrop(
              stores,
              { type: 'decision', ...describeAttachmentAlreadyGoneRetraction(meta, actor) },
              '添付の削除の打ち消しの日誌',
              `id=${id}`,
            );
          }
          return c.json({ error: 'not found' as const }, 404);
        }
        return c.body(null, 204);
      },
    )

    .route('/', chatRoutes(ctx))

    .route('/', conversationsRoutes(ctx))

    .route('/', topologyRoutes(ctx, deps))

    .route('/', memoryRoutes(ctx))

    .route('/', practicesRoutes(ctx))

    .route('/', journalRoutes(ctx, deps))

    .route('/', approvalsRoutes(ctx, deps))

    .route('/', integrationRoutes(ctx, humanOnly, noteIntegrationRefusal))

    .route('/', scheduleRoutes(ctx, deps))

    .route('/', tasksRoutes(ctx))

    .route('/', managersRoutes(ctx, deps))

    .route('/', profileRoutes(deps))

    .route('/', pluginsRoutes(deps, pluginPreviews))

    .route('/', credentialsRoutes(deps))

    .route('/', tokensRoutes(deps))

    .route('/', workspaceRoutes(ctx))

    .route('/', authRoutes(ctx))

    .route('/', adminRoutes(ctx, deps));

  // チェーンに載せない: `.get(...)` を差し込むと以降の型引数が積み重なり `AppType`（CLI の `hc<AppType>` が依存する型）の推論が壊れかねない。`exclude` は describeRoute の無い経路が spec に載らない動作を明示する二重の安全策。
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
