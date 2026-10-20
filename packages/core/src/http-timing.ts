import type { RequestDbTiming } from './request-timing.js';

// HTTP の要求の時間を窓ごとに経路で束ねる（#5089）。日誌へは窓ごとに1行だけ書く: 要求ごとに書くと、記録そのものが遅さの元になるため

/** これより遅い要求は、窓を待たずにその場で stderr へ1行出す */
export const HTTP_TIMING_SLOW_MS = 1_000;

/** 日誌の1行に載せる経路の数。超えた分は数だけ残す */
export const HTTP_TIMING_TOP_ROUTES = 20;
/** 日誌の1行に載せる、遅かった要求の数 */
export const HTTP_TIMING_TOP_SLOWEST = 10;
/** 経路ごとに覚えておく時間の数。超えたら標本を間引く（中央値・90% 点は概算になる） */
const DURATIONS_PER_ROUTE = 2_000;

export interface HttpTimingSample {
  /** `GET /conversations/:id` の形。値の入った実際のパスは載せない */
  route: string;
  status: number;
  at: string;
  totalMs: number;
  db: RequestDbTiming;
  /** 応答の JSON を文字列にした時間 */
  serializeMs: number;
  /** 応答の本文の大きさ（分かるときだけ） */
  bytes?: number;
}

export interface HttpTimingRouteSummary {
  route: string;
  count: number;
  errors: number;
  p50Ms: number;
  p90Ms: number;
  maxMs: number;
  totalMs: number;
  db: { count: number; totalMs: number; wallMs: number; waitMs: number };
  serializeMs: number;
  bytes: number;
  maxBytes: number;
}

export interface HttpTimingSlowSample {
  route: string;
  status: number;
  at: string;
  totalMs: number;
  db: {
    count: number;
    totalMs: number;
    wallMs: number;
    waitMs: number;
    slowestMs: number;
    slowestSql?: string;
  };
  serializeMs: number;
  bytes?: number;
}

/** 日誌の `http_timing` の行（`type`・`id`・`at` を除く） */
export interface HttpTimingWindowRecord {
  windowStartedAt: string;
  windowMs: number;
  requests: number;
  routes: HttpTimingRouteSummary[];
  omittedRoutes?: number;
  slowest: HttpTimingSlowSample[];
}

interface RouteAccumulator {
  count: number;
  errors: number;
  durations: number[];
  maxMs: number;
  totalMs: number;
  dbCount: number;
  dbTotalMs: number;
  dbWallMs: number;
  dbWaitMs: number;
  serializeMs: number;
  bytes: number;
  maxBytes: number;
}

const ms = (value: number): number => Math.max(0, Math.round(value));

export class HttpTimingWindow {
  #startedAt: number;
  #requests = 0;
  #routes = new Map<string, RouteAccumulator>();
  #slowest: HttpTimingSample[] = [];
  readonly #random: () => number;

  constructor(startedAt: number, random: () => number = Math.random) {
    this.#startedAt = startedAt;
    this.#random = random;
  }

  get requests(): number {
    return this.#requests;
  }

