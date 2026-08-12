import type {
  RunnerAnswerCommand,
  RunnerClient,
  RunnerEvent,
  RunnerHealth,
  RunnerManagerState,
  RunnerResumeCommand,
  RunnerStartCommand,
} from '@alteroid/core';
import { request as httpRequest } from 'node:http';
import { Readable } from 'node:stream';

import {
  runnerEventSchema,
  runnerHealthSchema,
  runnerManagerStateSchema,
  withDeadline,
} from '@alteroid/core';

/**
 * manager-runner への HTTP の口（roadmap M4）。
 *
 * **繋ぎに行くのはこちら（デーモン）だけである。** runner はデーモンの所在も鍵も
 * 知らない。逆向きのコールバック URL を足すと、runner の中のマネージャーがその
 * 経路でデーモンの API（＝記憶）へ届くようになる（architecture.md「非対称な可視性」）。
 */
export interface HttpRunnerOptions {
  /** `http://runner:4518` か `unix:/run/alteroid/runner.sock`。 */
  baseUrl: string;
  /**
   * 制御面の合鍵。**デーモンだけが素の値を持つ。**
   *
   * runner 側にあるのは sha256 だけなので、runner の中で走るマネージャーが
   * `/proc/1/environ` を読めたとしても、この鍵は作れない。鍵が無ければ
   * `POST /managers/:id/answers` は通らない — マネージャーが自分宛の許可確認に
   * 自分で `allow` を返す経路を塞ぐ、いちばん内側の一枚である。
   */
  token: string;
  /** 主にテスト用。既定はグローバルの `fetch`（Unix ソケットなら node:http）。 */
  fetchFn?: typeof fetch;
  /** ストリームが切れたときに待つミリ秒。 */
  retryDelayMs?: number;
  /**
   * 名乗りが返るまでの仮の runner_id。
   *
   * 名簿に載っている器が全部いつも生きているとは限らない（M5）。落ちている器を
   * 名簿から消してしまうと復帰しても誰も繋ぎ直さないので、仮の名前で載せておき、
   * 名乗りが返った時点で本当の id に置き換える。
   */
  runnerId?: string;
  /**
   * 名乗りが返らなければ失敗にするか（既定 true）。
   *
   * 1台構成では**返らないなら起動しない**のが正しい（宛先の無いデーモンは何もできない）。
   * 複数構成では、1台の不在で残りを使えなくしない方が正しい（M5 受け入れ基準5）。
   */
  requireHello?: boolean;
  /**
   * 名乗り（`GET /health`）に置く期限。既定 5 秒。**短くしてある。**
   *
   * 生存判定と配置はここを待ち合わせる。接続を拒まれるなら例外はすぐ返るが、
   * TCP は繋がったまま黙る・パケットが落ちる・half-open のまま残る相手では、
   * 期限が無い限り約束は永久に解けない。1台の沈黙で `heartbeat()` と `select()`
   * が止まると、**落ちたことに誰も気づかず、健康な器への委譲も始まらない**
   * （M5 受け入れ基準5 が崩れる）。
   */
  healthTimeoutMs?: number;
  /**
   * 命令（start / resume / send / answer / stop / list）に置く期限。既定 30 秒。
   *
   * 名乗りより長いのは、`resume` が生ログを丸ごと運ぶからである（器を作り直した
   * 後の再開では大きくなる）。**それでも無期限にはしない** — 返らない命令は
   * そのままクローンと人間の待ちになる。
   */
  requestTimeoutMs?: number;
}

const DEFAULT_HEALTH_TIMEOUT_MS = 5_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

/** `unix:/path/to.sock` を取り出す（無ければ TCP）。 */
function socketPathOf(baseUrl: string): string | null {
  const match = /^unix:(?:\/\/)?(.+)$/.exec(baseUrl);
  return match?.[1] ?? null;
}

/**
 * 名乗りがまだ返っていない器の仮の名前。
 *
 * **台帳の runner_id と偶然一致しない形にしてある。** 一致すると、その器へ
 * 走っていたはずの仕事が「見つかった」ことになり、返事の来ない宛先へ命令が飛ぶ。
 */
export const UNCONFIRMED_RUNNER_PREFIX = '(未確認) ';

/** まだ名乗りが返っていないか（名簿には載るが、宛先としては引けない）。 */
export function isUnconfirmed(runner: Pick<RunnerClient, 'runnerId'>): boolean {
  return runner.runnerId.startsWith(UNCONFIRMED_RUNNER_PREFIX);
}

/**
 * 接続して runner_id を確かめてから使う（宛先を台帳に残すため）。
 *
 * `requireHello: false` のときだけ、返らない器も名簿に載る形で返る（複数構成で
 * 1台の不在が残りを止めないため）。その器は生存確認が通った時点で使えるようになる。
 */
