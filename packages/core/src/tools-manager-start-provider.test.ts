import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createCloneTools } from './tools.js';
import type { ManagerStartInput, ManagerSummary } from './manager.js';
import { createMemoryStores } from './testing.js';

/**
 * `manager_start` の `provider` 引数（#486 S7）。見えるのは人間が `ALTEROID_CLONE_PEERS` で
 * 開けた provider だけで、空なら**スキーマも説明文も従来と1バイトも変わらない**。
 */

function build(peers?: readonly string[]) {
  const stores = createMemoryStores();
  const started: ManagerStartInput[] = [];
  const managers = {
    async start(input: ManagerStartInput): Promise<ManagerSummary> {
      started.push(input);
      return {
        managerId: 'mgr-1',
        status: 'running',
        live: true,
        cwd: '/work',
        request: input.request,
        startedAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        waiting: [],
        runnerId: 'runner-a',
      };
    },
  } as never;
  const tools = createCloneTools({
    stores,
    emit: () => undefined,
    memoryCause: () => 'clone',
    conversationId: () => undefined,
    managers,
    ...(peers === undefined ? {} : { cloneProviderPeers: peers }),
  });
  const tool = tools.find((entry) => entry.name === 'manager_start');
  if (tool === undefined) throw new Error('manager_start が無い');
  return { stores, started, tool };
}

function fingerprint(tool: { description: string; inputSchema: unknown }): string {
  const schema = z.toJSONSchema(z.object(tool.inputSchema as z.ZodRawShape));
  return createHash('sha256')
    .update(JSON.stringify({ description: tool.description, schema }))
    .digest('hex');
}

// origin/main（PEERS の配線前）の manager_start の指紋。空のときはこれと一致し続けなければならない。
const BASELINE = '84b28689440b9009443cc549da2372ff7cb64b74a1ed7c274dc579d72d3062f3';

describe('manager_start の provider 引数', () => {
  it('PEERS が未設定・空なら、スキーマと説明文は配線前と同一（provider は見えない）', () => {
    for (const peers of [undefined, []] as const) {
      const { tool } = build(peers);
      expect(Object.keys(tool.inputSchema as object)).toEqual(['request', 'cwd', 'runnerId']);
      expect(fingerprint(tool as never)).toBe(BASELINE);
    }
  });

  it('開けた provider だけを enum に持つ optional の引数が出る', () => {
    const { tool } = build(['codex']);
    const shape = tool.inputSchema as z.ZodRawShape;
    expect(Object.keys(shape)).toEqual(['request', 'cwd', 'runnerId', 'provider']);
    const schema = z.object(shape);
    expect(schema.safeParse({ request: 'a' }).success).toBe(true);
    expect(schema.safeParse({ request: 'a', provider: 'codex' }).success).toBe(true);
    expect(schema.safeParse({ request: 'a', provider: 'claude' }).success).toBe(false);
    expect(schema.safeParse({ request: 'a', provider: 'gemini' }).success).toBe(false);
    // 開けたときも、既存の説明文は変わらない（引数が増えるだけ）
    expect(tool.description).toBe(build().tool.description);
  });

  it('指名すると ManagerPool.start へ届き、日誌と返り値に残る。指名しなければ欄ごと渡さない', async () => {
    const withProvider = build(['codex']);
    const reply = await withProvider.tool.handler(
      { request: 'レビューして', provider: 'codex' } as never,
      {},
    );
    expect(withProvider.started).toEqual([{ request: 'レビューして', provider: 'codex' }]);
    expect(JSON.stringify(reply)).toContain('provider: codex');
    const journal = (await withProvider.stores.journal.list({ types: ['decision'] })).map((e) =>
      e.type === 'decision' ? e.decision : '',
    );
    expect(journal.length).toBe(2);
    expect(journal.every((line) => line.includes('codex'))).toBe(true);

    const plain = build(['codex']);
    await plain.tool.handler({ request: '普通に' } as never, {});
    expect(plain.started).toEqual([{ request: '普通に' }]);
    expect(plain.started[0]).not.toHaveProperty('provider');
  });

  it('開けていない provider は、型の抜け道で渡されても断る', async () => {
    const { tool, started } = build(['codex']);
    await expect(tool.handler({ request: 'x', provider: 'claude' } as never, {})).rejects.toThrow(
      /ALTEROID_CLONE_PEERS/,
    );
    expect(started).toEqual([]);
  });
});
