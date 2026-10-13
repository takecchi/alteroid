import { AsyncLocalStorage } from 'node:async_hooks';

import { Client, Pool, type ClientConfig } from 'pg';

/**
 * 接続の期限（ms）。新しく繋ぐときと、満杯のプールで空きを待つときの両方に掛かる（pg-pool の `connectionTimeoutMillis`）。
 * 繋ぐだけなら同じ網の中で 1 秒もかからない。10 秒を超えたら、経路が死んでいるか、プールが返らない問い合わせで埋まっている。
 */
export const PG_CONNECT_TIMEOUT_MS = 10_000;

/**
 * 問い合わせ1本の既定の期限（ms）。送ってから答えが全部届くまでを数える（#4655）。
 * 主キー引き・件数で締めた読み・1行の書き込みは数十 ms で終わるので、30 秒は「返らない」とだけ言える長さである。
 * 正当に長いもの（大きい本文の出し入れ・表の走査・マイグレーション）は {@link withPgQueryTimeout} で個別に延ばす。
 */
export const PG_QUERY_TIMEOUT_MS = 30_000;

/**
 * 正当に長い問い合わせの期限（ms）。数百 MB の生ログ・100 MB 級の退避の本文・約 4GB の journal の走査・索引の作成を収める。
 * 無期限にしない: 経路が半開きになったとき、ここが返らないと後ろに直列で並ぶ処理が永久に止まるため（#4655）。
 */
export const PG_LONG_QUERY_TIMEOUT_MS = 10 * 60_000;

/** 期限で打ち切った問い合わせ・接続。問い合わせなら接続は切ってあり、プールはそれを捨てて繋ぎ直す。 */
export class PgTimeoutError extends Error {
  readonly kind: 'query' | 'connect';
  readonly timeoutMs: number;

  constructor(kind: 'query' | 'connect', timeoutMs: number, detail: string, cause?: unknown) {
    super(
      kind === 'query'
        ? `PostgreSQL の問い合わせが ${String(timeoutMs)}ms 以内に返らなかったので、接続ごと切った（${detail}）`
        : `PostgreSQL へ ${String(timeoutMs)}ms 以内に繋げなかった（${detail}）`,
      cause === undefined ? undefined : { cause },
    );
    this.name = 'PgTimeoutError';
    this.kind = kind;
    this.timeoutMs = timeoutMs;
  }
}

/** 期限で打ち切ったことの知らせ。`sql` は本文の頭だけで、値（バインドした引数）は載せない。 */
export interface PgTimeoutEvent {
  kind: 'query' | 'connect';
  timeoutMs: number;
  sql?: string;
}

const queryTimeout = new AsyncLocalStorage<number>();

/**
 * `fn` の中で打つ問い合わせの期限を `timeoutMs` にする。正当に長い処理を包む口。
 * 入れ子にしたら内側が勝つ。
 */
export function withPgQueryTimeout<T>(timeoutMs: number, fn: () => Promise<T>): Promise<T> {
  return queryTimeout.run(timeoutMs, fn);
}

// プール経由（`pool.query`）の問い合わせは、空きを待った後に別の文脈で `client.query` が呼ばれうる。呼んだ時点の期限を、問い合わせ自身に書いて運ぶ
const TIMEOUT_KEY = Symbol('alteroid.pgQueryTimeoutMs');

const SQL_HEAD_CHARS = 120;

type QueryConfigLike = { text?: unknown; submit?: unknown; [TIMEOUT_KEY]?: number };

function sqlHeadOf(config: unknown): string | undefined {
  const text = typeof config === 'string' ? config : (config as QueryConfigLike).text;
  if (typeof text !== 'string') return undefined;
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > SQL_HEAD_CHARS ? `${flat.slice(0, SQL_HEAD_CHARS)}…` : flat;
}

function isConnectTimeout(error: unknown): boolean {
  const message = error instanceof Error ? error.message : '';
  // pg-pool の空き待ちの期限と、新しく繋ぐ途中の期限の文言
  return (
    message.includes('timeout exceeded when trying to connect') ||
    message.includes('connection timeout')
  );
}

export interface TimedPoolOptions {
  connectionString: string;
  max?: number;
  connectTimeoutMs?: number;
  queryTimeoutMs?: number;
  onTimeout?: (event: PgTimeoutEvent) => void;
}

/**
 * 期限付きのプール（#4655）。
 * - 繋ぐ（空きを待つ）のは `connectTimeoutMs` まで。
 * - 問い合わせは既定 `queryTimeoutMs`、{@link withPgQueryTimeout} の中ではその値まで。過ぎたら接続ごと切る。
 *   pg の `query_timeout` を使わない: あちらは呼び手に失敗を返すだけで、送った問い合わせは接続に載ったまま残り、
 *   トランザクションの接続はそのままプールへ戻って次の借り手を詰まらせるため。切ればプールは捨てて繋ぎ直す。
 * - 貸し出し中の接続の `error` にも常に受け手を置く: 受け手が無いと、切れた接続の `error` がプロセスごと落とすため。
 */
