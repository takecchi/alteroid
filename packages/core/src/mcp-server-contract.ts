import type { McpServers } from './mcp-servers.js';
import type { McpServerStore } from './store.js';

/**
 * `McpServerStore` の契約を、**実装1つに対して**測る（#325 段1）。
 *
 * 3実装（インメモリ・fs・pg）が同じ関数を呼ぶ形にしてあるのは
 * `practice-contract.ts` と同じ理由である —— 検査や空の扱いが器ごとに書き分け
 * られていると、`packages/core` の単体テストが当たるのはインメモリだけになり、
 * 乖離した器が緑のまま残る（#370）。
 *
 * **vitest に依存しない素の非同期関数にしてある**（`storage-fs` / `storage-pg` へ
 * vitest を持ち込まないため。`store-isolation-contract.ts` と同じ）。
 *
 * ⚠️ **この関数は器の中身を書き換える**（全文置換の口しか無いので）。最後に
 * 登録を外した状態で終わる。
 */
export async function verifyMcpServerStoreContract(store: McpServerStore): Promise<void> {
  function fail(message: string): never {
    throw new Error(`MCP サーバの登録の器の契約違反: ${message}`);
  }

  // --- 1. 空の登録は「外す」。読み戻しは null ---
  const cleared = await store.write({});
  if (Object.keys(cleared.mcpServers).length !== 0) fail('空で書いた返り値が空でない');
  if ((await store.read()) !== null) fail('空で書いた後の read() は null であること');

  // --- 2. 3種（stdio / http / sse）がそのまま往復する ---
  const servers: McpServers = {
    'contract-stdio': {
      command: 'npx',
      args: ['-y', '@example/server'],
      env: { EXAMPLE_TOKEN: 'dummy-value' },
    },
    'contract-http': {
      type: 'http',
      url: 'https://example.invalid/mcp',
      headers: { Authorization: 'Bearer dummy' },
      timeout: 30_000,
    },
    contract_sse: { type: 'sse', url: 'https://example.invalid/sse', alwaysLoad: true },
  };
  const written = await store.write(servers);
  if (JSON.stringify(sortKeys(written.mcpServers)) !== JSON.stringify(sortKeys(servers))) {
    fail(`write() の返り値が入力と違う: ${JSON.stringify(written.mcpServers)}`);
  }
  if (Number.isNaN(Date.parse(written.updatedAt))) fail('updatedAt が時刻として読めない');
  const reread = await store.read();
  if (reread === null) fail('書いた後の read() が null');
  if (JSON.stringify(sortKeys(reread.mcpServers)) !== JSON.stringify(sortKeys(servers))) {
    fail(`read() が書いたものと違う: ${JSON.stringify(reread.mcpServers)}`);
  }

  // --- 3. 全文置換（入力に無い名前は消える） ---
  await store.write({ 'contract-http': servers['contract-http'] as McpServers[string] });
  const replaced = await store.read();
  if (replaced === null || Object.keys(replaced.mcpServers).join(',') !== 'contract-http') {
    fail(`全文置換になっていない: ${JSON.stringify(Object.keys(replaced?.mcpServers ?? {}))}`);
  }

  // --- 4. alteroid 自身の名前・不正な形は拒み、前のものが残る ---
  for (const [label, bad] of [
    ['自作の名前', { alteroid: { command: 'x' } }],
    ['大文字違いの自作の名前', { Alteroid: { command: 'x' } }],
    ['使えない文字の名前', { 'a b': { command: 'x' } }],
    ['未知の欄', { ok: { command: 'x', enviroment: {} } }],
    ['command の無い stdio', { ok: { args: [] } }],
  ] as const) {
    let threw = false;
    try {
      await store.write(bad as unknown as McpServers);
    } catch {
      threw = true;
    }
    if (!threw) fail(`${label}を受け付けた`);
    const after = await store.read();
    if (after === null || Object.keys(after.mcpServers).join(',') !== 'contract-http') {
      fail(`${label}を拒んだ後に前の登録が残っていない`);
    }
  }

  // --- 5. 外して終わる ---
  await store.write({});
  if ((await store.read()) !== null) fail('最後に外した後の read() が null でない');
}

/** 比較を鍵の並び順に依存させない（pg の jsonb は鍵を並べ替える）。 */
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, sortKeys(v)]),
    );
  }
  return value;
}