export async function createHttpRunner(options: HttpRunnerOptions): Promise<RunnerClient> {
  const client = new HttpRunner(options);
  try {
    await client.hello();
  } catch (error) {
    if (options.requireHello !== false) throw error;
  }
  return client;
}

class HttpRunner implements RunnerClient {
  runnerId: string;
  workspacePath = '';
  readonly #baseUrl: string;
  readonly #socketPath: string | null;
  readonly #token: string;
  readonly #fetch: typeof fetch;
  readonly #retryDelayMs: number;
  readonly #healthTimeoutMs: number;
  readonly #requestTimeoutMs: number;
  #controller: AbortController | null = null;
  #closed = false;

  constructor(options: HttpRunnerOptions) {
    this.#healthTimeoutMs = options.healthTimeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS;
    this.#requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.runnerId = options.runnerId ?? `${UNCONFIRMED_RUNNER_PREFIX}${options.baseUrl}`;
    this.#socketPath = socketPathOf(options.baseUrl);
    // ソケットのときも URL の形は要る（ホスト名は使われない）
    this.#baseUrl =
      this.#socketPath === null ? options.baseUrl.replace(/\/$/, '') : 'http://runner';
    this.#token = options.token;
    this.#fetch = options.fetchFn ?? ((input, init) => this.#send(input, init));
    this.#retryDelayMs = options.retryDelayMs ?? 1000;
  }

  /**
   * Unix ソケット越しにも喋れる送信口。
   *
   * グローバルの `fetch` はソケットへ繋げないので、ソケットのときだけ node:http を
   * 使う。**ソケットにするのは、マネージャーと同じ器の中に TCP の口を開けない
   * ため**である（開いていれば `curl 127.0.0.1` の宛先になる）。
   */
  #send(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    if (this.#socketPath === null) return fetch(input, init);
    const url = new URL(typeof input === 'string' ? input : input.toString());
    return requestOverSocket(this.#socketPath, url, init ?? {});
  }

  /** 名乗りを聞く。ここで得た runner_id が `manager_id → runner_id` の宛先になる。 */
  async hello(): Promise<void> {
    await this.health();
  }

  /**
   * 名乗りと資源（生存判定の1回分）。
   *
   * **届かなければ投げる。** 「落ちている」を戻り値で表すと、名簿が生きている器と
   * 区別できず、落ちた器へ委譲を置き続ける（M5 受け入れ基準4）。
   *
   * 名乗りが返るたびに `runner_id` と workspace を取り直すのは、器が作り直された
   * あとも同じ宛先として戻ってこられるようにするためである。
   */
  async health(): Promise<RunnerHealth> {
    const body = await this.#call('GET', '/health', undefined, this.#healthTimeoutMs);
    const health = runnerHealthSchema.parse(JSON.parse(body));
    this.runnerId = health.runnerId;
    this.workspacePath = health.workspacePath;
    return health;
  }

  /**
   * イベントの受け取り。切れたら繋ぎ直す。
   *
   * **繋がっていない間の出来事は runner 側に溜まる**（Outbox）。ここで諦めると、
   * 誰も答えられない確認が runner に残り、マネージャーが永久に止まる。
   */
  async connect(onEvent: (event: RunnerEvent) => void): Promise<void> {
    void this.#pump(onEvent);
  }

