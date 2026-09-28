import { join } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { makeTempDirSync } from '../../../vitest.tmpdir.js';
import {
  CLONE_TOOL_RELAY_SOCKET_ENV,
  CLONE_TOOL_RELAY_TOKEN_ENV,
} from './clone-tool-relay-child.js';
import { buildCloneToolRelayChildDistForTesting } from './clone-tool-relay-child-build.test-support.js';
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
 * **Issue #1917 でビルド済み成果物の出所を変えた。** 以前はここで
 * `packages/core/dist/clone-tool-relay-child.js`（本物のチェックアウトの
 * 成果物）を直接 spawn していたが、それには2つの弱さがあった——(1) 同じ
 * ツリーで並行して走る `pnpm build` の tsup clean が `dist/*.js` を一瞬消す窓
 * と競合する（#204 / #234）、(2) `src` だけを直して build せずにこの歯だけ
 * 回すと、古い `dist` に対して緑が出る。**#1908 と同じ弱さだが、同じ直し方
 * （`src` を型剥がしで直接読む。`child-src.test-support.ts`）は使えない**——
 * この歯が実際に測りたいのは束ね方そのもの（`clone-tool-relay-protocol.ts`
 * の doc: tsup が共有チャンクへ括り出すと `invokedDirectly()` が永久に偽に
 * なり、中継が起動しなくなる回帰）で、型剥がしは束ねる工程を経由しない
 * ため、この回帰を再現できない。
 *
 * **いまはテスト専用の一時ディレクトリへ、`tsup.config.ts` と同じ entry
 * 一式・同じ設定で build し、そこの成果物を spawn する**
 * （`clone-tool-relay-child-build.test-support.ts`。詳しい理由はそちらの
 * doc）。`beforeAll` で1回だけ build する——`pnpm build` を挟む必要は無い
 * （このテスト自身が build を内包している）。
 *
 * **一時ディレクトリは `vitest.tmpdir.ts` の `makeTempDirSync` を使う**
 * （`mkdtempSync` を直接呼ばない。`scripts/no-direct-mkdtemp.test.ts` の歯）。
 */
describe('clone-tool-relay 統合（子プロセスを実際に spawn する）', () => {
  let childEntry: string;

  beforeAll(async () => {
    childEntry = await buildCloneToolRelayChildDistForTesting('clone-tool-relay-integration-dist-');
  }, 60_000);

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
