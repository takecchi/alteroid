import { describe, expect, it } from 'vitest';

import { fakeSdk, waitForDone, wireEvents } from './clone-test-harness.js';
import { createClone } from './clone.js';
import { createMcpServerService } from './mcp-server-service.js';
import { createMemoryStores, humanMessage } from './testing.js';
import { MCP_SERVER_NAME } from './tools.js';

const GITHUB = { command: 'gh-mcp', env: { TOKEN: 'dummy-secret' } };

async function journalTexts(stores: ReturnType<typeof createMemoryStores>): Promise<string[]> {
  const rows = await stores.journal.list({ types: ['exchange'] });
  return rows.flatMap((row) => (row.type === 'exchange' ? [row.text] : []));
}

describe('クローン — MCP 登録の変更を走行中のセッションへ反映する', () => {
  it('登録を変えると、開き直さずに走行中のセッションへ自作の道具と並べて差し替える', async () => {
    const { fn, calls, mcpSetCalls } = fakeSdk();
    const stores = createMemoryStores();
    const mcpServerService = createMcpServerService({ stores });
    const clone = createClone({ stores, queryFn: fn, env: {}, mcpServerService });
    const { events } = wireEvents(clone, 'conv-1');
    clone.post(humanMessage('やあ'));
    await waitForDone(events);
    expect(calls).toHaveLength(1);

    await mcpServerService.apply({ github: GITHUB });
    await expect.poll(() => mcpSetCalls[0]?.length, { timeout: 3000 }).toBe(1);

    const passed = mcpSetCalls[0]?.[0] ?? {};
    expect(Object.keys(passed).sort()).toEqual(['github', MCP_SERVER_NAME].sort());
    expect(passed[MCP_SERVER_NAME]?.type, 'クローン自身のインプロセス MCP が残っていない').toBe(
      'sdk',
    );
    expect(passed.github).toEqual(GITHUB);
    expect(calls, 'セッションを開き直している').toHaveLength(1);

    await expect
      .poll(async () => (await journalTexts(stores)).some((t) => t.includes('反映した')), {
        timeout: 3000,
      })
      .toBe(true);
    expect(
      (await journalTexts(stores)).join('\n'),
      '日誌に登録の中身（鍵）が出ている',
    ).not.toContain('dummy-secret');
    await clone.stop();
  });

  it('登録を空に戻しても、自作の道具だけは残して差し替える', async () => {
    const { fn, mcpSetCalls } = fakeSdk();
    const stores = createMemoryStores();
    const mcpServerService = createMcpServerService({ stores });
    const clone = createClone({ stores, queryFn: fn, env: {}, mcpServerService });
    const { events } = wireEvents(clone, 'conv-1');
    clone.post(humanMessage('やあ'));
    await waitForDone(events);

    await mcpServerService.apply({});
    await expect.poll(() => mcpSetCalls[0]?.length, { timeout: 3000 }).toBe(1);
    expect(Object.keys(mcpSetCalls[0]?.[0] ?? {})).toEqual([MCP_SERVER_NAME]);
    await clone.stop();
  });

  it('起動時の登録ファイルから来た連携を外したときは、このセッションには残ることを日誌に書く', async () => {
    const { fn, mcpSetCalls } = fakeSdk();
    const stores = createMemoryStores();
    await stores.mcpServers.write({ github: GITHUB });
    const mcpServerService = createMcpServerService({ stores });
    const clone = createClone({ stores, queryFn: fn, env: {}, mcpServerService });
    const { events } = wireEvents(clone, 'conv-1');
    clone.post(humanMessage('やあ'));
    await waitForDone(events);

    await mcpServerService.apply({});
    await expect.poll(() => mcpSetCalls[0]?.length, { timeout: 3000 }).toBe(1);
    await expect
      .poll(
        async () =>
          (await journalTexts(stores)).some((t) => t.includes('このセッションには残る: github')),
        { timeout: 3000 },
      )
      .toBe(true);
    await clone.stop();
  });

  it('ターンの途中の変更は、そのターンの境界まで待ってから差し替える', async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { fn, calls, mcpSetCalls } = fakeSdk(() => '考え中', { afterReply: () => held });
    const stores = createMemoryStores();
    const mcpServerService = createMcpServerService({ stores });
    const clone = createClone({ stores, queryFn: fn, env: {}, mcpServerService });
    const { events } = wireEvents(clone, 'conv-1');
    clone.post(humanMessage('やあ'));
    await expect.poll(() => calls[0]?.inputs.length, { timeout: 3000 }).toBe(1);

    await mcpServerService.apply({ github: GITHUB });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(mcpSetCalls[0], 'ターンの途中で差し替えている').toHaveLength(0);

    release();
    await waitForDone(events);
    await expect.poll(() => mcpSetCalls[0]?.length, { timeout: 3000 }).toBe(1);
    await clone.stop();
  });

  it('差し替えが失敗しても落ちず、次のセッションから効く旨を日誌に残し、次のターンも通る', async () => {
    const { fn } = fakeSdk(undefined, {
      setMcpServers: () => Promise.reject(new Error('control channel が閉じている')),
    });
    const stores = createMemoryStores();
    const mcpServerService = createMcpServerService({ stores });
    const clone = createClone({ stores, queryFn: fn, env: {}, mcpServerService });
    const { events } = wireEvents(clone, 'conv-1');
    clone.post(humanMessage('やあ'));
    await waitForDone(events);

    await mcpServerService.apply({ github: GITHUB });
    await expect
      .poll(async () => (await journalTexts(stores)).some((t) => t.includes('反映できなかった')), {
        timeout: 3000,
      })
      .toBe(true);
    const failure = (await journalTexts(stores)).find((t) => t.includes('反映できなかった'));
    expect(failure).toContain('次のセッションから効く');
    expect(failure).toContain('control channel が閉じている');

    const before = events.filter((e) => e.type === 'done').length;
    clone.post(humanMessage('もう1回'));
    await expect
      .poll(() => events.filter((e) => e.type === 'done').length, { timeout: 3000 })
      .toBe(before + 1);
    await clone.stop();
  });

  it('接続できなかった登録は名前だけを日誌に残す（理由は載せない）', async () => {
    const { fn, mcpSetCalls } = fakeSdk(undefined, {
      setMcpServers: (servers) =>
        Promise.resolve({
          added: Object.keys(servers),
          removed: [],
          errors: { github: 'ECONNREFUSED https://x.invalid/?token=dummy-secret' },
        }),
    });
    const stores = createMemoryStores();
    const mcpServerService = createMcpServerService({ stores });
    const clone = createClone({ stores, queryFn: fn, env: {}, mcpServerService });
    const { events } = wireEvents(clone, 'conv-1');
    clone.post(humanMessage('やあ'));
    await waitForDone(events);

    await mcpServerService.apply({ github: GITHUB });
    await expect.poll(() => mcpSetCalls[0]?.length, { timeout: 3000 }).toBe(1);
    await expect
      .poll(async () => (await journalTexts(stores)).some((t) => t.includes('接続失敗: github')), {
        timeout: 3000,
      })
      .toBe(true);
    expect((await journalTexts(stores)).join('\n')).not.toContain('dummy-secret');
    await clone.stop();
  });

  it('走っているセッションが無いときは何も呼ばない（次に開くセッションが最新を読む）', async () => {
    const { fn, calls, mcpSetCalls } = fakeSdk();
    const stores = createMemoryStores();
    const mcpServerService = createMcpServerService({ stores });
    const clone = createClone({ stores, queryFn: fn, env: {}, mcpServerService });

    await mcpServerService.apply({ github: GITHUB });
    expect(calls).toHaveLength(0);

    const { events } = wireEvents(clone, 'conv-1');
    clone.post(humanMessage('やあ'));
    await waitForDone(events);
    expect(mcpSetCalls[0]).toHaveLength(0);
    await clone.stop();
  });
});
