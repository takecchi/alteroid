import { compareCodeUnits } from './code-unit-order.js';
import { PluginNameConflictError, type PluginInput } from './plugins.js';
import type { PluginStore } from './store.js';

/**
 * `PluginStore` の契約を、**実装1つに対して**測る（#3815 土台1）。
 *
 * 3実装（インメモリ・fs・pg）が同じ関数を呼ぶ形にしてあるのは
 * `mcp-server-contract.ts` と同じ理由である —— 検査や置き換えの扱いが器ごとに
 * 書き分けられると、`packages/core` の単体テストが当たるのはインメモリだけになり、
 * 乖離した器が緑のまま残る（#370）。
 *
 * **vitest に依存しない素の非同期関数にしてある**（`storage-fs` / `storage-pg` へ
 * vitest を持ち込まないため）。
 *
 * ⚠️ **この関数は器の中身を書き換える。** 契約の名前（`contract-*`）の plugin を置いて、
 * 最後に外した状態で終わる（他の plugin には触れない）。
 */
export async function verifyPluginStoreContract(store: PluginStore): Promise<void> {
  function fail(message: string): never {
    throw new Error(`plugin の器の契約違反: ${message}`);
  }

  const SHA_A = 'a'.repeat(40);
  const SHA_B = 'b'.repeat(40);
  const allBytes = Uint8Array.from({ length: 256 }, (_, i) => i);

  const base = (name: string, overrides: Partial<PluginInput> = {}): PluginInput => ({
    name,
    source: { kind: 'url', url: 'https://example.invalid/repo', path: 'p/q', sha: SHA_A },
    files: [
      { path: '.claude-plugin/plugin.json', executable: false, content: new Uint8Array([123, 125]) },
      { path: 'bin/run.sh', executable: true, content: allBytes },
      { path: 'skills/x/SKILL.md', executable: false, content: new Uint8Array(0) },
    ],
    installedAt: '2026-10-07T01:02:03.000Z',
    installedBy: 'contract-account',
    ...overrides,
  });

  const names = async () => (await store.list()).map((p) => p.name);
  const same = (a: Uint8Array, b: Uint8Array) =>
    a.byteLength === b.byteLength && a.every((byte, i) => byte === b[i]);

  // 先にあった契約外の行は触らず、契約の名前だけで測る。
  const mine = (all: string[]) => all.filter((n) => n.startsWith('contract-'));
  for (const leftover of mine(await names())) await store.remove(leftover);

  // --- 1. 無いものは null / false。壊れた名前でも投げない ---
  if ((await store.get('contract-none')) !== null) fail('無い名前の get が null でない');
  if ((await store.remove('contract-none')) !== false) fail('無い名前の remove が false でない');
  for (const odd of ['', '../etc', 'a/b', 'a\u0000b', 'x'.repeat(65)]) {
    if ((await store.get(odd)) !== null) fail('不正な名前の get が null でない');
    if ((await store.remove(odd)) !== false) fail('不正な名前の remove が false でない');
  }

  // --- 2. 往復（バイナリ・空ファイル・実行ビット・既定値） ---
  const summary = await store.put(base('contract-one'));
  if (summary.name !== 'contract-one') fail('put の返り値の name が違う');
  if (summary.fileCount !== 3 || summary.totalBytes !== 2 + 256) fail('put の要約の数が違う');
  if ('files' in summary) fail('put の返り値（要約）が files を含んでいる');
  const got = await store.get('contract-one');
  if (got === null) fail('put した後の get が null');
  if (got.scope !== 'all' || got.enableHooks !== false || got.enableMcp !== false) {
    fail(`既定値が違う: ${JSON.stringify([got.scope, got.enableHooks, got.enableMcp])}`);
  }
  if (got.contentSha256 !== summary.contentSha256) fail('要約と本体で contentSha256 が違う');
  if (got.installedAt !== '2026-10-07T01:02:03.000Z') fail('installedAt が往復しない');
  if (got.installedBy !== 'contract-account') fail('installedBy が往復しない');
  if (JSON.stringify(got.source) !== JSON.stringify(base('x').source)) fail('source が往復しない');
  if (got.files.length !== 3) fail('files の数が往復しない');
  const sorted = [...got.files].map((f) => f.path).sort(compareCodeUnits);
  if (JSON.stringify(got.files.map((f) => f.path)) !== JSON.stringify(sorted)) {
    fail('files の並びが path のコード単位順でない');
  }
  const run = got.files.find((f) => f.path === 'bin/run.sh');
  if (run === undefined || run.executable !== true || !same(run.content, allBytes)) {
    fail('バイナリ（NUL・0xFF を含む）と実行ビットが往復しない');
  }
  const empty = got.files.find((f) => f.path === 'skills/x/SKILL.md');
  if (empty === undefined || empty.content.byteLength !== 0) fail('空ファイルが往復しない');
  if (!(got.files[0]?.content instanceof Uint8Array)) fail('content が Uint8Array でない');

  // --- 3. 撒く先と hooks / MCP の真偽値 ---
  await store.put(base('contract-flags', { scope: 'runner', enableHooks: true, enableMcp: true }));
  const flags = await store.get('contract-flags');
  if (flags?.scope !== 'runner' || flags.enableHooks !== true || flags.enableMcp !== true) {
    fail('scope / enableHooks / enableMcp が往復しない');
  }
  await store.put(
    base('contract-mkt', {
      source: {
        kind: 'marketplace',
        marketplace: 'claude-plugins-official',
        plugin: 'frontend-design',
        url: 'https://github.com/anthropics/claude-plugins-official',
        sha: SHA_B,
        version: '1.0.0',
      },
    }),
  );
  const mkt = await store.get('contract-mkt');
  if (mkt?.source.kind !== 'marketplace' || mkt.source.version !== '1.0.0') {
    fail('marketplace の source が往復しない');
  }

  // --- 4. list は files を含まず、名前のコード単位順 ---
  const listed = await store.list();
  for (const entry of listed) {
    if ('files' in entry) fail('list が files を含んでいる');
  }
  const order = mine(await names());
  if (order.join(',') !== ['contract-flags', 'contract-mkt', 'contract-one'].join(',')) {
    fail(`list の並びが名前のコード単位順でない: ${order.join(',')}`);
  }

  // --- 5. 同名の put は置き換え（files も残らない） ---
  const replaced = await store.put(
    base('contract-one', {
      source: { kind: 'url', url: 'https://example.invalid/repo', sha: SHA_B },
      files: [{ path: 'only.txt', executable: false, content: new Uint8Array([7]) }],
      installedBy: 'contract-account-2',
    }),
  );
  if (replaced.fileCount !== 1) fail('置き換えの要約が新しい files の数でない');
  const after = await store.get('contract-one');
  if (after === null || after.files.length !== 1 || after.files[0]?.path !== 'only.txt') {
    fail('置き換えの後に古い files が残っている');
  }
  if (after.source.sha !== SHA_B || after.installedBy !== 'contract-account-2') {
    fail('置き換えの後に古い欄が残っている');
  }
  if (after.contentSha256 === got.contentSha256) fail('置き換えたのに contentSha256 が変わらない');
  if (mine(await names()).length !== 3) fail('置き換えで行が増えた');

  // --- 6. 不正な入力は拒み、前のものを壊さない ---
  const rejects = async (label: string, input: unknown) => {
    let threw = false;
    try {
      await store.put(input as PluginInput);
    } catch {
      threw = true;
    }
    if (!threw) fail(`${label}を拒まなかった`);
  };
  await rejects('.. を含む path', base('contract-one', { files: [{ path: '../x', executable: false, content: new Uint8Array(1) }] }));
  await rejects('絶対パス', base('contract-one', { files: [{ path: '/x', executable: false, content: new Uint8Array(1) }] }));
  await rejects('重複 path', base('contract-one', {
    files: [
      { path: 'd', executable: false, content: new Uint8Array(1) },
      { path: 'd', executable: false, content: new Uint8Array(2) },
    ],
  }));
  await rejects('40桁でない sha', base('contract-one', { source: { kind: 'url', url: 'https://example.invalid/r', sha: 'abc' } }));
  await rejects('http の URL', base('contract-one', { source: { kind: 'url', url: 'http://example.invalid/r', sha: SHA_A } }));
  await rejects('壊れた名前', base('contract bad'));
  const still = await store.get('contract-one');
  if (still === null || still.files.length !== 1 || still.contentSha256 !== after.contentSha256) {
    fail('拒んだ put が前の登録を壊した');
  }
  if (mine(await names()).length !== 3) fail('拒んだ put で行が増減した');

  // --- 7. 大文字小文字だけが違う名前は別の行として置けない（大文字小文字を区別しない FS で衝突するため） ---
  let conflict: unknown;
  try {
    await store.put(base('Contract-One'));
  } catch (error) {
    conflict = error;
  }
  if (!(conflict instanceof PluginNameConflictError)) {
    fail('大文字小文字だけが違う名前を PluginNameConflictError で拒まなかった');
  }
  if ((await store.get('Contract-One')) !== null) fail('衝突した名前が get できてしまう');
  if (mine(await names()).length !== 3) fail('衝突した put で行が増えた');
  // 同じ綴りの置き換えは衝突ではない
  await store.put(base('contract-one'));

  // --- 8. remove は在れば true、その行だけが消える ---
  if ((await store.remove('contract-one')) !== true) fail('在る名前の remove が true でない');
  if ((await store.get('contract-one')) !== null) fail('remove の後に get できる');
  if ((await store.remove('contract-one')) !== false) fail('2度目の remove が false でない');
  if (mine(await names()).join(',') !== 'contract-flags,contract-mkt') fail('remove が他の行に触れた');

  for (const name of mine(await names())) await store.remove(name);
  if (mine(await names()).length !== 0) fail('後始末の後も行が残っている');
}