  async #pump(onEvent: (event: RunnerEvent) => void): Promise<void> {
    while (!this.#closed) {
      try {
        await this.#stream(onEvent);
      } catch (error) {
        if (this.#closed) return;
        process.stderr.write(`alteroidd: runner のストリームが切れました: ${String(error)}\n`);
      }
      if (this.#closed) return;
      await new Promise((resolve) => setTimeout(resolve, this.#retryDelayMs));
    }
  }

  async #stream(onEvent: (event: RunnerEvent) => void): Promise<void> {
    const controller = new AbortController();
    this.#controller = controller;
    const response = await this.#fetch(`${this.#baseUrl}/events`, {
      headers: { accept: 'text/event-stream', authorization: `Bearer ${this.#token}` },
      signal: controller.signal,
    });
    if (!response.ok || response.body === null) {
      throw new Error(`runner の /events に繋げない (${response.status})`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });

      // SSE のフレームは空行区切り。`data:` 行だけを拾う。
      let boundary = buffer.indexOf('\n\n');
      while (boundary !== -1) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = frame
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trim())
          .join('\n');
        if (data.length > 0) {
          try {
            const parsed = runnerEventSchema.safeParse(JSON.parse(data));
            if (parsed.success) {
              // ストリームの先頭の名乗りでも id は確定する。名乗りが `GET /health`
              // でしか埋まらないと、繋がっているのに「(未確認)」のままの器が生まれ、
              // そこから降りてきた出来事の出どころが分からなくなる。
              if (parsed.data.type === 'hello') this.runnerId = parsed.data.runnerId;
              onEvent(parsed.data);
            }
          } catch {
            // 壊れた1フレームでストリームごと落とさない
          }
        }
        boundary = buffer.indexOf('\n\n');
      }
    }
  }

  async start(command: RunnerStartCommand): Promise<void> {
    await this.#call('POST', '/managers', command);
  }

  async resume(command: RunnerResumeCommand): Promise<void> {
    await this.#call('POST', `/managers/${encodeURIComponent(command.managerId)}/resume`, command);
  }

  async send(managerId: string, text: string): Promise<void> {
    await this.#call('POST', `/managers/${encodeURIComponent(managerId)}/messages`, { text });
  }

  async answer(managerId: string, answer: RunnerAnswerCommand): Promise<boolean> {
    const body = JSON.parse(
      await this.#call('POST', `/managers/${encodeURIComponent(managerId)}/answers`, answer),
    ) as { ok?: unknown };
    return body.ok === true;
  }

  async stop(managerId: string): Promise<void> {
    await this.#call('DELETE', `/managers/${encodeURIComponent(managerId)}`);
  }

  async list(): Promise<RunnerManagerState[]> {
    const body = JSON.parse(await this.#call('GET', '/managers')) as { managers?: unknown };
    if (!Array.isArray(body.managers)) return [];
    return body.managers.flatMap((entry) => {
      const parsed = runnerManagerStateSchema.safeParse(entry);
      return parsed.success ? [parsed.data] : [];
    });
  }

  async transcript(managerId: string): Promise<string | null> {
    try {
      return await this.#call(
        'GET',
        `/managers/${encodeURIComponent(managerId)}/transcript`,
        undefined,
        this.#requestTimeoutMs,
      );
    } catch {
      // 生ログが取れないだけでは何も止めない（デーモン側の退避へ降りる）。
      return null;
    }
  }

  /**
   * ストリームを閉じるだけ。**runner のマネージャーは止めない。**
   * デーモンの都合（再起動・更新）で、走っている人の仕事を殺さない。
   */
  async close(): Promise<void> {
    this.#closed = true;
    this.#controller?.abort();
    this.#controller = null;
  }

  /**
   * 1回の呼び出し。**必ず期限内に終わる。**
   *
   * 応答が来ないことも失敗として確定させる（`withDeadline`）。本文を読み切るまでを
   * 期限の内側に入れてあるのは、ヘッダだけ返って本文が止まる相手が居るからである
   * — そこを外に出すと、期限を通り抜けた `json()` が永久に解けない約束になる。
   *
   * 期限を過ぎたら `AbortSignal` で片付けの合図も送る。ただし相手が見てくれるとは
   * 限らないので、**期限そのものは合図に依存していない**。
   */
  async #call(
    method: string,
    path: string,
    body?: unknown,
    timeoutMs: number = this.#requestTimeoutMs,
  ): Promise<string> {
    return withDeadline(`runner ${method} ${path}`, timeoutMs, async (signal) => {
      const response = await this.#fetch(`${this.#baseUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.#token}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal,
      });
      const text = await response.text();
      if (!response.ok) {
        throw new Error(`runner ${method} ${path} が失敗した (${response.status}) ${text}`);
      }
      return text;
    });
  }
}

/** node:http で Unix ソケットへ投げ、`fetch` と同じ形の応答に均す。 */
function requestOverSocket(socketPath: string, url: URL, init: RequestInit): Promise<Response> {
  return new Promise((resolve, reject) => {
    const headers = new Headers(init.headers ?? {});
    const outgoing: Record<string, string> = {};
    headers.forEach((value, key) => {
      outgoing[key] = value;
    });

    const req = httpRequest(
      {
        socketPath,
        path: `${url.pathname}${url.search}`,
        method: init.method ?? 'GET',
        headers: outgoing,
      },
      (res) => {
        // 本文はそのまま流す（SSE は開いたまま読み続ける）
        const body = Readable.toWeb(res) as ReadableStream<Uint8Array>;
        resolve(
          new Response(body, {
            status: res.statusCode ?? 500,
            headers: Object.entries(res.headers).flatMap(([key, value]) =>
              typeof value === 'string' ? [[key, value] as [string, string]] : [],
            ),
          }),
        );
      },
    );

    req.on('error', reject);
    const signal = init.signal;
    if (signal) signal.addEventListener('abort', () => req.destroy(), { once: true });
    if (typeof init.body === 'string') req.write(init.body);
    req.end();
  });
}
