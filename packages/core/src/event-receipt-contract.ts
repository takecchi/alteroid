import {
  EVENT_RECEIPT_RETENTION_MS,
  type EventReceipt,
  type EventReceiptStore,
} from './event-receipt.js';
import { expectNulRejected } from './nul-contract-support.js';

// vitest に依存しない: 3実装（メモリ・fs・pg）の試験から同じものを呼ぶため。
export async function verifyEventReceiptStoreContract(store: EventReceiptStore): Promise<void> {
  function fail(message: string): never {
    throw new Error(`EventReceiptStore の契約違反: ${message}`);
  }
  const t0 = '2026-10-01T00:00:00.000Z';
  const later = (ms: number): string => new Date(Date.parse(t0) + ms).toISOString();
  const make = (over: Partial<EventReceipt>): EventReceipt => ({
    scope: 'integration:k-a',
    source: 'virchamate',
    idempotencyKey: 'delivery-1',
    eventId: 'ev-1',
    at: t0,
    ...over,
  });
  const find = (receipt: EventReceipt, now: string) =>
    store.findEventReceipt(receipt.scope, receipt.source, receipt.idempotencyKey, now);

  const first = make({});
  if (JSON.stringify(await store.recordEventReceipt(first)) !== JSON.stringify(first)) {
    fail('初めての組を記録したとき、記録した行をそのまま返さない');
  }
  if (JSON.stringify(await find(first, later(1000))) !== JSON.stringify(first)) {
    fail('記録した行をそのまま引けない');
  }

  const second = make({ eventId: 'ev-2', at: later(2000) });
  if ((await store.recordEventReceipt(second)).eventId !== 'ev-1') {
    fail('保持期間内の同じ組を記録したとき、先に入った行を返さない');
  }
  if ((await find(first, later(3000)))?.eventId !== 'ev-1') {
    fail('保持期間内の同じ組の2件目で、先に入った行が書き換わった');
  }

  for (const [label, other] of [
    ['scope', make({ scope: 'integration:k-b', eventId: 'ev-scope' })],
    ['source', make({ source: 'other', eventId: 'ev-source' })],
    ['idempotencyKey', make({ idempotencyKey: 'delivery-2', eventId: 'ev-key' })],
  ] as const) {
    if ((await find(other, later(1000))) !== null) {
      fail(`${label} だけが違う組を、記録が無いのに同じものとして引いた`);
    }
    if ((await store.recordEventReceipt(other)).eventId !== other.eventId) {
      fail(`${label} だけが違う組を、別の組として記録しない`);
    }
  }

  if ((await find(first, later(EVENT_RECEIPT_RETENTION_MS + 1))) !== null) {
    fail('保持期間を過ぎた行を引いた');
  }

  const afterExpiry = make({ eventId: 'ev-3', at: later(EVENT_RECEIPT_RETENTION_MS + 1) });
  if ((await store.recordEventReceipt(afterExpiry)).eventId !== 'ev-3') {
    fail('保持期間を過ぎた同じ組を、新しい行として記録しない');
  }
  if ((await find(afterExpiry, afterExpiry.at))?.eventId !== 'ev-3') {
    fail('保持期間を過ぎてから記録し直した行を引けない');
  }
  if ((await find(make({ source: 'other' }), t0)) !== null) {
    fail('保持期間を過ぎた行が、後の記録のあとも残っている');
  }

  if (
    (await store.findEventReceipt('integration:k-a', 'virchamate', 'delivery-1\u0000', t0)) !== null
  ) {
    fail('NUL を含む鍵で引いたとき null を返さない');
  }
  for (const field of ['scope', 'source', 'idempotencyKey', 'eventId'] as const) {
    await expectNulRejected(
      fail,
      `${field} に NUL を含む記録`,
      () => store.recordEventReceipt(make({ [field]: 'secret-\u0000-value' })),
      'secret-',
    );
  }
}
