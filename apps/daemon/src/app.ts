import { randomUUID } from 'node:crypto';

import type {
  ChatStreamEvent,
  CloneHost,
  JournalEntry,
  JournalEntryType,
  RunnerRegistry,
  Scheduler,
  Stores,
} from '@alteroid/core';
import { localDayRange, memorySlugSchema, runnerSetCredentialsCommandSchema } from '@alteroid/core';
import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { createMiddleware } from 'hono/factory';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';

/**
 * HTTP API（hono）。CLI も外部アプリもここを叩く。
 *
 * インターフェースは CLI と HTTP API のみ（非ゴール: Web UI）。CLI は core を
 * 埋め込まずこの API の薄いクライアントに徹する — でないと chat のたびに脳が
 * 分岐する（docs/architecture.md「脳は1インスタンス」）。
 *
 * 可観測性の3層（日報・日誌・セッションログ）はすべてここから読める必要がある
 * （PRD「可観測性」）。M3 で最上段の日報が揃い、3層が全部この API から読める。
 *
 * ここには**外部イベントの入口**もある（`POST /events`）。仕事の起点を人間に
 * 限らないための口であり、開いている先は 127.0.0.1 だけである。外から叩かせるなら、
 * 手前に境界（リバースプロキシ・トンネル・認証）を置くのが正しい — 能力側で
 * 絞るのではなく実行環境の境界で守る（north_star 禁止2）。
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
  /** カンマ区切りの日誌エントリ種別。 */
  type: z.string().optional(),
});
const approvalsQuery = z.object({ pending: z.enum(['true', 'false']).default('true') });

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
 * `zValidator('json', ...)` を持つ経路は hono が同じ検査をするので、こちらは要らない。
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

type DailyReport = Extract<JournalEntry, { type: 'daily_report' }>;

function isDailyReport(entry: JournalEntry): entry is DailyReport {
  return entry.type === 'daily_report';
}

