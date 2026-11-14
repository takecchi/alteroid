import type {
  AccountUsageState,
  PluginDistributionService,
  PluginFetcher,
  CloneHost,
  CredentialService,
  CodexChatgptAuthService,
  McpServerService,
  DelegatedPermissionRuleService,
  ProfileService,
  RunnerRegistry,
  Scheduler,
  Stores,
  TokenPoolService,
  ManualTokenTry,
} from '@alteroid/core';
import {
  createPluginPreviewStore,
  isAccountGranted,
  reasonOf,
  integrationKeyLimits,
  looksLikeIntegrationKey,
  resolveIntegrationKey,
  type IntegrationKeyRecord,
  type AuthService,
} from '@alteroid/core';
import { type AttachmentLimits, writeStderrLine } from '@alteroid/core';
import { bearerOf, isOperator, type AuthPlan, type AuthVariables } from './auth.js';
import { createFixedWindowRateLimiter, judgeIntegrationRoute } from './integration-gate.js';
import { type JournalBus } from './journal-bus.js';
import { httpTimingMiddleware, type HttpTimingRecorder } from './http-timing.js';
import { Scalar } from '@scalar/hono-api-reference';
import { Hono, type Context, type Next } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { cors } from 'hono/cors';
import { createMiddleware } from 'hono/factory';
import { openAPIRouteHandler } from 'hono-openapi';
import { openApiDocumentation, openApiExcludePaths } from './openapi.js';
import { type WorkerToolBus } from './topology-activity.js';
import { createAppContext } from './app-context.js';
import { systemRoutes } from './app-routes-system.js';
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
import { mcpRoutes } from './app-routes-mcp.js';
import { journalRoutes } from './app-routes-journal.js';
import { practicesRoutes } from './app-routes-practices.js';
import { topologyRoutes } from './app-routes-topology.js';
import { conversationsRoutes } from './app-routes-conversations.js';
import { chatRoutes } from './app-routes-chat.js';
import { attachmentsRoutes } from './app-routes-attachments.js';

export { humanActionOf } from './app-shared.js';
// 外から叩かせるなら境界は手前（リバースプロキシ・トンネル・認証）に置く: 能力側で絞らず実行環境の境界で守る（north_star 禁止2）。
export interface AppDeps {
  clone: CloneHost;
  stores: Stores;
  token: string;
  shutdown: () => void;
  now?: () => Date;
  // `now` と同じ差し替え口: `/usage` の `ledgerTimeZone` が読む TZ 名の解決（既定は実行時の `Intl`）。テストが TZ の取れない状態を作るため
  resolveTimeZone?: () => string | undefined;
  attachmentLimits?: AttachmentLimits;
  /** 要求ごとの時間の受け手（#5089）。無くても `Server-Timing` は付ける */
  httpTiming?: HttpTimingRecorder;
  scheduler?: Scheduler;
  storage?: string;
  // デーモンが鍵を保管しない（降ろすだけ）: 保管すると記憶の器に GitHub の書き込み権が並ぶため（railway/README.md「daemon 側には置かない」）。
  runners?: RunnerRegistry;
  cloneModel?: string;
  // クローンのセッションが使っている鍵の id（#6646。ホームの地図の札に出す）。無ければ地図はクローンの鍵を言わない
  cloneTokenId?: () => string | undefined;
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
  // 鍵を1回試す口（人間の手動。`startTokenTrialWatch` の自動の試しとは間隔を共有しない）。無ければ `POST /tokens/:id/try` は 400
  tokenTry?: ManualTokenTry;
  // 鍵ごとの枠の観測（#6633）。無ければ `GET /tokens` は `loads` を載せない
  tokenLoads?: () => readonly { tokenId: string; state: AccountUsageState }[];
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

// `/auth/me` と `/auth/logout` だけは認証が要る: logout は提示している資格そのものを失効させる設計なので、提示なしに叩ける素通しの口にしない。
function isPublicPath(path: string): boolean {
  if (path === '/health' || path === '/openapi.json' || path === '/docs') return true;
  if (path === '/auth/me' || path === '/auth/logout') return false;
  return path === '/auth' || path.startsWith('/auth/');
}

export function createApp(deps: AppDeps) {
  const ctx = createAppContext(deps);
  const { stores, authPlan, clock, authService } = ctx;

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

  // 既定で拒否し、この資格にだけ制限を掛ける（人間・operator の経路に新しい制限は足さない）。通すのは `POST /events`（source の一致はハンドラが判定）・`POST /events/:source`・MCP の報告 `POST /mcp`（道具は `report_problem` と `report_diagnostics_summary` の2本だけ。source は鍵の source に固定）と、添付のアップロード `POST /attachments`（読み出しは通さない）だけ。`maxBodyBytes` は添付のアップロード以外（`/events*` と `/mcp`）に掛ける: 添付のアップロードにも掛けると 1 MiB 超の画像を上げられず添付の意味が無い。断った試みは日誌に書かずデーモンのログへ。
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
            'この連携の鍵では、この操作はできない（固定の source への外部イベントと、MCP の報告（POST /mcp の report_problem・report_diagnostics_summary）と、それらに付ける添付のアップロードだけ）' as const,
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

    .route('/', systemRoutes(ctx, deps))

    .route('/', attachmentsRoutes(ctx, deps))

    .route('/', chatRoutes(ctx))

    .route('/', conversationsRoutes(ctx))

    .route('/', topologyRoutes(ctx, deps))

    .route('/', memoryRoutes(ctx))

    .route('/', practicesRoutes(ctx))

    .route('/', journalRoutes(ctx, deps))

    .route('/', approvalsRoutes(ctx, deps))

    .route('/', integrationRoutes(ctx, humanOnly, noteIntegrationRefusal))

    .route('/', mcpRoutes(ctx))

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
