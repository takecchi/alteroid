import { eventIdempotencyLimits } from './event-idempotency.js';
import type { EventIdempotencyScope, EventIdempotencyStore } from './event-idempotency.js';
import { expectNulRejected } from './nul-contract-support.js';

export async function verifyEventIdempotencyStoreContract(
  store: EventIdempotencyStore,
): Promise<void> {
  function fail(message: string): never {
    throw new Error(`EventIdempotencyStore の契約違反: ${message}`);
  }
  const t0 = '2026-03-01T00:00:00.000Z';
  const scope = (over: Partial<EventIdempotencyScope> = {}): EventIdempotencyScope => ({
    sender: 'integration:k1',
    source: 'ci',
    key: 'run-1',
    ...over,
  });
  const claim = (s: EventIdempotencyScope, id: string, at = t0) => store.claim(s, id, at);

  const first = await claim(scope(), 'e1');
  if (first.status !== 'claimed') fail('最初の取得は claimed');
  const second = await claim(scope(), 'e2');
  if (second.status !== 'duplicate' || second.eventId !== 'e1') {
    fail('同じ組の2回目は duplicate で1件目の id を返す');
  }

  for (const [label, other] of [
    ['送り手が違う', scope({ sender: 'integration:k2' })],
    ['source が違う', scope({ source: 'ci2' })],
    ['キーが違う', scope({ key: 'run-2' })],
  ] as const) {
    const r = await claim(other, `e-${label}`);
    if (r.status !== 'claimed') fail(`${label}なら別の組として取れる`);
  }
  // 大文字小文字・前後の空白は同一視しない（呼び手が渡した文字列のまま比べる）
  if ((await claim(scope({ key: 'RUN-1' }), 'e-case')).status !== 'claimed') {
    fail('キーの大文字小文字は区別する');
  }

  // 並行: 同じ組を同時に取りに来ても取れるのは1本だけ
  const racers = await Promise.all(
    Array.from({ length: 8 }, (_, i) => claim(scope({ key: 'race' }), `r${String(i)}`)),
  );
  const winners = racers.flatMap((r, i) => (r.status === 'claimed' ? [`r${String(i)}`] : []));
  if (winners.length !== 1) fail(`並行の取得で勝つのは1本だけ（実際: ${String(winners.length)}）`);
  for (const r of racers) {
    if (r.status === 'duplicate' && r.eventId !== winners[0]) {
      fail('負けた側は勝った側の id を返す');
    }
  }

  // 手放し: id が一致するときだけ消える
  await store.release(scope({ key: 'rel' }), 'nobody');
  await claim(scope({ key: 'rel' }), 'e-rel');
  await store.release(scope({ key: 'rel' }), 'someone-else');
  if ((await claim(scope({ key: 'rel' }), 'e-rel2')).status !== 'duplicate') {
    fail('別の id の release で消えてはいけない');
  }
  await store.release(scope({ key: 'rel' }), 'e-rel');
  if ((await claim(scope({ key: 'rel' }), 'e-rel3')).status !== 'claimed') {
    fail('release の後は取り直せる');
  }

  // 期限: 期限内は duplicate、期限が切れたら新規として取って代わる
  const justInside = new Date(
    Date.parse(t0) + eventIdempotencyLimits.retentionMs - 1,
  ).toISOString();
  const expired = new Date(Date.parse(t0) + eventIdempotencyLimits.retentionMs).toISOString();
  if ((await claim(scope(), 'e-in', justInside)).status !== 'duplicate') {
    fail('期限の内側では duplicate');
  }
  const after = await claim(scope(), 'e-late', expired);
  if (after.status !== 'claimed') fail('期限が切れたキーは新規として取れる');
  const again = await claim(scope(), 'e-late2', expired);
  if (again.status !== 'duplicate' || again.eventId !== 'e-late') {
    fail('取って代わった行が新しい1件目になる');
  }

  await expectNulRejected(fail, 'キーの NUL', () => claim(scope({ key: 'a\u0000b' }), 'e'), 'a');
  await expectNulRejected(
    fail,
    'sender の NUL',
    () => claim(scope({ sender: 'a\u0000b' }), 'e'),
    'a',
  );
  await store.release(scope({ key: 'a\u0000b' }), 'e');
}
