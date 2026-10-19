import { describe, expect, it } from 'vitest';

import type { ManagerPool, ManagerSendResult } from './manager.js';
import { createMemoryStores } from './testing.js';
import { createCloneTools } from './tools.js';

// requestId 無しで decision を付けても、待っている確認が無ければ回答には当たらず、本文は追加指示として届く（または預かる）。
// そのことを応答で言う: 言わないと、呼び手は許可・拒否を出したつもりのまま、相手は本文を普通の指示として読む

function sender(result: ManagerSendResult) {
  const calls: { message: string; options: unknown }[] = [];
  const pool = {
    send: async (_managerId: string, message: string, options: unknown) => {
      calls.push({ message, options });
      return result;
    },
  } as unknown as ManagerPool;
  const tools = createCloneTools({
    stores: createMemoryStores(),
    emit: () => undefined,
    managers: pool,
    memoryCause: () => 'clone',
    conversationId: () => undefined,
  });
  const tool = tools.find((entry) => entry.name === 'manager_send');
  if (tool === undefined) throw new Error('manager_send が無い');
  const call = async (args: Record<string, unknown>) => {
    const reply = await tool.handler(args as never, {});
    return (reply.content ?? []).map((b) => (b.type === 'text' ? b.text : '')).join('');
  };
  return { call, calls };
}

const UNUSED = '回答としては使っていない';

describe('manager_send: decision が回答に当たらなかったら、そう言う', () => {
  it('⭐ requestId 無しの decision で、追加指示として届いた（delivered）回は言う', async () => {
    const s = sender({ outcome: 'delivered', detail: 'mgr-1 へ届けた。' });

    const reply = await s.call({ managerId: 'mgr-1', message: 'いいよ', decision: 'allow' });

    expect(reply).toContain(UNUSED);
    expect(reply).toContain('allow');
    expect(reply).toContain('requestId');
  });

  it('⭐ requestId 無しの decision で、預かった（held）回も言う', async () => {
    const s = sender({ outcome: 'held', detail: 'mgr-1 へはまだ届けられないので預かった。' });

    const reply = await s.call({ managerId: 'mgr-1', message: 'だめ', decision: 'deny' });

    expect(reply).toContain(UNUSED);
    expect(reply).toContain('deny');
  });

  it('確認に当たった（answered）回は言わない', async () => {
    const s = sender({ outcome: 'answered', detail: '確認に回答した。' });

    const reply = await s.call({ managerId: 'mgr-1', message: 'いいよ', decision: 'allow' });

    expect(reply).not.toContain(UNUSED);
  });

  it('decision を付けていない回は言わない', async () => {
    const s = sender({ outcome: 'delivered', detail: 'mgr-1 へ届けた。' });

    const reply = await s.call({ managerId: 'mgr-1', message: '続きを' });

    expect(reply).not.toContain(UNUSED);
  });

  it('本文と decision は今までどおり pool へ渡す（届け方は変えない）', async () => {
    const s = sender({ outcome: 'delivered', detail: 'mgr-1 へ届けた。' });

    await s.call({ managerId: 'mgr-1', message: 'いいよ', decision: 'allow' });

    expect(s.calls).toEqual([{ message: 'いいよ', options: { decision: 'allow' } }]);
  });
});
