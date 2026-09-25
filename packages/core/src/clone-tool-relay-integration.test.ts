import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterEach, describe, expect, it } from 'vitest';

import { makeTempDirSync } from '../../../vitest.tmpdir.js';
import {
  CLONE_TOOL_RELAY_SOCKET_ENV,
  CLONE_TOOL_RELAY_TOKEN_ENV,
} from './clone-tool-relay-child.js';
import { createCloneToolRelayHost, type CloneToolRelayHost } from './clone-tool-relay-host.js';
import { clearRecentTracesForTesting, noteDroppedRecord } from './dropped-record.js';
import { createMemoryStores } from './testing.js';
import { CLONE_TOOL_NAMES, createCloneMcpServer, type ToolContext } from './tools.js';

/**
 * 頭からしっぽまでの経路を1本、実プロセスで固定する（Issue #486 48(a) 案D、
 * PR1 の (a)(b)）。
 *
 * ```
 * MCP Client（本テスト） --stdio--> 中継の子プロセス（実際に spawn）
 *   --Unixソケット--> clone-tool-relay-host（本テストのプロセス内）
 *   --McpServer.connect--> createCloneMcpServer(minimalToolContext)
 * ```
 *
 * **⚠️ `packages/core/dist/clone-tool-relay-child.js` のビルド済み成果物に
 * 依存する。** `AGENTS.md`「開発手順」の「build が先」のとおり、`pnpm build`
 * （このパッケージなら `pnpm --filter @alteroid/core build`）を先に走らせる
 * こと——他の統合試験・CI と同じ前提であり、ここだけ特別扱いしない
 * （`dist` が無ければ ENOENT で赤くなる。静かにスキップしない）。
 *
 * **一時ディレクトリは `vitest.tmpdir.ts` の `makeTempDirSync` を使う**
 * （`mkdtempSync` を直接呼ばない。`scripts/no-direct-mkdtemp.test.ts` の歯）。
 */
describe('clone-tool-relay 統合（子プロセスを実際に spawn する）', () => {
  const childEntry = fileURLToPath(new URL('../dist/clone-tool-relay-child.js', import.meta.url));

  let host: CloneToolRelayHost | undefined;
  let client: Client | undefined;

  afterEach(async () => {
    await client?.close();
    host?.close();
    host = undefined;
    client = undefined;
    clearRecentTracesForTesting();
  });

  function minimalToolContext(): ToolContext {
    return {
      stores: createMemoryStores(),
      emit: () => {},
      conversationId: () => undefined,
      memoryCause: () => 'clone',
    };
  }

  async function connect(): Promise<Client> {
    const dir = makeTempDirSync('clone-tool-relay-integration-');
    host = await createCloneToolRelayHost({ socketPath: join(dir, 's.sock') });
    const token = host.register(() => createCloneMcpServer(minimalToolContext()).instance);

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [childEntry],
      env: {
        [CLONE_TOOL_RELAY_SOCKET_ENV]: host.socketPath,
        [CLONE_TOOL_RELAY_TOKEN_ENV]: token,
      },
    });
    client = new Client({ name: 'clone-tool-relay-integration.test', version: '0' });
    await client.connect(transport);
    return client;
  }

  it('tools/list が CLONE_TOOL_NAMES の全本数と一致する（子プロセス越し）', async () => {
    const c = await connect();
    const { tools } = await c.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([...CLONE_TOOL_NAMES].sort());
  }, 20_000);

  it(// #486 の終了条件案3（過去の測定コメント）: self_dropped は
  // 「デーモンのプロセスの跡」を返し続ける——案Dでは道具の実体が
  // デーモンのプロセスに残るので、子プロセスを経由しても跡の出所は
  // 変わらないことを、ここで実際に確かめる。
  'self_dropped は道具の実体が居るプロセス（このテストプロセス）の跡を返す', async () => {
    const marker = 'clone-tool-relay-integration-test-marker';
    noteDroppedRecord('中継の統合試験', marker, new Error('boom'));

    const c = await connect();
    const result = (await c.callTool({ name: 'self_dropped', arguments: {} })) as {
      content: { type: string; text?: string }[];
    };
    const body = result.content.map((block) => block.text ?? '').join('\n');
    expect(body).toContain(marker);
  }, 20_000);
});
