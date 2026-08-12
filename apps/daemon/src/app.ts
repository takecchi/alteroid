import { randomUUID } from 'node:crypto';

import type { ChatStreamEvent, CloneHost, JournalEntryType, Stores } from '@alteroid/core';
import { memorySlugSchema } from '@alteroid/core';
import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
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
 * （PRD「可観測性」）。M1 で揃うのは日誌とセッションログ、そして記憶である。
 */
export interface AppDeps {
  clone: CloneHost;
  stores: Stores;
  /** `daemon stop` の受け口。 */
  shutdown: () => void;
}

const chatBody = z.object({
  text: z.string().min(1),
  conversationId: z.string().min(1).optional(),
});

const memoryBody = z.object({ content: z.string() });
const answerBody = z.object({ answer: z.string().min(1) });
const journalQuery = z.object({
  limit: z.coerce.number().int().min(1).max(1000).default(50),
  /** ISO 8601。ここより古いエントリまで遡って読むための足がかり。 */
  since: z.string().optional(),
  /** カンマ区切りの日誌エントリ種別。 */
  type: z.string().optional(),
});
const approvalsQuery = z.object({ pending: z.enum(['true', 'false']).default('true') });

export function createApp(deps: AppDeps) {
  const { clone, stores } = deps;

  const app = new Hono()
    .get('/health', (c) => c.json({ ok: true, pid: process.pid }))

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
    .post('/chat/:conversationId/end', async (c) => {
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

    // --- 承認待ちキュー ----------------------------------------------------
    .get('/approvals', zValidator('query', approvalsQuery), async (c) =>
      c.json({
        approvals: await stores.jobs.listApprovals({
          pendingOnly: c.req.valid('query').pending !== 'false',
        }),
      }),
    )

    .post('/approvals/:id/answer', zValidator('json', answerBody), async (c) => {
      const id = c.req.param('id');
      if (!(await stores.jobs.getApproval(id))) return c.json({ error: 'not found' as const }, 404);
      await clone.answerApproval(id, c.req.valid('json').answer);
      return c.json({ ok: true });
    })

    // --- セッションログ（アーカイブ） --------------------------------------
    .get('/archive', async (c) => c.json({ entries: await stores.archive.list() }))

    .get('/archive/:id', async (c) => {
      const body = await stores.archive.read(c.req.param('id'));
      if (body === null) return c.json({ error: 'not found' as const }, 404);
      return c.text(body);
    })

    .post('/shutdown', (c) => {
      setTimeout(() => deps.shutdown(), 10);
      return c.json({ ok: true });
    });

  return app;
}

export type AppType = ReturnType<typeof createApp>;