export function createTimedPool(options: TimedPoolOptions): Pool {
  const defaultQueryTimeoutMs = options.queryTimeoutMs ?? PG_QUERY_TIMEOUT_MS;
  const connectTimeoutMs = options.connectTimeoutMs ?? PG_CONNECT_TIMEOUT_MS;
  const report = (event: PgTimeoutEvent): void => {
    try {
      options.onTimeout?.(event);
    } catch {
      // 知らせの失敗で問い合わせの失敗の形を変えない
    }
  };

  class TimedClient extends Client {
    constructor(config?: ClientConfig) {
      super(config);
      // 切れた接続の `error` は、問い合わせの失敗として呼び手へ届く。ここでは落とさないことだけを受け持つ
      this.on('error', () => undefined);
    }

    // pg の多重定義をそのまま受けて渡す
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    override query(config: any, values?: any, callback?: any): any {
      if (config === null || config === undefined || typeof config.submit === 'function') {
        return super.query(config, values, callback);
      }
      const stamped =
        typeof config === 'object' ? (config as QueryConfigLike)[TIMEOUT_KEY] : undefined;
      const timeoutMs = queryTimeout.getStore() ?? stamped ?? defaultQueryTimeoutMs;
      const sql = sqlHeadOf(config);
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        report({ kind: 'query', timeoutMs, ...(sql === undefined ? {} : { sql }) });
        // 切ると、載っている問い合わせも後ろに並んだものも「接続が切れた」で失敗し、プールはこの接続を捨てる。
        // 先に「こちらから閉じている」印（pg の `_ending`）を立てる: 立てないと pg は切断を `error` として出し、
        // `pool.query` はそれを問い合わせの失敗より先に拾って、期限切れではなく「予期せず切れた」として返すため。
        // `end()` を使わない: あちらは相手の応答を待つ閉じ方で、半開きの経路ではいつまでも閉じ終わらないため
        const self = this as unknown as {
          _ending?: boolean;
          connection?: { stream?: { destroy(): void } };
        };
        self._ending = true;
        self.connection?.stream?.destroy();
      }, timeoutMs);
      timer.unref?.();
      const settle = (error: unknown): unknown => {
        clearTimeout(timer);
        return timedOut && error !== undefined && error !== null
          ? new PgTimeoutError('query', timeoutMs, sql ?? '本文なし', error)
          : error;
      };

      const cb: unknown = typeof values === 'function' ? values : callback;
      const args: unknown = typeof values === 'function' ? undefined : values;
      if (typeof cb === 'function') {
        return super.query(config, args as never, (error: unknown, result: unknown) => {
          (cb as (error: unknown, result: unknown) => void)(settle(error), result);
        });
      }
      return (super.query(config, args as never) as Promise<unknown>).then(
        (result) => {
          settle(undefined);
          return result;
        },
        (error: unknown) => {
          throw settle(error);
        },
      );
    }
  }

  class TimedPool extends Pool {
    // pg の多重定義をそのまま受けて渡す
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    override query(config: any, values?: any, callback?: any): any {
      const timeoutMs = queryTimeout.getStore();
      if (timeoutMs === undefined || config === null || config === undefined) {
        return super.query(config, values, callback);
      }
      const stamped =
        typeof config === 'string'
          ? { text: config, [TIMEOUT_KEY]: timeoutMs }
          : typeof config.submit === 'function'
            ? config
            : { ...config, [TIMEOUT_KEY]: timeoutMs };
      return super.query(stamped, values, callback);
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    override connect(callback?: any): any {
      if (typeof callback === 'function') {
        return super.connect((error: Error | undefined, client: unknown, done: unknown) => {
          if (error !== undefined && error !== null && isConnectTimeout(error)) {
            report({ kind: 'connect', timeoutMs: connectTimeoutMs });
            (callback as (...args: unknown[]) => void)(
              new PgTimeoutError('connect', connectTimeoutMs, error.message, error),
              client,
              done,
            );
            return;
          }
          (callback as (...args: unknown[]) => void)(error, client, done);
        });
      }
      return super.connect().catch((error: unknown) => {
        if (!isConnectTimeout(error)) throw error;
        report({ kind: 'connect', timeoutMs: connectTimeoutMs });
        throw new PgTimeoutError(
          'connect',
          connectTimeoutMs,
          error instanceof Error ? error.message : String(error),
          error,
        );
      });
    }
  }

  return new TimedPool({
    connectionString: options.connectionString,
    ...(options.max === undefined ? {} : { max: options.max }),
    connectionTimeoutMillis: connectTimeoutMs,
    // 半開きの経路を OS にも見つけさせる。期限より遅いが、借り手の居ない空き接続の死を拾う
    keepAlive: true,
    keepAliveInitialDelayMillis: 10_000,
    Client: TimedClient,
  });
}