export function createApp(deps: AppDeps) {
  const { clone, stores } = deps;

  const app = new Hono()
    .get('/health', (c) =>
      c.json({ ok: true, pid: process.pid, token: deps.token, storage: deps.storage ?? '' }),
    )

    // --- chat（SSE） -------------------------------------------------------
    .post('/chat', zValidator('json', chatBody), async (c) => {
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

        // 人間が chat を閉じても、クローンのターンは走り続ける（人間の不在で
        // 止まるのは承認待ちの仕事だけ）。ここで手放すのは購読だけである。
        stream.onAbort(() => {
          finished = true;
          wake?.();
        });

        await stream.writeSSE({ event: 'open', data: JSON.stringify({ conversationId }) });

        clone.post({
          type: 'human_message',
          id: randomUUID(),
          at: new Date().toISOString(),
          text,
          conversationId,
        });

        try {
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
          unsubscribe();
        }
      });
    })

    /** 会話の終了 = 蒸留の契機。CLI が chat を抜けるときに叩く。 */
    .post('/chat/:conversationId/end', deliberateClient, async (c) => {
      await clone.endConversation(c.req.param('conversationId'));
      return c.json({ ok: true });
    })

    // --- 記憶（人間が読んで直せること自体が要件） ---------------------------
    .get('/memory', async (c) => c.json({ documents: await stores.persona.list() }))

    .get('/memory/:slug', async (c) => {
      const doc = await stores.persona.read(c.req.param('slug'));
      if (!doc) return c.json({ error: 'not found' as const }, 404);
      return c.json({ document: doc });
    })

    .put('/memory/:slug', zValidator('json', memoryBody), async (c) => {
      const slug = c.req.param('slug');
      if (!memorySlugSchema.safeParse(slug).success) {
        return c.json({ error: '記憶のスラッグが不正' as const }, 400);
      }
      const doc = await stores.persona.write(slug, c.req.valid('json').content);
      await stores.journal.append({
        type: 'memory_update',
        slug,
        cause: 'human',
        summary: 'HTTP API 経由で人間が記憶を書き換えた',
      });
      return c.json({ document: doc });
    })

    // --- 日誌 --------------------------------------------------------------
    .get('/journal', zValidator('query', journalQuery), async (c) => {
      const { limit, since, type } = c.req.valid('query');
      const types = type?.split(',').filter((value) => value.length > 0) as
        JournalEntryType[] | undefined;
      return c.json({
        entries: await stores.journal.list({
          limit,
          ...(since === undefined ? {} : { since }),
          ...(types === undefined || types.length === 0 ? {} : { types }),
        }),
      });
    })

    // --- 日報（可観測性の最上段。人間の普段の接点はほぼこれだけ） --------------
    .get('/reports', zValidator('query', reportsQuery), async (c) => {
      const entries = await stores.journal.list({
        types: ['daily_report'],
        limit: c.req.valid('query').limit,
      });
      return c.json({ reports: entries.filter(isDailyReport) });
    })

    .get('/reports/:date', async (c) => {
      const date = c.req.param('date');
      const range = localDayRange(date);
      if (range === null) return c.json({ error: '日付は YYYY-MM-DD で指定する' as const }, 400);

      // その日以降だけを読む（日報は1日1件なので、遡る量は日数で収まる）
      const entries = await stores.journal.list({
        types: ['daily_report'],
        since: range.since.toISOString(),
      });
      const reports = entries.filter(isDailyReport).filter((entry) => entry.date === date);
      if (reports.length === 0) return c.json({ error: 'not found' as const }, 404);
      return c.json({ reports });
    })

    // --- 承認待ちキュー ----------------------------------------------------
    .get('/approvals', zValidator('query', approvalsQuery), async (c) =>
      c.json({
        approvals: await stores.jobs.listApprovals({
          pendingOnly: c.req.valid('query').pending !== 'false',
        }),
      }),
    )

    /**
     * 溜まった保留をまとめて片付ける。1件が駄目でも残りは進める（人間の不在で
     * 止まっていたそれぞれの仕事が、答えた順に独立に再開する）。
     */
    .post('/approvals/answer', zValidator('json', answersBody), async (c) => {
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
    })

    .post('/approvals/:id/answer', zValidator('json', answerBody), async (c) => {
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
    })

    // --- 外部イベントの入口（起点③） ----------------------------------------
    /**
     * 自作ツール・ショートカット・CI からクローンへ出来事を届ける。
     * 何をするかはここで決めない（対応表を持った瞬間に自動化ジョブに戻る）。
     */
    .post('/events', zValidator('json', eventBody), (c) => {
      const { source, payload } = c.req.valid('json');
      const id = randomUUID();
      clone.post({ type: 'external', id, at: new Date().toISOString(), source, payload });
      return c.json({ ok: true, id });
    })

    /**
     * 他人が形を決めている webhook 用。本文をそのまま payload として運ぶので、
     * 送り元を改造できなくても届く（GitHub や CI からそのまま叩ける）。
     */
    .post('/events/:source', deliberateClient, async (c) => {
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
    })

    // --- 時間起点のジョブ ---------------------------------------------------
    .get('/schedule', (c) => c.json({ entries: deps.scheduler?.list() ?? [] }))

    /**
     * 定期ジョブを今すぐ起こす（人間が待たずに確かめるための口）。
     *
     * これは観測ではなく**実行**である。起こせばクローンのターンが走り、記憶に
     * 基づく委譲や外部への操作の判断まで動く。ブラウザから叩けてはいけない。
     */
    .post('/schedule/:kind/run', deliberateClient, (c) => {
      const kind = c.req.param('kind');
      if (deps.scheduler?.run(kind) !== true) return c.json({ error: 'not found' as const }, 404);
      return c.json({ ok: true });
    })

    // --- マネージャー（可観測性の中段から下段へ降りる経路） ------------------
    .get('/managers', async (c) => c.json({ managers: await clone.managers.list() }))

    .get('/managers/:id', async (c) => {
      const id = c.req.param('id');
      const manager = (await clone.managers.list()).find((entry) => entry.managerId === id);
      if (!manager) return c.json({ error: 'not found' as const }, 404);
      return c.json({ manager });
    })

    /**
     * manager_id からそのセッションの生ログへ。走行中ならファイルの上、
     * 退避済みならアーカイブから返る（可観測性3層の最下段）。
     */
    .get('/managers/:id/transcript', async (c) => {
      const body = await clone.managers.transcript(c.req.param('id'));
      if (body === null) return c.json({ error: 'not found' as const }, 404);
      return c.text(body);
    })

    // --- 委譲先の器と、そこへ配る鍵 ----------------------------------------
    /**
     * runner の一覧と、**そこで配られている鍵の指紋**。
     *
     * 指紋を出すのは、人間が置いた鍵とマネージャーが握っている鍵が同じかどうかを
     * 確かめる手段が他に無いからである。無いと「鍵の権限が足りない」のか「鍵が
     * 届いていない」のかを誰も切り分けられず、人間とマネージャーが両方正しいまま
     * 何時間もすれ違う（実際に起きた）。**値は返らない。**
     */
    .get('/runners', async (c) => {
      const registry = deps.runners;
      if (registry === undefined) return c.json({ runners: [] });
      const runners = await registry.list();
      return c.json({
        runners: await Promise.all(
          runners.map(async (runner) => ({
            runnerId: runner.runnerId,
            workspacePath: runner.workspacePath,
            credentials: await runner.credentials().catch(() => []),
          })),
        ),
      });
    })

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
      zValidator('json', runnerSetCredentialsCommandSchema),
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
        return c.json({ results });
      },
    )

    // --- セッションログ（アーカイブ） --------------------------------------
    .get('/archive', async (c) => c.json({ entries: await stores.archive.list() }))

    .get('/archive/:id', async (c) => {
      const body = await stores.archive.read(c.req.param('id'));
      if (body === null) return c.json({ error: 'not found' as const }, 404);
      return c.text(body);
    })

    .post('/shutdown', deliberateClient, (c) => {
      setTimeout(() => deps.shutdown(), 10);
      return c.json({ ok: true });
    });

  return app;
}

export type AppType = ReturnType<typeof createApp>;
