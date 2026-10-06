import type { IntegrationKeyRecord, IntegrationKeyStore } from './integration-key.js';
import { expectNulRejected } from './nul-contract-support.js';

/**
 * `IntegrationKeyStore` の約束を、**実装1つに対して**測る。3実装（インメモリ / fs / pg）が同じ関数を呼ぶ。
 * 呼ぶ前の器は空であること。vitest に依存しない。
 *
 * 測るもの: 書いて読める（任意の上書き欄の `null` と値の両方）・並び（`createdAt` → `id`）・同じ id / 同じ sha256 を
 * 上書きしない・`lastUsedAt` だけを書く（失効後は書かない）・失効は冪等で先の時刻を動かさない・
 * NUL（読む口は「無い」、書く口は鍵を断り `name` は落とす）。
 */
export async function verifyIntegrationKeyStoreContract(store: IntegrationKeyStore): Promise<void> {
  function fail(message: string): never {
    throw new Error(`IntegrationKeyStore の契約違反: ${message}`);
  }
  const base = '2026-01-01T00:00:00.000Z';
  const later = '2026-02-01T00:00:00.000Z';
  const at1 = '2026-03-01T00:00:00.000Z';
  const at2 = '2026-04-01T00:00:00.000Z';

  const make = (over: Partial<IntegrationKeyRecord>): IntegrationKeyRecord => ({
    id: 'k-a',
    name: 'ci',
    source: 'ci.main',
    sha256: 'a'.repeat(64),
    createdAt: base,
    createdBy: '実行環境の持ち主による操作',
    expiresAt: null,
    revokedAt: null,
    lastUsedAt: null,
    maxBodyBytes: null,
    ratePerMinute: null,
    ...over,
  });

  const a = make({ id: 'k-a', sha256: 'a'.repeat(64) });
  const b = make({
    id: 'k-b',
    sha256: 'b'.repeat(64),
    createdAt: later,
    expiresAt: '2030-01-01T00:00:00.000Z',
    maxBodyBytes: 2048,
    ratePerMinute: 5,
  });
  // 同着（createdAt が同じ）は id で決まる。
  const c = make({ id: 'k-0', sha256: 'c'.repeat(64), createdAt: base });

  await store.putIntegrationKey(b);
  await store.putIntegrationKey(a);
  await store.putIntegrationKey(c);

  if (JSON.stringify(await store.getIntegrationKey('k-a')) !== JSON.stringify(a)) {
    fail('書いた鍵（上書き欄が null）をそのまま読み戻せない');
  }
  if (JSON.stringify(await store.getIntegrationKey('k-b')) !== JSON.stringify(b)) {
    fail('書いた鍵（上書き欄に値）をそのまま読み戻せない');
  }
  if ((await store.findIntegrationKeyBySha256('b'.repeat(64)))?.id !== 'k-b') {
    fail('sha256 で引けない');
  }
  if ((await store.findIntegrationKeyBySha256('d'.repeat(64))) !== null)
    fail('無い sha256 は null');
  if ((await store.getIntegrationKey('nope')) !== null) fail('無い id は null');
  const order = (await store.listIntegrationKeys()).map((row) => row.id).join(',');
  if (order !== 'k-0,k-a,k-b') fail(`並びは createdAt → id（実際: ${order}）`);

  // 上書きしない。
  await store.putIntegrationKey(make({ id: 'k-a', sha256: 'e'.repeat(64) })).then(
    () => fail('同じ id を上書きできてしまった'),
    () => undefined,
  );
  await store.putIntegrationKey(make({ id: 'k-z', sha256: 'a'.repeat(64) })).then(
    () => fail('同じ sha256 の別の行を作れてしまった'),
    () => undefined,
  );
  if ((await store.listIntegrationKeys()).length !== 3) fail('断った書き込みが行を残した');
  if (JSON.stringify(await store.getIntegrationKey('k-a')) !== JSON.stringify(a)) {
    fail('断った書き込みが既存の行を変えた');
  }

  // lastUsedAt だけを書く。
  await store.markIntegrationKeyUsed('k-b', at1);
  const used = await store.getIntegrationKey('k-b');
  if (used?.lastUsedAt !== at1) fail('lastUsedAt を書けない');
  if (JSON.stringify({ ...used, lastUsedAt: null }) !== JSON.stringify(b)) {
    fail('lastUsedAt 以外の欄が動いた');
  }
  await store.markIntegrationKeyUsed('nope', at1); // 無い id では何もしない（投げない）

  // 失効は冪等で、先の時刻を動かさない。失効後は lastUsedAt を書かない。
  const revoked = await store.revokeIntegrationKey('k-b', at1);
  if (revoked.status !== 'revoked' || revoked.key.revokedAt !== at1) fail('失効できない');
  const again = await store.revokeIntegrationKey('k-b', at2);
  if (again.status !== 'already_revoked' || again.key.revokedAt !== at1) {
    fail('2度目の失効が先の時刻を動かした');
  }
  if ((await store.revokeIntegrationKey('nope', at1)).status !== 'not_found') {
    fail('無い id の失効は not_found');
  }
  await store.markIntegrationKeyUsed('k-b', at2);
  const afterRevoke = await store.getIntegrationKey('k-b');
  if (afterRevoke?.lastUsedAt !== at1 || afterRevoke.revokedAt !== at1) {
    fail('失効後に lastUsedAt が動いた、または revokedAt が戻った');
  }

  // NUL: 読む口は「無い」と同じ結果（既存の鍵に NUL を足した値でも一致させない）。
  if ((await store.getIntegrationKey('k-a\u0000')) !== null) fail('id + NUL で引けてしまった');
  if ((await store.findIntegrationKeyBySha256(`${'a'.repeat(64)}\u0000`)) !== null) {
    fail('sha256 + NUL で引けてしまった');
  }
  await store.markIntegrationKeyUsed('k-a\u0000', at1);
  if ((await store.getIntegrationKey('k-a'))?.lastUsedAt !== null) fail('NUL の鍵で書けてしまった');
  if ((await store.revokeIntegrationKey('k-a\u0000', at1)).status !== 'not_found') {
    fail('NUL の鍵の失効は not_found');
  }
  // 書く口は鍵を断り、name は落として残す。
  await expectNulRejected(
    fail,
    'id の NUL',
    () => store.putIntegrationKey(make({ id: 'x\u0000y', sha256: 'f'.repeat(64) })),
    'x',
  );
  await expectNulRejected(
    fail,
    'createdBy の NUL',
    () =>
      store.putIntegrationKey(make({ id: 'k-n', sha256: 'f'.repeat(64), createdBy: 'o\u0000p' })),
    'o',
  );
  await store.putIntegrationKey(make({ id: 'k-n', sha256: 'f'.repeat(64), name: 'a\u0000b' }));
  if ((await store.getIntegrationKey('k-n'))?.name !== 'ab') fail('name の NUL を落として残さない');
}
