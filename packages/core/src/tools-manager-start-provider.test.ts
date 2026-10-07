import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createCloneTools } from './tools.js';
import type { ManagerStartInput, ManagerSummary } from './manager.js';
import { createMemoryStores } from './testing.js';

/**
 * `manager_start` に `provider` 引数は無い（2026-10-07 のオーナー決定。マネージャー層は常に Claude で動く）。
 * かつて（#486 S7）は人間がクローンの PEERS の環境変数で開けたときだけ出ていた。撤去した後も、
 * **スキーマと説明文は、その口が閉じていたときと1バイトも変わらない**ことを指紋で測る。
 */

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

function fingerprint(tool: { description: string; inputSchema: unknown }): string {
  const schema = z.toJSONSchema(z.object(tool.inputSchema as z.ZodRawShape));
  return createHash('sha256')
    .update(JSON.stringify({ description: tool.description, schema }))
    .digest('hex');
}

// origin/main（PEERS の配線前）の manager_start の指紋。撤去した後もこれと一致し続けなければならない。
// `cwd` の説明文を「作業ディレクトリ。…」へ直したとき（#2970）に取り直した。
// 担い手へ渡す添付の任意引数 `attachments` を足したとき（#3111 段3）に取り直した（道具の説明文は不変）。
const BASELINE = '92468963a71427a678185900742ab8479a1ea9b24a00316ff924b7dd0805a912';

describe('manager_start の provider 引数（撤去済み）', () => {
  it('provider 引数を持たず、スキーマと説明文は PEERS が閉じていたときと同一', () => {
    const { tool } = build();
    expect(Object.keys(tool.inputSchema as object)).toEqual([
      'request',
      'cwd',
      'attachments',
      'runnerId',
    ]);
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
