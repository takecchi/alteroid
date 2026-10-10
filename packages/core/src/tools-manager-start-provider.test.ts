import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createCloneTools } from './tools.js';
import type { ManagerStartInput, ManagerSummary } from './manager.js';
import { createMemoryStores } from './testing.js';

function build() {
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
  });
  const tool = tools.find((entry) => entry.name === 'manager_start');
  if (tool === undefined) throw new Error('manager_start が無い');
  return { stores, started, tool };
}

// `.shape` を読む: 道具の入力は知らない引数を断る strict な object に包んで渡しているため。指紋は従来どおり z.object から取る
function shapeOf(tool: { inputSchema: unknown }): z.ZodRawShape {
  return (tool.inputSchema as z.ZodObject<z.ZodRawShape>).shape;
}

function fingerprint(tool: { description: string; inputSchema: unknown }): string {
  const schema = z.toJSONSchema(z.object(shapeOf(tool)));
  return createHash('sha256')
    .update(JSON.stringify({ description: tool.description, schema }))
    .digest('hex');
}

const BASELINE = '7f3d5a46f07f621c44d9af1fb9f640a270af2cb2f19a308f6e064e240c7c0b5c';

describe('manager_start の provider 引数（撤去済み）', () => {
  it('provider 引数を持たず、スキーマと説明文は PEERS が閉じていたときと同一', () => {
    const { tool } = build();
    expect(Object.keys(shapeOf(tool))).toEqual(['request', 'cwd', 'attachments', 'runnerId']);
    expect(fingerprint(tool as never)).toBe(BASELINE);
  });

  it('型の抜け道で provider を渡されても、ManagerPool.start へは届けない（Claude で起こす）', async () => {
    const { tool, started, stores } = build();
    await tool.handler({ request: 'レビューして', provider: 'codex' } as never, {});
    expect(started).toEqual([{ request: 'レビューして' }]);
    expect(started[0]).not.toHaveProperty('provider');
    const journal = (await stores.journal.list({ types: ['decision'] })).map((e) =>
      e.type === 'decision' ? e.decision : '',
    );
    expect(journal.some((line) => line.includes('codex'))).toBe(false);
  });
});
