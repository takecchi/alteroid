import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';

import type { BuildRevision, RunnerEvent, RunnerHost } from '@alteroid/core';
import {
  readExecutionResources,
  resolveBuildRevision,
  RunnerFenceError,
  runnerAnswerCommandSchema,
  runnerMessageCommandSchema,
  runnerResumeCommandSchema,
  runnerSetCredentialsCommandSchema,
  runnerSetProfileCommandSchema,
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
  /**
   * 自分の版。**既定は `resolveBuildRevision()`（実際にビルドで焼かれた値）。**
   *
   * 渡すのはテストだけである——このプロセスが実際に何で焼かれたかは
   * `CANON_REVISION`（ビルド時に固定）に支配されるので、「焼き込みが無かった
   * ら `/health` が null をそのまま返すか」を確かめるには、実行中のプロセスの
   * 焼き込み状態とは独立に差し替えられる口が要る。本番の起動経路
   * （`apps/runner/src/index.ts`）はこの引数を渡さない。
   *
   * **この項目は焼き込みが無かった場合を再現するためだけに在る。本番の経路は
   * どこからも渡さない。**（これは「渡してよい設定」ではない。渡す実装が現れたら、
   * それは本番の形が変わったということである。）
   *
   * **内部に閉じていない。** `RunnerAppDeps` は `apps/runner/src/index.ts` から
   * export されている（`@alteroid/runner` の公開面）ので、この項目もワークスペース
   * 内の daemon 等から見える（`private: true` で npm へは publish されない）。
   */
  revision?: BuildRevision;
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

/**
 * このプロセスの識別子。**モジュールの読み込みで1回だけ作る。**
 *
 * `createRunnerApp` の中で作らないのは、テストが同じプロセスで app を作り直す
 * ことがあり、そのたびに変わると「器が入れ替わった」と読めてしまうからである。
 * 表しているのは**プロセスの同一性**であって app の同一性ではない。
 */
const INSTANCE_ID = randomUUID();

export function createRunnerApp(deps: RunnerAppDeps) {
  const { host, outbox } = deps;
  // **プロセスの生存期間ぶん1回だけ解決する**（`INSTANCE_ID` と同じ理由——
  // 焼き込み・実行時の環境変数はどちらもプロセスの寿命の間に変わらない）。
  const revision = deps.revision ?? resolveBuildRevision();

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
    /**
     * **認証を通った呼びだけが貸し出し期限の時計を進める。**
     *
     * `/livez` はここを通らない（無認証）。認証前にここへ置くと、誰でも
     * `GET /livez` を叩くだけで貸し出し期限を延ばせてしまい、自己失効
     * （`RunnerHostOptions.enforceLease`）がまるごと機能しなくなる。
     */
    host.noteDaemonContact();
    await next();
  });

  const app = new Hono()
    /** 器の生存確認だけ。制御面の情報は何も返さない（だから鍵を要求しない）。 */
    .get('/livez', (c) => c.json({ ok: true }))

    .use('/health', control)
    .use('/events', control)
    .use('/managers', control)
    .use('/managers/*', control)
    .use('/credentials', control)
    .use('/profile', control)

    .get('/health', async (c) =>
      c.json({
        ok: true,
        runnerId: host.runnerId,
        /**
         * **いまこの名前に応えているプロセスがどれか**（roadmap M5 PR4 の判定材料）。
         *
         * `runnerId` は宛先の名前で、器を作り直しても同じである（台帳の鎖
         * `manager_id → runner_id` がそれで繋がっている）。だからこの値だけでは
         * 「新しいコンテナが応え始めた」ことを誰も観測できず、名簿は器の入れ替えと
         * 単なる回復を区別できなかった（roadmap 受け入れ基準6）。
         *
         * **安定させないこと。** ここは起動ごとに変わることが唯一の役目である
         * （`runnerId` の別名を作るのではない）。ファイルや環境変数から読んで
         * 引き継ぐ形にした瞬間、入れ替えが見えなくなる。
         *
         * **秘密ではない。** 制御面の内側だけに出る値だが、伏せる理由も無い
         * （持っていても何もできない乱数である）。
         */
        instanceId: INSTANCE_ID,
        workspacePath: host.workspacePath,
        managers: host.list().length,
        pendingEvents: outbox.pending,
        /**
         * 実行環境の資源（roadmap M5 PR3）。**「収容能力」ではない。**
         *
         * ここに出るのは観測値だけである。「あと何本置けるか」は runner も答えない
         * — それは定員であって、配置の判断は名簿の側（`select`）にある
         * （north_star 禁止2 / `runnerExecutionResourcesSchema`）。
         *
         * **`os` の値を出さない。** ホストの数を名乗ると、同じホストに並んだ runner が
         * 全部同じ数を報告し、資源で選んでいるつもりで登録順に選ぶことになる
         * （実測は `readExecutionResources`）。
         */
        resources: await readExecutionResources(),
        /**
         * いま配っている鍵の**指紋だけ**。値は決して出さない。
         *
         * これが無いと、人間が置いた鍵とマネージャーが握っている鍵が同じかどうかを
         * 誰も確かめられず、「鍵の権限が足りない」のか「鍵が届いていない」のかを
         * 切り分けられない。実際にその切り分けができずに一晩溶けたことがある。
         */
        credentials: host.credentials(),
        /** 置いてある実行環境プロファイルの**指紋だけ**。本文は出さない。 */
        profile: host.profile(),
        /**
         * 自分がどのコミットで走っているか。
         *
         * **デーモンと runner は別 Service で別々にビルド・デプロイされる**
         * （`railway/daemon.json` / `railway/runner.json`）。同じ `main` から
         * 起こしていても、デプロイのタイミングがずれれば別コミットで走る窓が
         * できる——その窓でだけ壊れるものは、両者が自分の版を名乗れて初めて
         * 見つかる。デーモンはこれを heartbeat（`identity()`）で拾い、名簿の
         * `RunnerEntry.revision` へ運ぶ（`packages/core/src/runner-protocol.ts`）。
         *
         * **取れなければ全項目 `null`。** プレースホルダは作らない
         * （`resolveBuildRevision` の doc）。
         */
        revision,
      }),
    )

    /**
     * 鍵の差し替え。**制御面なので、runner の中のマネージャーからは叩けない。**
     *
     * ここが叩けてしまうと、マネージャーは自分に配られる鍵を自分で書き換えられる。
     * 門番（`control`）を外さないこと。
     */
    .post('/credentials', zValidator('json', runnerSetCredentialsCommandSchema), async (c) => {
      const fingerprints = await host.setCredentials(c.req.valid('json').credentials);
      return c.json({ ok: true, credentials: fingerprints });
    })

    /**
     * 実行環境プロファイル（`.zprofile` 相当）の差し替え。
     *
     * **鍵の差し替えと同じく制御面である。** マネージャーが叩けると、自分に効く
     * 環境をも自分で書き換えられる（門番を外さないこと）。
     *
     * **置く前に評価する。** 構文を間違えたスクリプトを `BASH_ENV` に載せると、
     * 以後すべてのコマンドが壊れた環境で走り、原因はどこにも出ない。壊れていれば
     * 置かずに理由を返す（前のものが残る）。
     */
    .get('/profile', (c) => c.json({ ok: true, profile: host.profile() }))
    .post('/profile', zValidator('json', runnerSetProfileCommandSchema), async (c) => {
      const result = await host.setProfile(c.req.valid('json').script);
      return c.json(result);
    })

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
      try {
        await host.resume(command);
      } catch (error) {
        /*
         * **世代が古い resume は 409、Hono の既定 500 に落とさない。**
         *
         * `isRetryableRunnerError`（`runner-protocol.ts`）は 5xx を「待てば直る」に
         * 分類する。500 のままだと、遅れて届いた古い世代の命令が「一時的な失敗」と
         * 誤解され、デーモン側の再試行が同じ古い命令を延々と投げ直す——本来は
         * 「同じものを投げ直しても同じ答えが返る」側（4xx）である。
         */
        if (error instanceof RunnerFenceError) {
          return c.json(
            { error: 'fenced' as const, expected: error.expected, given: error.given },
            409,
          );
        }
        throw error;
      }
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
