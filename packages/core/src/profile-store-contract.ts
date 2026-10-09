import type { ProfileStore } from './store.js';
import { expectNulRejected } from './nul-contract-support.js';

/** 更新日時の「十分に古い値」。実時間で待たずに、時刻が進む/戻ることを測るための固定値。 */
const LONG_AGO = '2000-01-01T00:00:00.000Z';

export async function verifyProfileStoreContract(store: ProfileStore): Promise<void> {
  function fail(message: string): never {
    throw new Error(`実行環境プロファイルの器の契約違反: ${message}`);
  }
  const names = async () => (await store.list()).map((row) => row.name);

  if ((await store.list()).length !== 0) fail('最初の list() が空でない');
  if ((await store.clear()) !== 0) fail('空の器の clear() は 0 を返すこと');

  // 大文字小文字だけが違う名前は使わない: 大文字小文字を区別しない FS（macOS）で fs 版の `<name>.sh` が衝突する。
  await store.set('b', 'export B=1\n', 'all');
  await store.set('a', 'export A=1\n', 'runner');
  const upper = await store.set('Z', 'export UP=1\n', 'app');
  if (upper.name !== 'Z' || upper.scope !== 'app') fail('set の返り値が置いた行でない');
  const order = (await names()).join(',');
  if (order !== 'Z,a,b') fail(`list の並びがコード単位順でない: ${order}`);

  const rows = await store.list();
  const a = rows.find((row) => row.name === 'a');
  if (a === undefined || a.script !== 'export A=1\n' || a.scope !== 'runner') {
    fail('本文・撒く先が往復しない');
  }

  // 実時間で待たない: 器が混むと待ちが足りず、時刻が進んだかを測れない。
  await store.replaceAll(rows.map((row) => ({ ...row, updatedAt: LONG_AGO })));
  const replaced = await store.set('a', 'export A=2\n', 'all');
  if ((await store.list()).length !== 3) fail('同じ名前の set で行が増えた');
  if (replaced.updatedAt === LONG_AGO) fail('置き換えても updatedAt が進まない');
  const afterReplace = (await store.list()).find((row) => row.name === 'a');
  if (afterReplace?.script !== 'export A=2\n' || afterReplace.scope !== 'all') {
    fail('置き換えた本文・撒く先が読み戻せない');
  }

  if ((await store.remove('a')) !== true) fail('在る行の remove が true でない');
  if ((await store.remove('a')) !== false) fail('無い行の remove が false でない');
  if ((await names()).join(',') !== 'Z,b') fail('remove が他の行を巻き込んだ');

  // 更新日時が「いま」で上書きされる実装を、時計の粒度に頼らず落とすため、古い値で撮る。
  await store.replaceAll((await store.list()).map((row) => ({ ...row, updatedAt: LONG_AGO })));
  const snapshot = await store.list();
  await store.set('b', 'export B=changed\n', 'runner');
  await store.set('extra', 'export X=1\n', 'all');
  await store.remove('Z');
  await store.replaceAll(snapshot);
  const restored = await store.list();
  if (JSON.stringify(restored) !== JSON.stringify(snapshot)) {
    fail('replaceAll が更新日時まで含めて元の集合に戻していない');
  }

  await store.replaceAll([]);
  if ((await store.list()).length !== 0) fail('replaceAll([]) の後も行が残っている');

  await store.set('x', 'export X=1\n', 'runner');
  await store.set('y', 'export Y=1\n', 'app');
  if ((await store.clear()) !== 2) fail('clear() が消した行数を返さない');
  if ((await store.list()).length !== 0) fail('clear の後も行が残っている');
  await store.set('x', 'export X=2\n', 'all');
  const again = (await store.list())[0];
  if (again?.scope !== 'all') fail('外したあとに置いた行へ古い撒く先が残った');
  await store.clear();

  await store.set('keep', 'export KEEP=1\n', 'all');
  await expectNulRejected(
    fail,
    'nameのNUL',
    () => store.set('ke\u0000ep', 'export K=1\n', 'all'),
    'ke',
  );
  await expectNulRejected(
    fail,
    'scriptのNUL',
    () => store.set('keep', 'export GH_TOKEN=sec\u0000ret-value\n', 'all'),
    'ret-value',
  );
  await expectNulRejected(
    fail,
    'replaceAllのscriptのNUL',
    () =>
      store.replaceAll([
        { name: 'other', script: 'export O=1\n', scope: 'all', updatedAt: LONG_AGO },
        { name: 'bad', script: 'export B=sec\u0000ret-value\n', scope: 'all', updatedAt: LONG_AGO },
      ]),
    'ret-value',
  );
  await expectNulRejected(
    fail,
    'replaceAllのnameのNUL',
    () =>
      store.replaceAll([
        { name: 'ba\u0000d', script: 'export B=1\n', scope: 'all', updatedAt: LONG_AGO },
      ]),
    'ba',
  );
  const afterNul = await store.list();
  if (
    afterNul.length !== 1 ||
    afterNul[0]?.name !== 'keep' ||
    afterNul[0].script !== 'export KEEP=1\n'
  ) {
    fail('NULで断った後に前の行が残っていない（断ったのに何かを書いた）');
  }
  await store.clear();
}
