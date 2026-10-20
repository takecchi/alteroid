import {
  HTTP_TIMING_SLOW_MS,
  HttpTimingWindow,
  RequestTiming,
  describeHttpTimingSample,
  runWithRequestTiming,
  type HttpTimingSample,
  type JournalStore,
} from '@alteroid/core';
import type { Context, MiddlewareHandler } from 'hono';
import { routePath } from 'hono/route';

// HTTP API の要求ごとの時間を測る（#5089）。
// - 応答に `Server-Timing` を付ける（ブラウザの開発者ツールでそのまま読める）
// - 窓（既定 10 分）ごとに経路で束ね、日誌へ `http_timing` を1行書く。要求ごとには書かない: 記録自体を重くしないため
// - 遅い要求（`HTTP_TIMING_SLOW_MS` 以上）は、その場で stderr へ1行出す

export const HTTP_TIMING_WINDOW_MS = 10 * 60_000;
/** 1つの窓で stderr へ出す遅い要求の行の上限。超えた分は窓を閉じるときに数だけ言う */
const SLOW_LINES_PER_WINDOW = 30;

export interface HttpTimingRecorder {
  record(sample: HttpTimingSample): void;
}

/** 要求の経路の型（`GET /conversations/:id`）。どの経路にも当たらなかった要求は値を載せずにまとめる */
function routeOf(c: Context): string {
  let path: string;
  try {
    path = routePath(c, -1);
  } catch {
    path = '';
  }
  if (path === '' || path === '*' || path === '/*') return `${c.req.method} （経路なし）`;
  return `${c.req.method} ${path}`;
}

function formatServerTiming(sample: HttpTimingSample): string {
  const dur = (value: number): string => value.toFixed(1);
  const rest = Math.max(0, sample.totalMs - sample.db.wallMs - sample.serializeMs);
  return [
    `db;dur=${dur(sample.db.wallMs)};desc="DB ${String(sample.db.count)} queries"`,
    ...(sample.db.waitMs > 0 ? [`dbwait;dur=${dur(sample.db.waitMs)};desc="pool wait"`] : []),
    `serialize;dur=${dur(sample.serializeMs)}`,
    `app;dur=${dur(rest)}`,
    `total;dur=${dur(sample.totalMs)}`,
  ].join(', ');
}

/**
 * 要求ごとに測るミドルウェア。経路・認証より前に置く（認証の DB 引きも数えるため）。
 * SSE（`text/event-stream`）は数えない: 応答の頭を返した時点で next() が返り、流れている時間は要求の遅さではないため
 */
export function httpTimingMiddleware(
  recorder: HttpTimingRecorder | undefined,
  now: () => number = () => performance.now(),
): MiddlewareHandler {
  return async (c, next) => {
    const started = now();
    const timing = new RequestTiming(now);
    let serializeMs = 0;
    let bytes: number | undefined;
    // `c.json` と同じ応答を作りつつ、文字列にする時間と大きさを測る（hono の `c.json` は `JSON.stringify` して `Content-Type` を既定で付けるだけ）
    const json = ((object: unknown, arg?: unknown, headers?: Record<string, string | string[]>) => {
      const t = now();
      const text = JSON.stringify(object);
      serializeMs += now() - t;
      bytes = (bytes ?? 0) + Buffer.byteLength(text);
      return c.body(text, arg as never, { 'Content-Type': 'application/json', ...headers });
    }) as unknown as typeof c.json;
    c.json = json;

    await runWithRequestTiming(timing, next);

    const contentType = c.res.headers.get('content-type') ?? '';
    if (contentType.startsWith('text/event-stream')) return;
    const totalMs = now() - started;
    if (bytes === undefined) {
      const declared = Number(c.res.headers.get('content-length') ?? Number.NaN);
      if (Number.isFinite(declared)) bytes = declared;
    }
    const sample: HttpTimingSample = {
      route: routeOf(c),
      status: c.res.status,
      at: new Date().toISOString(),
      totalMs,
      db: timing.snapshot(),
      serializeMs,
      ...(bytes === undefined ? {} : { bytes }),
    };
    try {
      c.res.headers.set('Server-Timing', formatServerTiming(sample));
    } catch {
      // 頭を変えられない応答（外から受け取った Response をそのまま返す口）は付けずに通す
    }
    recorder?.record(sample);
  };
}

export interface HttpTimingCollector extends HttpTimingRecorder {
  /** 窓を閉じて日誌へ書く。要求が無ければ書かない */
  flush(): Promise<void>;
  stop(): Promise<void>;
}

/** 窓で束ねて日誌へ書く担い手。`intervalMs` ごとに書き、`stop()` で最後の窓も書く */
export function startHttpTimingCollector(options: {
  journal: Pick<JournalStore, 'append'>;
  intervalMs?: number;
  writeLine: (line: string) => void;
  onDropped: (error: unknown) => void;
  clock?: () => number;
}): HttpTimingCollector {
  const clock = options.clock ?? Date.now;
  const window = new HttpTimingWindow(clock());
  let slowLines = 0;
  let slowSuppressed = 0;
  let flushing: Promise<void> = Promise.resolve();

  const flush = (): Promise<void> => {
    const record = window.drain(clock());
    const suppressed = slowSuppressed;
    slowLines = 0;
    slowSuppressed = 0;
    if (suppressed > 0) {
      options.writeLine(
        `alteroidd: この窓の遅い要求のうち ${String(suppressed)} 件は行を省きました（日誌の http_timing に上位が載る）\n`,
      );
    }
    if (record === null) return flushing;
    // 前の書き込みの後ろに並べる: 窓の順と日誌の順を入れ替えないため
    flushing = flushing.then(() =>
      options.journal
        .append({ type: 'http_timing', ...record })
        .then(() => undefined)
        .catch((error: unknown) => {
          options.onDropped(error);
        }),
    );
    return flushing;
  };

  const timer = setInterval(() => {
    void flush();
  }, options.intervalMs ?? HTTP_TIMING_WINDOW_MS);
  timer.unref?.();

  return {
    record(sample) {
      window.record(sample);
      if (sample.totalMs < HTTP_TIMING_SLOW_MS) return;
      if (slowLines >= SLOW_LINES_PER_WINDOW) {
        slowSuppressed += 1;
        return;
      }
      slowLines += 1;
      options.writeLine(`alteroidd: 遅い要求 ${describeHttpTimingSample(sample)}\n`);
    },
    flush,
    async stop() {
      clearInterval(timer);
      await flush();
    },
  };
}
