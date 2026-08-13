import type {
  RunnerAnswerCommand,
  RunnerClient,
  RunnerCredentialFingerprint,
  RunnerEvent,
  RunnerManagerState,
  RunnerResumeCommand,
  RunnerSetCredentialsCommand,
  RunnerStartCommand,
} from '@alteroid/core';
import { request as httpRequest } from 'node:http';
import { Readable } from 'node:stream';

import {
  runnerCredentialFingerprintSchema,
  runnerEventSchema,
  runnerManagerStateSchema,
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
}

/** `unix:/path/to.sock` を取り出す（無ければ TCP）。 */
function socketPathOf(baseUrl: string): string | null {
  const match = /^unix:(?:\/\/)?(.+)$/.exec(baseUrl);
  return match?.[1] ?? null;
}

/**
 * runner が返した失敗。**status を落とさずに持ち上げる。**
 *
 * 呼ぶ側が「待てば直る（器の入れ替え中）」と「待っても直らない（鍵が違う）」を
 * 区別できないと、設定の誤りを再試行で何分も隠すことになる。
 */
export class RunnerHttpError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'RunnerHttpError';
    this.status = status;
  }
}

/** 接続して runner_id を確かめてから使う（宛先を台帳に残すため）。 */
export async function createHttpRunner(options: HttpRunnerOptions): Promise<RunnerClient> {
  const client = new HttpRunner(options);
  await client.hello();
  return client;
}

interface HealthBody {
  runnerId?: unknown;
  workspacePath?: unknown;
  credentials?: unknown;
}

/** 指紋の配列だけを取り出す（値は runner も返さないし、こちらも持たない）。 */
function fingerprintsOf(value: unknown): RunnerCredentialFingerprint[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const parsed = runnerCredentialFingerprintSchema.safeParse(entry);
    return parsed.success ? [parsed.data] : [];
  });
}

class HttpRunner implements RunnerClient {
  runnerId = 'runner-primary';
  workspacePath = '';
  readonly #baseUrl: string;
  readonly #socketPath: string | null;
  readonly #token: string;
  readonly #fetch: typeof fetch;
  readonly #retryDelayMs: number;
  #controller: AbortController | null = null;
  #closed = false;

  constructor(options: HttpRunnerOptions) {
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
    const response = await this.#call('GET', '/health');
    const body = (await response.json()) as HealthBody;
    if (typeof body.runnerId === 'string' && body.runnerId.length > 0) {
      this.runnerId = body.runnerId;
    }
    if (typeof body.workspacePath === 'string') this.workspacePath = body.workspacePath;
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
            if (parsed.success) onEvent(parsed.data);
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
    const response = await this.#call(
      'POST',
      `/managers/${encodeURIComponent(managerId)}/answers`,
      answer,
    );
    const body = (await response.json()) as { ok?: unknown };
    return body.ok === true;
  }

  async stop(managerId: string): Promise<void> {
    await this.#call('DELETE', `/managers/${encodeURIComponent(managerId)}`);
  }

  async list(): Promise<RunnerManagerState[]> {
    const response = await this.#call('GET', '/managers');
    const body = (await response.json()) as { managers?: unknown };
    if (!Array.isArray(body.managers)) return [];
    return body.managers.flatMap((entry) => {
      const parsed = runnerManagerStateSchema.safeParse(entry);
      return parsed.success ? [parsed.data] : [];
    });
  }

  async credentials(): Promise<RunnerCredentialFingerprint[]> {
    const response = await this.#call('GET', '/health');
    const body = (await response.json()) as HealthBody;
    return fingerprintsOf(body.credentials);
  }

  /**
   * 鍵を差し替える。**器は作り直さない。**
   *
   * 走行中のマネージャーにも、器（ファイル）越しに次の `git` / `gh` 呼び出しから
   * 届く。ここが無いと鍵の更新に再デプロイが要り、そのたびに走っている仕事が死ぬ。
   */
  async setCredentials(
    credentials: RunnerSetCredentialsCommand['credentials'],
  ): Promise<RunnerCredentialFingerprint[]> {
    const response = await this.#call('POST', '/credentials', { credentials });
    const body = (await response.json()) as { credentials?: unknown };
    return fingerprintsOf(body.credentials);
  }

  async transcript(managerId: string): Promise<string | null> {
    try {
      const response = await this.#fetch(
        `${this.#baseUrl}/managers/${encodeURIComponent(managerId)}/transcript`,
        { headers: { authorization: `Bearer ${this.#token}` } },
      );
      if (!response.ok) return null;
      return await response.text();
    } catch {
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

  async #call(method: string, path: string, body?: unknown): Promise<Response> {
    const response = await this.#fetch(`${this.#baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.#token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new RunnerHttpError(
        `runner ${method} ${path} が失敗した (${response.status}) ${detail}`,
        response.status,
      );
    }
    return response;
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
