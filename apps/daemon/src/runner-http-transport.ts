import { lookup as dnsLookup } from 'node:dns';
import type { LookupFunction } from 'node:net';
import { performance } from 'node:perf_hooks';

import { RUNNER_CLIENT_KEEP_ALIVE_MS, type RunnerRequestStages } from '@alteroid/core';
import { Agent, fetch as undiciFetch } from 'undici';

interface LookupRecord {
  readonly startedAt: number;
  doneAt: number | null;
  failed: boolean;
}

interface RequestRecord {
  readonly path: string;
  readonly startedAt: number;
  headersAt: number | null;
}

// 古い記録は捨てる: 1台に10秒ごとの確認しか無くても、他の要求（SSE の繋ぎ直し・命令）で積み上がるため
const REQUEST_RECORDS = 32;

/**
 * runner への TCP の HTTP を、接続を使い回す undici の `Agent` で送る口（#4890）。
 * 併せて、名乗りの確認が期限切れになったとき「どの段で止まったか」を答えるための時刻を取る:
 * - 名前解決: `connect.lookup` を包んで、始まりと終わりを取る（diagnostics_channel は要求と結べないので採らない。台ごとに Agent を持つので、この包みで見えるのはその台だけ）
 * - 接続: Agent の `connect` イベント
 * - 応答のヘッダ: `fetch` が返った時刻
 * 時計は `node:perf_hooks`（`vi.useFakeTimers()` に巻き込まれない）。
 */
export class RunnerHttpTransport {
  readonly #agent: Agent;
  readonly #fetch: typeof undiciFetch;
  #lookup: LookupRecord | null = null;
  #connectedAt: number | null = null;
  readonly #requests: RequestRecord[] = [];

  constructor(options?: { keepAliveMs?: number; fetchFn?: typeof undiciFetch }) {
    this.#fetch = options?.fetchFn ?? undiciFetch;
    const keepAliveMs = options?.keepAliveMs ?? RUNNER_CLIENT_KEEP_ALIVE_MS;
    const lookup: LookupFunction = (hostname, lookupOptions, callback) => {
      const record: LookupRecord = { startedAt: performance.now(), doneAt: null, failed: false };
      this.#lookup = record;
      dnsLookup(hostname, lookupOptions, (error, ...rest) => {
        record.doneAt = performance.now();
        record.failed = error !== null;
        // `dns.lookup` の戻りの形（`all` の有無で変わる）はそのまま素通しする
        (callback as (error: NodeJS.ErrnoException | null, ...rest: unknown[]) => void)(
          error,
          ...rest,
        );
      });
    };
    this.#agent = new Agent({
      keepAliveTimeout: keepAliveMs,
      // 既定（600 秒）の上限は使わず、サーバが keep-alive のヒントを返しても、こちらの値を超えて持たない
      keepAliveMaxTimeout: keepAliveMs,
      connect: { lookup },
    });
    this.#agent.on('connect', () => {
      this.#connectedAt = performance.now();
    });
  }

  send(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    const record: RequestRecord = {
      path: pathOf(input),
      startedAt: performance.now(),
      headersAt: null,
    };
    this.#requests.push(record);
    if (this.#requests.length > REQUEST_RECORDS) {
      this.#requests.splice(0, this.#requests.length - REQUEST_RECORDS);
    }
    // undici の `fetch` と `Agent` は同じ版から取る（Node 同梱の fetch へ別の版の dispatcher を渡さない）。
    // 型は DOM の `fetch` と食い違うので、ここで境界を引く（実行時の形はどちらも WHATWG の `fetch`）。
    const sent = this.#fetch(input as Parameters<typeof undiciFetch>[0], {
      ...(init as Parameters<typeof undiciFetch>[1]),
      dispatcher: this.#agent,
    }) as unknown as Promise<Response>;
    return sent.then((response) => {
      record.headersAt = performance.now();
      return response;
    });
  }

  /** 確認を投げた時刻（`performance.now()`）以降の段。取れない欄は埋めない（＝不明）。 */
  stagesSince(sinceMs: number): RunnerRequestStages {
    const request = this.#requests.find(
      (r) => r.path.endsWith('/health') && r.startedAt >= sinceMs,
    );
    const lookup = this.#lookup !== null && this.#lookup.startedAt >= sinceMs ? this.#lookup : null;
    const now = performance.now();
    return {
      lookup:
        lookup === null
          ? { kind: 'none' }
          : lookup.doneAt === null
            ? { kind: 'pending', ms: now - lookup.startedAt }
            : lookup.failed
              ? { kind: 'failed', ms: lookup.doneAt - lookup.startedAt }
              : { kind: 'resolved', ms: lookup.doneAt - lookup.startedAt },
      // 名前解決が始まっていない回の接続は、使い回した既存の接続か、まだ張る前かを区別できないので、埋めない
      ...(lookup === null
        ? {}
        : { connected: this.#connectedAt !== null && this.#connectedAt >= lookup.startedAt }),
      ...(request === undefined ? {} : { headersReceived: request.headersAt !== null }),
    };
  }

  close(): void {
    void this.#agent.close().catch(() => undefined);
  }
}

function pathOf(input: string | URL | Request): string {
  const text = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  try {
    return new URL(text).pathname;
  } catch {
    return '';
  }
}
