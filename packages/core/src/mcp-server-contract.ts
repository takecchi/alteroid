import { compareCodeUnits } from './code-unit-order.js';
import type { McpServers } from './mcp-servers.js';
import type { McpServerStore } from './store.js';
import { expectNulRejected } from './nul-contract-support.js';

// vitest に依存しない素の非同期関数にする: `storage-fs` / `storage-pg` へ vitest を持ち込まないため。
// この関数は器の中身を書き換える。最後に登録を外した状態で終わる。
export async function verifyMcpServerStoreContract(store: McpServerStore): Promise<void> {
  function fail(message: string): never {
    throw new Error(`MCP サーバの登録の器の契約違反: ${message}`);
  }

  const cleared = await store.write({});
  if (Object.keys(cleared.mcpServers).length !== 0) fail('空で書いた返り値が空でない');
  if ((await store.read()) !== null) fail('空で書いた後の read() は null であること');

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

  // 上の比較は `sortKeys` を通すので並びそのものは見ない。入力の順は `'contract-stdio'` が先頭で名前の順と違うので、
  // 入力の順をそのまま返す器もここで落ちる。
  const expectedOrder = Object.keys(servers).sort(compareCodeUnits);
  if (Object.keys(written.mcpServers).join(',') !== expectedOrder.join(',')) {
    fail(
      `write() の返り値の並びが名前のコード単位順でない: ${Object.keys(written.mcpServers).join(',')}`,
    );
  }
  if (Object.keys(reread.mcpServers).join(',') !== expectedOrder.join(',')) {
    fail(`read() の並びが名前のコード単位順でない: ${Object.keys(reread.mcpServers).join(',')}`);
  }
  // コード単位順では 'B' < 'a' < 'ab' だが pg の jsonb は短い順に並べるので、長い名前を混ぜて食い違いを作る。
  const mixed: McpServers = {
    ab: { command: 'x' },
    a: { command: 'x' },
    B: { command: 'x' },
    'a-long-name': { command: 'x' },
  };
  const mixedWritten = await store.write(mixed);
  const mixedRead = await store.read();
  const mixedOrder = Object.keys(mixed).sort(compareCodeUnits).join(',');
  if (Object.keys(mixedWritten.mcpServers).join(',') !== mixedOrder) {
    fail(
      `write() の返り値の並びが名前のコード単位順でない（大文字小文字混じり）: ${Object.keys(mixedWritten.mcpServers).join(',')}`,
    );
  }
  if (Object.keys(mixedRead?.mcpServers ?? {}).join(',') !== mixedOrder) {
    fail(
      `read() の並びが名前のコード単位順でない（大文字小文字混じり）: ${Object.keys(mixedRead?.mcpServers ?? {}).join(',')}`,
    );
  }

  await store.write({ 'contract-http': servers['contract-http'] as McpServers[string] });
  const replaced = await store.read();
  if (replaced === null || Object.keys(replaced.mcpServers).join(',') !== 'contract-http') {
    fail(`全文置換になっていない: ${JSON.stringify(Object.keys(replaced?.mcpServers ?? {}))}`);
  }

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

  await expectNulRejected(
    fail,
    'サーバー名のNUL',
    () => store.write({ 'zq\u0000yx': { command: 'x' } }),
    'zq',
  );
  await expectNulRejected(
    fail,
    'envの値のNUL',
    () => store.write({ ok: { command: 'x', env: { TOKEN: 'sec\u0000ret-value' } } }),
    'ret-value',
  );
  await expectNulRejected(
    fail,
    'envの名前のNUL',
    () => store.write({ ok: { command: 'x', env: { 'TO\u0000KEN': 'v' } } }),
    'TOKEN',
  );
  {
    const afterRejected = await store.read();
    if (
      afterRejected === null ||
      Object.keys(afterRejected.mcpServers).join(',') !== 'contract-http'
    ) {
      fail('NULで断った後に前の登録が残っていない');
    }
    const stripped = await store.write({
      'contract-nul': {
        command: 'co\u0000mmand',
        args: ['a\u0000rg'],
        env: { KEEP: 'ok' },
      },
      'contract-nul-http': {
        type: 'http',
        url: 'https://exa\u0000mple.test/',
        headers: { 'X-H': 'v\u0000al' },
      },
    });
    const nul = stripped.mcpServers['contract-nul'];
    const nulHttp = stripped.mcpServers['contract-nul-http'];
    if (
      nul === undefined ||
      !('command' in nul) ||
      nul.command !== 'command' ||
      nul.args?.join(',') !== 'arg' ||
      nulHttp === undefined ||
      !('url' in nulHttp) ||
      nulHttp.url !== 'https://example.test/' ||
      !('headers' in nulHttp) ||
      nulHttp.headers?.['X-H'] !== 'val'
    ) {
      fail('本文のNULは落として残す（返り値）');
    }
    const reread = await store.read();
    if (
      JSON.stringify(sortKeys(reread?.mcpServers)) !== JSON.stringify(sortKeys(stripped.mcpServers))
    ) {
      fail('本文のNULを落とした形で読み戻る');
    }
  }

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