  record(sample: HttpTimingSample): void {
    this.#requests += 1;
    let route = this.#routes.get(sample.route);
    if (route === undefined) {
      route = {
        count: 0,
        errors: 0,
        durations: [],
        maxMs: 0,
        totalMs: 0,
        dbCount: 0,
        dbTotalMs: 0,
        dbWallMs: 0,
        dbWaitMs: 0,
        serializeMs: 0,
        bytes: 0,
        maxBytes: 0,
      };
      this.#routes.set(sample.route, route);
    }
    route.count += 1;
    if (sample.status >= 500) route.errors += 1;
    if (route.durations.length < DURATIONS_PER_ROUTE) {
      route.durations.push(sample.totalMs);
    } else {
      // 貯水池の間引き: 窓の頭に偏らず、どの要求も同じ確率で残る
      const slot = Math.floor(this.#random() * route.count);
      if (slot < DURATIONS_PER_ROUTE) route.durations[slot] = sample.totalMs;
    }
    route.maxMs = Math.max(route.maxMs, sample.totalMs);
    route.totalMs += sample.totalMs;
    route.dbCount += sample.db.count;
    route.dbTotalMs += sample.db.totalMs;
    route.dbWallMs += sample.db.wallMs;
    route.dbWaitMs += sample.db.waitMs;
    route.serializeMs += sample.serializeMs;
    if (sample.bytes !== undefined) {
      route.bytes += sample.bytes;
      route.maxBytes = Math.max(route.maxBytes, sample.bytes);
    }

    this.#slowest.push(sample);
    this.#slowest.sort((a, b) => b.totalMs - a.totalMs);
    if (this.#slowest.length > HTTP_TIMING_TOP_SLOWEST)
      this.#slowest.length = HTTP_TIMING_TOP_SLOWEST;
  }

  /** 窓を閉じて行を返し、次の窓を `now` から始める。要求が1つも無ければ null（行を書かない） */
  drain(now: number): HttpTimingWindowRecord | null {
    const startedAt = this.#startedAt;
    const requests = this.#requests;
    const routes = this.#routes;
    const slowest = this.#slowest;
    this.#startedAt = now;
    this.#requests = 0;
    this.#routes = new Map();
    this.#slowest = [];
    if (requests === 0) return null;

    const summaries = [...routes.entries()]
      .map(([route, acc]): HttpTimingRouteSummary => {
        const sorted = [...acc.durations].sort((a, b) => a - b);
        return {
          route,
          count: acc.count,
          errors: acc.errors,
          p50Ms: ms(percentile(sorted, 0.5)),
          p90Ms: ms(percentile(sorted, 0.9)),
          maxMs: ms(acc.maxMs),
          totalMs: ms(acc.totalMs),
          db: {
            count: acc.dbCount,
            totalMs: ms(acc.dbTotalMs),
            wallMs: ms(acc.dbWallMs),
            waitMs: ms(acc.dbWaitMs),
          },
          serializeMs: ms(acc.serializeMs),
          bytes: acc.bytes,
          maxBytes: acc.maxBytes,
        };
      })
      // 時間を食っている順: 1回が遅い経路と、速いが回数の多い経路を同じ物差しで並べる
      .sort((a, b) => b.totalMs - a.totalMs || b.maxMs - a.maxMs);
    const omitted = summaries.length - HTTP_TIMING_TOP_ROUTES;
    return {
      windowStartedAt: new Date(startedAt).toISOString(),
      windowMs: ms(now - startedAt),
      requests,
      routes: summaries.slice(0, HTTP_TIMING_TOP_ROUTES),
      ...(omitted > 0 ? { omittedRoutes: omitted } : {}),
      slowest: slowest.map((sample) => ({
        route: sample.route,
        status: sample.status,
        at: sample.at,
        totalMs: ms(sample.totalMs),
        db: {
          count: sample.db.count,
          totalMs: ms(sample.db.totalMs),
          wallMs: ms(sample.db.wallMs),
          waitMs: ms(sample.db.waitMs),
          slowestMs: ms(sample.db.slowestMs),
          ...(sample.db.slowestSql === undefined ? {} : { slowestSql: sample.db.slowestSql }),
        },
        serializeMs: ms(sample.serializeMs),
        ...(sample.bytes === undefined ? {} : { bytes: sample.bytes }),
      })),
    };
  }
}

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1);
  return sorted[Math.max(0, index)] ?? 0;
}

function seconds(value: number): string {
  if (value < 1_000) return `${String(Math.round(value))}ms`;
  return `${(value / 1_000).toFixed(1)}秒`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${String(bytes)}B`;
  if (bytes < 1_024 * 1_024) return `${(bytes / 1_024).toFixed(1)}KB`;
  return `${(bytes / 1_024 / 1_024).toFixed(1)}MB`;
}

/** 1要求の内訳を1行で。遅い要求の stderr の行と、日誌の「遅かった要求」の行で同じ言い方にする */
export function describeHttpTimingSample(sample: {
  route: string;
  status: number;
  totalMs: number;
  db: {
    count: number;
    totalMs: number;
    wallMs: number;
    waitMs: number;
    slowestMs?: number;
    slowestSql?: string;
  };
  serializeMs: number;
  bytes?: number;
}): string {
  const rest = Math.max(0, sample.totalMs - sample.db.wallMs - sample.serializeMs);
  const parts = [
    `DB ${String(sample.db.count)}本 ${seconds(sample.db.wallMs)}` +
      (sample.db.waitMs > 0 ? `（空き待ち ${seconds(sample.db.waitMs)}）` : ''),
    `整形 ${seconds(sample.serializeMs)}`,
    `それ以外 ${seconds(rest)}`,
  ];
  if (sample.bytes !== undefined) parts.push(`本文 ${formatBytes(sample.bytes)}`);
  const slowest =
    sample.db.slowestSql !== undefined && sample.db.slowestMs !== undefined && sample.db.count > 0
      ? `。最も長い問い合わせ ${seconds(sample.db.slowestMs)}: ${sample.db.slowestSql}`
      : '';
  return `${sample.route} ${String(sample.status)} ${seconds(sample.totalMs)}（${parts.join('・')}）${slowest}`;
}
