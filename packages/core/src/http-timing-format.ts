import { describeHttpTimingSample, formatBytes } from './http-timing.js';
import type { JournalEntry } from './schema.js';
import { formatSeconds } from './turn-timing-format.js';

// `http_timing`（#5089）を人が読む形にする。`journal_read` の1行・本文と、`self_status` の要約が同じ言い方を使う
export type HttpTimingEntry = Extract<JournalEntry, { type: 'http_timing' }>;
type RouteSummary = HttpTimingEntry['routes'][number];

function describeRoute(route: RouteSummary): string {
  const dbPerRequest = route.count === 0 ? 0 : route.db.count / route.count;
  return (
    `${route.route}: ${String(route.count)} 回・中央値 ${formatSeconds(route.p50Ms)}・90% 点 ${formatSeconds(route.p90Ms)}` +
    `・最大 ${formatSeconds(route.maxMs)}・合計 ${formatSeconds(route.totalMs)}` +
    `（DB 1回あたり ${dbPerRequest.toFixed(1)} 本・DB の合計 ${formatSeconds(route.db.wallMs)}` +
    (route.db.waitMs > 0 ? `・空き待ち ${formatSeconds(route.db.waitMs)}` : '') +
    `・整形 ${formatSeconds(route.serializeMs)}` +
    (route.count === 0 ? '' : `・本文 平均 ${formatBytes(Math.round(route.bytes / route.count))}`) +
    `・最大 ${formatBytes(route.maxBytes)}` +
    (route.errors > 0 ? `・500 番台 ${String(route.errors)} 回` : '') +
    '）'
  );
}

export function describeHttpTimingHead(entry: HttpTimingEntry): string {
  const [top] = entry.routes;
  const [slowest] = entry.slowest;
  return (
    `[http_timing ${String(Math.max(1, Math.round(entry.windowMs / 60_000)))}分の窓] 要求 ${String(entry.requests)} 回` +
    (top === undefined
      ? ''
      : `・時間を最も食った経路 ${top.route} 合計 ${formatSeconds(top.totalMs)}`) +
    (slowest === undefined
      ? ''
      : `・最も遅い要求 ${slowest.route} ${formatSeconds(slowest.totalMs)}`)
  );
}

export function describeHttpTimingBody(entry: HttpTimingEntry): string {
  return [
    `窓の始まり ${entry.windowStartedAt}`,
    '経路（時間を食った順）:',
    ...entry.routes.map((route) => `- ${describeRoute(route)}`),
    ...(entry.omittedRoutes === undefined
      ? []
      : [`- ほかに ${String(entry.omittedRoutes)} 経路（短いので省いた）`]),
    '遅かった要求:',
    ...entry.slowest.map((sample) => `- ${sample.at} ${describeHttpTimingSample(sample)}`),
  ].join('\n');
}

const SUMMARY_ROUTES = 8;
const SUMMARY_SLOWEST = 5;

/**
 * 直近の窓を足し合わせて、遅い経路の上位を出す（`self_status` の節）。
 * 中央値・90% 点は窓をまたいで足せないので、経路ごとに「窓の 90% 点の最大」と平均で言う
 */
export function renderHttpTimingSummary(entries: readonly HttpTimingEntry[]): string {
  if (entries.length === 0) {
    return 'HTTP API の時間: まだ記録が無い（http_timing は、この版で要求を受けると 10 分ごとに書かれる）。';
  }
  const byRoute = new Map<
    string,
    {
      count: number;
      totalMs: number;
      maxMs: number;
      p90Ms: number;
      dbCount: number;
      dbWallMs: number;
      bytes: number;
      maxBytes: number;
    }
  >();
  let requests = 0;
  for (const entry of entries) {
    requests += entry.requests;
    for (const route of entry.routes) {
      const acc = byRoute.get(route.route) ?? {
        count: 0,
        totalMs: 0,
        maxMs: 0,
        p90Ms: 0,
        dbCount: 0,
        dbWallMs: 0,
        bytes: 0,
        maxBytes: 0,
      };
      acc.count += route.count;
      acc.totalMs += route.totalMs;
      acc.maxMs = Math.max(acc.maxMs, route.maxMs);
      acc.p90Ms = Math.max(acc.p90Ms, route.p90Ms);
      acc.dbCount += route.db.count;
      acc.dbWallMs += route.db.wallMs;
      acc.bytes += route.bytes;
      acc.maxBytes = Math.max(acc.maxBytes, route.maxBytes);
      byRoute.set(route.route, acc);
    }
  }
  const routes = [...byRoute.entries()]
    .sort((a, b) => b[1].totalMs - a[1].totalMs)
    .slice(0, SUMMARY_ROUTES)
    .map(([route, acc]) => {
      const mean = acc.count === 0 ? 0 : Math.round(acc.totalMs / acc.count);
      const dbShare = acc.totalMs === 0 ? 0 : Math.round((acc.dbWallMs / acc.totalMs) * 100);
      return (
        `  - ${route}: ${String(acc.count)} 回・平均 ${formatSeconds(mean)}・窓の 90% 点の最大 ${formatSeconds(acc.p90Ms)}` +
        `・最大 ${formatSeconds(acc.maxMs)}・合計 ${formatSeconds(acc.totalMs)}（うち DB ${String(dbShare)}%` +
        `・1回あたり DB ${(acc.count === 0 ? 0 : acc.dbCount / acc.count).toFixed(1)} 本` +
        `・本文 平均 ${formatBytes(acc.count === 0 ? 0 : Math.round(acc.bytes / acc.count))}・最大 ${formatBytes(acc.maxBytes)}）`
      );
    });
  const slowest = entries
    .flatMap((entry) => entry.slowest)
    .sort((a, b) => b.totalMs - a.totalMs)
    .slice(0, SUMMARY_SLOWEST)
    .map((sample) => `  - ${sample.at} ${describeHttpTimingSample(sample)}`);
  const oldest = entries.reduce(
    (min, entry) => (entry.windowStartedAt < min ? entry.windowStartedAt : min),
    entries[0]?.windowStartedAt ?? '',
  );
  return [
    `HTTP API の時間（${String(entries.length)} 窓・要求 ${String(requests)} 回・${oldest} から。詳細は journal_read types=["http_timing"]）:`,
    '- 時間を食っている経路（合計の多い順）:',
    ...routes,
    '- 最も遅かった要求:',
    ...slowest,
  ].join('\n');
}
