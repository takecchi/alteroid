import type {
  RunnerAnswerCommand,
  RunnerClient,
  RunnerEvent,
  RunnerManagerState,
  RunnerResumeCommand,
  RunnerStartCommand,
} from '@alteroid/core';
import { runnerEventSchema, runnerManagerStateSchema } from '@alteroid/core';

/**
 * manager-runner への HTTP の口（roadmap M4）。
 *
 * **繋ぎに行くのはこちら（デーモン）だけである。** runner はデーモンの所在も鍵も
 * 知らない。逆向きのコールバック URL を足すと、runner の中のマネージャーがその
 * 経路でデーモンの API（＝記憶）へ届くようになる（architecture.md「非対称な可視性」）。
 */
export interface HttpRunnerOptions {
  baseUrl: string;
  /** 主にテスト用。既定はグローバルの `fetch`。 */
  fetchFn?: typeof fetch;
  /** ストリームが切れたときに待つミリ秒。 */
  retryDelayMs?: number;
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
}

class HttpRunner implements RunnerClient {
  runnerId = 'runner-primary';
  workspacePath = '';
  readonly #baseUrl: string;
  readonly #fetch: typeof fetch;
  readonly #retryDelayMs: number;
  #controller: AbortController | null = null;
  #closed = false;

  constructor(options: HttpRunnerOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/$/, '');
    this.#fetch = options.fetchFn ?? fetch;
    this.#retryDelayMs = options.retryDelayMs ?? 1000;
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
      headers: { accept: 'text/event-stream' },
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

  async transcript(managerId: string): Promise<string | null> {
    try {
      const response = await this.#fetch(
        `${this.#baseUrl}/managers/${encodeURIComponent(managerId)}/transcript`,
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
      ...(body === undefined
        ? {}
        : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`runner ${method} ${path} が失敗した (${response.status}) ${detail}`);
    }
    return response;
  }
}
