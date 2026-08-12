import { createHash, timingSafeEqual } from 'node:crypto';

import type { RunnerEvent, RunnerHost } from '@alteroid/core';
import {
  runnerAnswerCommandSchema,
  runnerMessageCommandSchema,
  runnerResumeCommandSchema,
  runnerStartCommandSchema,
} from '@alteroid/core';
import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { createMiddleware } from 'hono/factory';
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
  /**
   * 制御面の合鍵の **sha256（16進）**。デーモンだけが元の値を持つ。
   *
   * **なぜハッシュだけを持つのか。** マネージャーは runner の中で走る子プロセスで
   * あり、素の鍵を runner の環境変数に置けば `/proc/1/environ` から読める。読めた
   * 瞬間、マネージャーは `POST /managers/:id/answers` で**自分宛の許可確認に自分で
   * allow を返せる** — クローンも人間も通らずに権限境界を迂回できる。
   * ハッシュしか無ければ、読めても鍵は作れない。
   *
   * これは能力の制限ではなく、制御面の本人確認である（north_star 禁止2の「実行環境の
   * 境界」）。マネージャーの道具は1つも減っていない。
   */
  tokenSha256: string;
}

const AUTH_SCHEME = /^Bearer\s+(.+)$/i;

function sha256(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

/** 一致の判定は長さを揃えて定数時間で（総当たりに時間の手がかりを与えない）。 */
function matches(header: string | undefined, expectedHex: string): boolean {
  const token = AUTH_SCHEME.exec(header ?? '')?.[1];
  if (token === undefined) return false;
  let expected: Buffer;
  try {
    expected = Buffer.from(expectedHex, 'hex');
  } catch {
    return false;
  }
  if (expected.length !== 32) return false;
  return timingSafeEqual(sha256(token), expected);
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

  /**
   * 制御面の門番。**runner の中から叩けても、鍵が無ければ通らない。**
   *
   * ここを外すと、マネージャーが `curl` で自分の `requestId` を調べ、自分に
   * `allow` を返せる（権限境界の完全な迂回）。
   */
  const control = createMiddleware(async (c, next) => {
    if (!matches(c.req.header('authorization'), deps.tokenSha256)) {
      return c.json({ error: 'unauthorized' as const }, 401);
    }
    await next();
  });

  const app = new Hono()
    /** 器の生存確認だけ。制御面の情報は何も返さない（だから鍵を要求しない）。 */
    .get('/livez', (c) => c.json({ ok: true }))

    .use('/health', control)
    .use('/events', control)
    .use('/managers', control)
    .use('/managers/*', control)

    /**
     * 名乗りと資源の報告（M4 の宛先確認 ＋ M5 の生存判定・配置）。
     *
     * `capacity` は**実測だけ**を載せる。「あと何本置けるか」を器が答え始めた
     * 瞬間、それは定員＝能力の制限になる（roadmap M5 の地雷）。詰まっていることは
     * 数字から分かるが、詰まったことを理由に委譲を拒む口はここにも無い。
     */
    .get('/health', (c) =>
      c.json({
        ok: true as const,
        runnerId: host.runnerId,
        workspacePath: host.workspacePath,
        managers: host.list().length,
        pendingEvents: outbox.pending,
        capacity: host.capacity(),
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
