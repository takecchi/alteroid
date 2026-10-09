import { assertNoNul, hasNul } from './nul-guard.js';

/**
 * `POST /events` の重複キー（`idempotencyKey`）の記録（#3531）。
 *
 * 受信箱（`InboxStore`）には持たせない: 受信箱の行は処理を終えたら消える（配達の状態）が、送る側の再送は処理の後にも来る。
 * 「同じ送り手・同じ source・同じキー」を覚える期間は受信箱の寿命とは別なので、別の器に持つ。
 */
export const eventIdempotencyLimits = {
  /** キーの長さ（UTF-16 コード単位）の上限。UUID・ULID・`<リポジトリ>#<run id>` のような外のサービスの識別子が入る長さを取り、本文の代わりに使われないよう締める。 */
  keyMaxLength: 200,
  /**
   * 覚えておく期間（7日）。
   * 無期限にしない: 外部イベントの流量に比例して記録が際限なく増える（fs は全件を1ファイルに書き直す）うえ、
   * 送る側の再送は時間切れの直後から長くても数時間〜数日の間に起きるもので、数か月後に同じキーで来るものは「重複」ではなく別の出来事の使い回しとみなすほうが安全なため。
   * 期限が切れたキーは新規として積む（取りこぼしより二重のほうが害が小さい。受信箱の方針と同じ）。
   */
  retentionMs: 7 * 24 * 60 * 60 * 1000,
} as const;

/** 「同じ送り手」の単位。連携の鍵は鍵の id、人間のアカウントはアカウントの id、operator は固定の1つ。 */
export interface EventIdempotencyScope {
  /** `integration:<keyId>` / `account:<accountId>` / `operator`。鍵を回して別の鍵になれば別の送り手として扱う。 */
  sender: string;
  source: string;
  key: string;
}

export type ClaimEventIdempotencyOutcome =
  | { status: 'claimed' }
  /** 期限内に同じ組が在った。`eventId` は1件目の id。 */
  | { status: 'duplicate'; eventId: string };

export interface EventIdempotencyStore {
  /**
   * 組 `(sender, source, key)` を `eventId` のものとして1操作で取る。
   * 在って期限内（`at` の時点で `at - retentionMs` より新しい）なら何も書かず `duplicate`。期限切れの行は取って代わる。
   * 並行して2本届いても取れるのは1本だけ（fs は排他区間、pg は一意索引への `insert ... on conflict`）。
   * `at` は ISO 時刻。期限切れの他の行もこのときに片付けてよい。
   * NUL を含む欄は `NulNotAllowedError` で断る（3実装で揃える）。
   */
  claim(
    scope: EventIdempotencyScope,
    eventId: string,
    at: string,
  ): Promise<ClaimEventIdempotencyOutcome>;
  /**
   * 取った組を手放す。受信箱へ積めなかった（503）とき、送り直しが `duplicate` で断られないように戻す。
   * 在って `eventId` が一致するときだけ消す（別の取り直しを消さない）。無ければ何もしない。NUL を含めば何もしない。
   */
  release(scope: EventIdempotencyScope, eventId: string): Promise<void>;
}

export function assertEventIdempotencyInput(
  scope: EventIdempotencyScope,
  eventId: string,
  at: string,
): void {
  assertNoNul('idempotency sender', scope.sender);
  assertNoNul('idempotency source', scope.source);
  assertNoNul('idempotency key', scope.key);
  assertNoNul('idempotency eventId', eventId);
  if (Number.isNaN(Date.parse(at))) throw new Error('idempotency: 時刻が読めない');
}

export function scopeHasNul(scope: EventIdempotencyScope): boolean {
  return hasNul(scope.sender) || hasNul(scope.source) || hasNul(scope.key);
}

/** `at` の時点で、`recordedAt` に取られた記録がまだ有効か。 */
export function isEventIdempotencyLive(recordedAt: string, at: string): boolean {
  return Date.parse(recordedAt) > Date.parse(at) - eventIdempotencyLimits.retentionMs;
}

/** 器に置くための1行（fs とメモリが共有する。pg は列に分ける）。 */
export interface EventIdempotencyRow {
  sender: string;
  source: string;
  key: string;
  eventId: string;
  at: string;
}

/** fs とメモリが共有する純関数。`rows` を壊さず、次の行の並びと結果を返す。 */
export function claimInRows(
  rows: readonly EventIdempotencyRow[],
  scope: EventIdempotencyScope,
  eventId: string,
  at: string,
): { rows: EventIdempotencyRow[]; outcome: ClaimEventIdempotencyOutcome } {
  const live = rows.filter((row) => isEventIdempotencyLive(row.at, at));
  const same = live.find(
    (row) => row.sender === scope.sender && row.source === scope.source && row.key === scope.key,
  );
  if (same !== undefined) {
    return { rows: live, outcome: { status: 'duplicate', eventId: same.eventId } };
  }
  return {
    rows: [...live, { ...scope, eventId, at }],
    outcome: { status: 'claimed' },
  };
}

export function releaseInRows(
  rows: readonly EventIdempotencyRow[],
  scope: EventIdempotencyScope,
  eventId: string,
): EventIdempotencyRow[] {
  return rows.filter(
    (row) =>
      !(
        row.sender === scope.sender &&
        row.source === scope.source &&
        row.key === scope.key &&
        row.eventId === eventId
      ),
  );
}
