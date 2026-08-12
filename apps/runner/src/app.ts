import type { RunnerEvent, RunnerHost } from '@alteroid/core';
import {
  runnerAnswerCommandSchema,
  runnerMessageCommandSchema,
  runnerResumeCommandSchema,
  runnerStartCommandSchema,
} from '@alteroid/core';
import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';

/**
 * manager-runner の HTTP API（roadmap M4）。
 *
 * **叩くのはデーモンだけである。** runner はデーモンの所在も鍵も知らない —
 * 出来事は「デーモンが開いたストリーム」を流れ落ちる（`GET /events`）。逆向きの
 * コールバックを足すと、runner の中の子プロセス（＝マネージャー）がその経路で
 * 記憶へ届けるようになる（docs/architecture.md「非対称な可視性」）。
 *
 * ここに判断は無い。許可してよい行為の一覧も、確認の要否の設定も持たない。
 * それらはクローンが記憶を根拠に決めるものである（PRD「権限境界」）。
 */
export interface RunnerAppDeps {
  host: RunnerHost;
  /** デーモンが繋いでいない間の出来事を溜める箱。 */
  outbox: Outbox;
}

/**
 * 受け口が閉じている間の出来事を落とさないための箱。
 *
 * デーモンが再起動している最中にも、マネージャーは手を動かし、確認を投げてくる。
 * ここで捨てると**誰も答えられない待ちが runner に残る**（マネージャーは永久に
 * 止まる）。だから溜めて、繋がった順に流す。
 *
 * 溜める量に上限を置かないのは、上限＝取りこぼしだからである。器の資源が尽きる
 * ときは実行環境の限界として現れるべきで、記録を先に捨てる設計にしない。
 */
export class Outbox {
  readonly #queue: RunnerEvent[] = [];
  #listener: ((event: RunnerEvent) => void) | null = null;

  push(event: RunnerEvent): void {
    if (this.#listener !== null) {
      this.#listener(event);
      return;
    }
    this.#queue.push(event);
  }

  /** 購読を開始する。溜まっていた分を先に流してから、以後は直接渡す。 */
  attach(listener: (event: RunnerEvent) => void): () => void {
    while (this.#queue.length > 0) {
      const event = this.#queue.shift();
      if (event !== undefined) listener(event);
    }
    this.#listener = listener;
    return () => {
      if (this.#listener === listener) this.#listener = null;
    };
  }

  get pending(): number {
    return this.#queue.length;
  }
}

export function createRunnerApp(deps: RunnerAppDeps) {
  const { host, outbox } = deps;

  const app = new Hono()
    .get('/health', (c) =>
      c.json({
        ok: true,
        runnerId: host.runnerId,
        workspacePath: host.workspacePath,
        managers: host.list().length,
        pendingEvents: outbox.pending,
      }),
    )

    /**
     * 出来事のストリーム。**接続を張るのはデーモン側**である。
     *
     * 1本だけが購読する前提（デーモンは1つ）。繋ぎ直しのたびに、溜まっていた分から
     * 流し直す。
     */
    .get('/events', (c) =>
      streamSSE(c, async (stream) => {
        const queue: RunnerEvent[] = [];
        let wake: (() => void) | null = null;
        let closed = false;

        const detach = outbox.attach((event) => {
          queue.push(event);
          wake?.();
        });
        stream.onAbort(() => {
          closed = true;
          wake?.();
        });

        await stream.writeSSE({
          event: 'hello',
          data: JSON.stringify({ type: 'hello', runnerId: host.runnerId }),
        });

        try {
          for (;;) {
            if (closed || stream.aborted || stream.closed) break;
            const event = queue.shift();
            if (event === undefined) {
              await new Promise<void>((resolve) => {
                wake = resolve;
              });
              wake = null;
              continue;
            }
            await stream.writeSSE({ event: event.type, data: JSON.stringify(event) });
          }
        } finally {
          detach();
          // 流し切れなかった分は箱へ戻す（次に繋がったときに届く）
          for (const event of queue) outbox.push(event);
        }
      }),
    )

    .get('/managers', (c) => c.json({ managers: host.list() }))

    .post('/managers', zValidator('json', runnerStartCommandSchema), async (c) => {
      await host.start(c.req.valid('json'));
      return c.json({ ok: true });
    })

    /** 中断されたセッションの続きへ戻す（生ログはデーモンが持ってくる）。 */
    .post('/managers/:id/resume', zValidator('json', runnerResumeCommandSchema), async (c) => {
      const command = c.req.valid('json');
      if (command.managerId !== c.req.param('id')) {
        return c.json({ error: 'manager_id が経路と本文で食い違っている' as const }, 400);
      }
      await host.resume(command);
      return c.json({ ok: true });
    })

    .post('/managers/:id/messages', zValidator('json', runnerMessageCommandSchema), async (c) => {
      const delivered = await host.send(c.req.param('id'), c.req.valid('json').text);
      if (!delivered) return c.json({ error: 'not found' as const }, 404);
      return c.json({ ok: true });
    })

    /** 止まっていた確認への回答。宛先は `requestId` で指す（推測しない）。 */
    .post('/managers/:id/answers', zValidator('json', runnerAnswerCommandSchema), async (c) => {
      const settled = await host.answer(c.req.param('id'), c.req.valid('json'));
      return c.json({ ok: settled });
    })

    .delete('/managers/:id', async (c) => {
      await host.stop(c.req.param('id'));
      return c.json({ ok: true });
    })

    /** 走行中セッションの生ログ（可観測性の最下段へ降りる入口）。 */
    .get('/managers/:id/transcript', async (c) => {
      const body = await host.transcript(c.req.param('id'));
      if (body === null) return c.json({ error: 'not found' as const }, 404);
      return c.text(body);
    });

  return app;
}

export type RunnerAppType = ReturnType<typeof createRunnerApp>;
