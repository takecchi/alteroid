/**
 * 連携の鍵（`@alteroid/core` の `integration-key.ts`）の門番が使う純粋な部品。
 *
 * **ここに置くのは「どの口を通すか」と「回数の数え方」だけである。** 行為ごとのスコープの一覧ではない
 * （`.claude/skills/auth-and-access/SKILL.md`）。鍵の種類そのものが「固定の1 source で外部イベントを送る」
 * という1つの能力だけを表し、**それ以外はすべて既定で拒否**する。
 */

/** 鍵が通れる口の判定結果。`events` は本文の `source` を、ハンドラの側で鍵の source と突き合わせる。 */
export type IntegrationRouteVerdict =
  | { allowed: true; via: 'body-source' }
  | { allowed: true; via: 'path-source' }
  /** `POST /attachments`（自分の送信に付ける添付のアップロード。#3113 段3）。本文の上限は添付の上限に任せる。 */
  | { allowed: true; via: 'attachment-upload' }
  | { allowed: false };

/**
 * 連携の鍵が通れるのは `POST /events`（本文の source が鍵の source と一致するとき）と
 * `POST /events/:source`（パスが一致するとき）、そして**自分の送信に付ける添付のアップロード**
 * `POST /attachments`（#3113 段3）だけ。後者2つはここで判定する。前者はハンドラが本文を見て判定する。
 * 添付の読み出し（`GET /attachments/:id` `GET /attachments/:id/meta`）は通さない（鍵は上げるだけで、読めない）。
 * **それ以外（メソッド違い・別のパス・末尾スラッシュ・デコードできないパス）はすべて拒否。**
 */
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
/** この数を超えて鍵の記録が溜まったら、過ぎた窓の分を捨てる（鍵ごとに1行しか持たないので上限は緩い）。 */
const PRUNE_THRESHOLD = 1024;

export type RateVerdict = { ok: true } | { ok: false; retryAfterSeconds: number };

export interface FixedWindowRateLimiter {
  /** 鍵1回ぶんの受け付けを数える。上限を超えていたら、数えずに待ち秒数を返す。 */
  consume(keyId: string, limitPerMinute: number): RateVerdict;
}

/**
 * メモリ上の固定窓（1分）。**依存なし。時計は注入する**（テストは偽の時計で動かし、実時間を待たない）。
 * 再起動で数え直しになる（永続しない。外のサービスの暴走を止める守りであって、課金の台帳ではない）。
 */
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
