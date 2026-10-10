import { assertNoNul } from './nul-guard.js';

/**
 * 無期限にしない: 外部イベントは送られ続けるので、覚えた行が際限なく増えるため。
 * 送り直しは時間切れの直後（分の単位）に来るので、7日あれば足りる。
 */
export const EVENT_RECEIPT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export const EVENT_IDEMPOTENCY_KEY_MAX_LENGTH = 200;

export interface EventReceipt {
  scope: string;
  source: string;
  idempotencyKey: string;
  eventId: string;
  at: string;
}

/**
 * 受信箱の行に持たせない: 受信箱の行は処理し終えると消えるため。
 *
 * NUL（3実装とも）: 書く口は `scope`・`source`・`idempotencyKey`・`eventId` の NUL を `NulNotAllowedError` で断る。
 * 引く口は NUL を含む鍵で引かれても断らず `null` を返す。
 */
export interface EventReceiptStore {
  findEventReceipt(
    scope: string,
    source: string,
    idempotencyKey: string,
    now: string,
  ): Promise<EventReceipt | null>;
  /**
   * 記録する。保持期間内の同じ組が既に在れば書き換えずにそれを返す（先に入ったほうが勝つ）。
   * 保持期間を過ぎた行（同じ組を含む）は、このときに消すか上書きする。
   */
  recordEventReceipt(receipt: EventReceipt): Promise<EventReceipt>;
}

export function eventReceiptCutoff(now: string): string {
  return new Date(Date.parse(now) - EVENT_RECEIPT_RETENTION_MS).toISOString();
}

export function assertEventReceiptWritable(receipt: EventReceipt): void {
  assertNoNul('scope', receipt.scope);
  assertNoNul('source', receipt.source);
  assertNoNul('idempotencyKey', receipt.idempotencyKey);
  assertNoNul('eventId', receipt.eventId);
}
