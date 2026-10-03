import type { ProfileStore } from './store.js';

/**
 * `ProfileStore` の契約を、**実装1つに対して**測る（2026-10-03。名前付きの行の形）。
 *
 * 3実装（インメモリ・fs・pg）が同じ関数を呼ぶ形にしてあるのは `mcp-server-contract.ts` /
 * `practice-contract.ts` と同じ理由である —— 並び順・撒く先・巻き戻しの扱いが器ごとに
 * 書き分けられていると、`packages/core` の単体テストが当たるのはインメモリだけになり、
 * 乖離した器が緑のまま残る。
 *
 * **vitest に依存しない素の非同期関数にしてある**（`storage-fs` / `storage-pg` へ
 * vitest を持ち込まないため）。
 *
 * ⚠️ **この関数は器の中身を書き換える。** 最後に全部外した状態で終わる。
 */
export async function verifyProfileStoreContract(store: ProfileStore): Promise<void> {
  function fail(message: string): never {
    throw new Error(`実行環境プロファイルの器の契約違反: ${message}`);
  }
  const names = async () => (await store.list()).map((row) => row.name);

  // --- 1. 何も置かれていなければ空。clear は 0 ---
  if ((await store.list()).length !== 0) fail('最初の list() が空でない');
  if ((await store.clear()) !== 0) fail('空の器の clear() は 0 を返すこと');

  // --- 2. 並びは名前のコード単位順（ロケールに依存しない。大文字は小文字より先） ---
  // **大文字小文字だけが違う名前は使わない**（大文字小文字を区別しないファイルシステム〈macOS〉
  // で fs 版の `<name>.sh` が衝突する。そうした名前は `ProfileService.set` が弾く）。
  await store.set('b', 'export B=1\n', 'all');
  await store.set('a', 'export A=1\n', 'runner');
  const upper = await store.set('Z', 'export UP=1\n', 'app');
  if (upper.name !== 'Z' || upper.scope !== 'app') fail('set の返り値が置いた行でない');
  const order = (await names()).join(',');
  if (order !== 'Z,a,b') fail(`list の並びがコード単位順でない: ${order}`);

  // --- 3. 本文・撒く先がそのまま往復する（本文は1文字も変わらない） ---
  const rows = await store.list();
  const a = rows.find((row) => row.name === 'a');
  if (a === undefined || a.script !== 'export A=1\n' || a.scope !== 'runner') {
    fail('本文・撒く先が往復しない');
  }

  // --- 4. 同じ名前の set は置き換え（行は増えない。撒く先も新しいものになる） ---
  await new Promise((resolve) => setTimeout(resolve, 20));
  const replaced = await store.set('a', 'export A=2\n', 'all');
  if ((await store.list()).length !== 3) fail('同じ名前の set で行が増えた');
  if (replaced.updatedAt === a.updatedAt) fail('置き換えても updatedAt が進まない');
  const afterReplace = (await store.list()).find((row) => row.name === 'a');
  if (afterReplace?.script !== 'export A=2\n' || afterReplace.scope !== 'all') {
    fail('置き換えた本文・撒く先が読み戻せない');
  }

  // --- 5. remove は1行だけ。在れば true、無ければ false ---
  if ((await store.remove('a')) !== true) fail('在る行の remove が true でない');
  if ((await store.remove('a')) !== false) fail('無い行の remove が false でない');
  if ((await names()).join(',') !== 'Z,b') fail('remove が他の行を巻き込んだ');

  // --- 6. replaceAll は行の集合を、本文・撒く先・更新日時ごと戻す（入力に無い行は消える） ---
  const snapshot = await store.list();
  await new Promise((resolve) => setTimeout(resolve, 20));
  await store.set('b', 'export B=changed\n', 'runner');
  await store.set('extra', 'export X=1\n', 'all');
  await store.remove('Z');
  await store.replaceAll(snapshot);
  const restored = await store.list();
  if (JSON.stringify(restored) !== JSON.stringify(snapshot)) {
    fail('replaceAll が更新日時まで含めて元の集合に戻していない');
  }

  // --- 7. replaceAll([]) は全部外す ---
  await store.replaceAll([]);
  if ((await store.list()).length !== 0) fail('replaceAll([]) の後も行が残っている');

  // --- 8. clear は消した行数を返し、何も残さない。外した後の既定は all ---
  await store.set('x', 'export X=1\n', 'runner');
  await store.set('y', 'export Y=1\n', 'app');
  if ((await store.clear()) !== 2) fail('clear() が消した行数を返さない');
  if ((await store.list()).length !== 0) fail('clear の後も行が残っている');
  await store.set('x', 'export X=2\n', 'all');
  const again = (await store.list())[0];
  if (again?.scope !== 'all') fail('外したあとに置いた行へ古い撒く先が残った');
  await store.clear();
}
