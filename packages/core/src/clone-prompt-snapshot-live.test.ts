import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';

import { fakeSdk, waitForDone, wireEvents } from './clone-test-harness.js';
import { ClonePromptSnapshotState, describeCloneTools } from './clone-prompt-snapshot.js';
import { createClone } from './clone.js';
import { fakeManagerPool } from './manager-pool.test-support.js';
import { createMcpServerService } from './mcp-server-service.js';
import { createMemoryStores, humanMessage } from './testing.js';
import { createCloneMcpServer, createCloneTools, type ToolContext } from './tools.js';

const GITHUB = { command: 'gh-mcp', args: ['--token=ARG-LIVE-1'], env: { TOKEN: 'ENV-LIVE-2' } };
const REMOTE = { type: 'http' as const, url: 'https://example.invalid/URL-LIVE-3' };

describe('スナップショットの外部 MCP は、走行中の登録の差し替えに合わせる', () => {
  it('差し替え後の名前と種別に変わり、焼いた全文と builtAt は変わらず、接続設定の値は入らない', async () => {
    const { fn, mcpSetCalls } = fakeSdk();
    const stores = createMemoryStores();
    const mcpServerService = createMcpServerService({ stores });
    const clone = createClone({ stores, queryFn: fn, env: {}, mcpServerService });
    const { events } = wireEvents(clone, 'conv-1');
    clone.post(humanMessage('やあ'));
    await waitForDone(events);
    const before = clone.promptSnapshot().session;
    if (before === null || !before.ok) throw new Error('セッションのスナップショットが無い');
    expect(before.externalMcpServers).toEqual([]);
    expect(before.externalMcpServersLive).toBeNull();

    await mcpServerService.apply({ github: GITHUB, remote: REMOTE });
    await expect.poll(() => mcpSetCalls[0]?.length, { timeout: 3000 }).toBe(1);
    await expect
      .poll(
        () =>
          clone.promptSnapshot().session?.ok === true && clone.promptSnapshot().session !== before,
        {
          timeout: 3000,
        },
      )
      .toBe(true);

    const after = clone.promptSnapshot().session;
    if (after === null || !after.ok) throw new Error('セッションのスナップショットが無い');
    expect(after.externalMcpServers).toEqual([
      { name: 'github', type: 'stdio' },
      { name: 'remote', type: 'http' },
    ]);
    expect(after.externalMcpServersLive?.failed).toEqual([]);
    expect(Date.parse(after.externalMcpServersLive?.at ?? '')).not.toBeNaN();
    expect(after.builtAt).toBe(before.builtAt);
    expect(after.systemPrompt).toEqual(before.systemPrompt);
    const json = JSON.stringify(clone.promptSnapshot());
    for (const sentinel of ['ARG-LIVE-1', 'ENV-LIVE-2', 'URL-LIVE-3']) {
      expect(json, sentinel).not.toContain(sentinel);
    }
    await clone.stop();
  });

  it('登録から外れても起動時の登録ファイルから来た名前は残り、残ったことを値で持つ', () => {
    const state = new ClonePromptSnapshotState();
    state.recordSession({
      builtAt: '2026-11-15T00:00:00.000Z',
      resumedFrom: null,
      model: 'opus',
      systemPrompt: 'P',
      documents: [],
      tools: () => [],
      externalMcpServers: { github: GITHUB, old: REMOTE },
      pluginPaths: [],
    });
    state.updateExternalMcpServers(
      { remote: REMOTE },
      { failed: ['remote'], retained: ['github'] },
      '2026-11-15T00:01:00.000Z',
    );
    const session = state.snapshot().session;
    if (session === null || !session.ok) throw new Error('セッションが無い');
    expect(session.externalMcpServers).toEqual([
      { name: 'remote', type: 'http' },
      { name: 'github', type: 'stdio' },
    ]);
    expect(session.externalMcpServersLive).toEqual({
      at: '2026-11-15T00:01:00.000Z',
      failed: ['remote'],
      retained: ['github'],
    });
  });
});

describe('スナップショットの道具の入力スキーマは、モデルに渡る定義と同じ形（$schema なし）', () => {
  it('全道具で $schema が無く、inputSchemaChars が長さと一致し、tools/list の inputSchema と同じ', async () => {
    const context: ToolContext = {
      stores: createMemoryStores(),
      emit: () => undefined,
      memoryCause: () => 'clone',
      conversationId: () => undefined,
      managers: fakeManagerPool({ runningManagerOwning: () => undefined }),
    };
    const described = describeCloneTools(createCloneTools(context));
    expect(described.length).toBeGreaterThan(0);

    const server = createCloneMcpServer(context);
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.instance.connect(serverSide as never);
    const client = new Client({ name: 't', version: '0' });
    await client.connect(clientSide);
    const listed = (await client.listTools()).tools;

    for (const tool of described) {
      expect(
        '$schema' in (tool.inputSchema as object),
        `${tool.name} に $schema が残っている`,
      ).toBe(false);
      expect(tool.inputSchemaChars).toBe(JSON.stringify(tool.inputSchema).length);
      expect(tool.inputSchema, `${tool.name}: モデルに渡る inputSchema と違う`).toEqual(
        listed.find((entry) => entry.name === tool.name)?.inputSchema,
      );
    }
    expect(described.map((tool) => tool.name).sort()).toEqual(
      listed.map((entry) => entry.name).sort(),
    );
  });
});
