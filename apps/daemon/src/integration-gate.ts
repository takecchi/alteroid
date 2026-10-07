export type IntegrationRouteVerdict =
  | { allowed: true; via: 'body-source' }
  | { allowed: true; via: 'path-source' }
  | { allowed: true; via: 'attachment-upload' }
  | { allowed: false };

// 添付の読み出し（`GET /attachments/:id` など）は通さない: 鍵は上げるだけで読めない設計のため。それ以外はすべて既定で拒否する。
export function judgeIntegrationRoute(
  method: string,
  path: string,
  keySource: string,
): IntegrationRouteVerdict {
  if (method.toUpperCase() !== 'POST') return { allowed: false };
  if (path === '/events') return { allowed: true, via: 'body-source' };
  if (path === '/attachments') return { allowed: true, via: 'attachment-upload' };
  const prefix = '/events/';
  if (!path.startsWith(prefix)) return { allowed: false };
  const segment = path.slice(prefix.length);
  if (segment.length === 0 || segment.includes('/')) return { allowed: false };
  let decoded: string;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    return { allowed: false };
  }
  return decoded === keySource ? { allowed: true, via: 'path-source' } : { allowed: false };
}

const WINDOW_MS = 60_000;
const PRUNE_THRESHOLD = 1024;

export type RateVerdict = { ok: true } | { ok: false; retryAfterSeconds: number };

export interface FixedWindowRateLimiter {
  consume(keyId: string, limitPerMinute: number): RateVerdict;
}

// 再起動で数え直しにする（永続しない）: 外のサービスの暴走を止める守りであって、課金の台帳ではないため。
export function createFixedWindowRateLimiter(now: () => number): FixedWindowRateLimiter {
  const entries = new Map<string, { windowStart: number; count: number }>();
  return {
    consume(keyId, limitPerMinute) {
      const t = now();
      const windowStart = Math.floor(t / WINDOW_MS) * WINDOW_MS;
      if (entries.size > PRUNE_THRESHOLD) {
        for (const [id, entry] of entries) {
          if (entry.windowStart !== windowStart) entries.delete(id);
        }
      }
      let entry = entries.get(keyId);
      if (entry === undefined || entry.windowStart !== windowStart) {
        entry = { windowStart, count: 0 };
        entries.set(keyId, entry);
      }
      if (entry.count >= limitPerMinute) {
        return {
          ok: false,
          retryAfterSeconds: Math.max(1, Math.ceil((windowStart + WINDOW_MS - t) / 1000)),
        };
      }
      entry.count += 1;
      return { ok: true };
    },
  };
}
