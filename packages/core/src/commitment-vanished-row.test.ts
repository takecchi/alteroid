import { describe, expect, it } from 'vitest';

import type { Commitment } from './schema.js';
import { UnreadableCommitmentError, type Stores } from './store.js';
import { createMemoryStores } from './testing.js';
import { createCloneTools } from './tools.js';

// commitment_close / commitment_edit は、確かめた後で置き場の close / editBody が false を返したら行を読み直して理由を言う。
// 読み直した行が無い（その間に消えた）・閉じていない・読めない、を「既に 不明な時刻 に片付けてある」に潰さない

const ROW: Commitment = {
  id: 'c-1',
  at: '2026-10-19T00:00:00.000Z',
  origin: 'self',
  body: '調べておく',
};

type AfterWrite = 'vanished' | 'still-open' | 'unreadable';

// 1回目の get は行を返し、close / editBody は false を返し、2回目以降の get は `after` の形で返す置き場
function racingStores(after: AfterWrite): Stores {
  const stores = createMemoryStores();
  const base = stores.commitments;
  let wrote = false;
  return {
    ...stores,
    commitments: {
      ...base,
      get: async (id) => {
        if (!wrote) return id === ROW.id ? ROW : null;
        if (after === 'vanished') return null;
        if (after === 'unreadable')
          throw new UnreadableCommitmentError(`${id} は読めない形で入っている`);
        return ROW;
      },
      close: async () => {
        wrote = true;
        return false;
      },
      editBody: async () => {
        wrote = true;
        return { kind: 'not-edited' };
      },
    },
  };
}

function toolOf(stores: Stores, name: string) {
  const tools = createCloneTools({
    stores,
    emit: () => undefined,
    memoryCause: () => 'clone',
    conversationId: () => undefined,
  });
  const tool = tools.find((entry) => entry.name === name);
  if (tool === undefined) throw new Error(`${name} が無い`);
  return async (args: Record<string, unknown>) => {
    const reply = await tool.handler(args as never, {});
    return (reply.content ?? []).map((b) => (b.type === 'text' ? b.text : '')).join('');
  };
}

const close = (after: AfterWrite) =>
  toolOf(racingStores(after), 'commitment_close')({ id: ROW.id, reason: '片付いた' });
const edit = (after: AfterWrite) =>
  toolOf(racingStores(after), 'commitment_edit')({ id: ROW.id, body: '直した本文' });

describe('commitment_close: 閉じられなかった理由を、読み直した行の形どおりに言う', () => {
  it('⭐ 閉じる直前に行が消えていたら「片付けてある」と言わず、台帳に無くなったと言う', async () => {
    const reply = await close('vanished');

    expect(reply).not.toContain('片付けてある');
    expect(reply).toContain('台帳に無い');
    expect(reply).toContain('閉じていない');
  });

  it('⭐ 行が残っていて閉じてもいないなら、閉じられなかったと言う', async () => {
    const reply = await close('still-open');

    expect(reply).not.toContain('片付けてある');
    expect(reply).toContain('閉じられなかった');
  });
});

describe('commitment_edit: 直せなかった理由を、読み直した行の形どおりに言う', () => {
  it('⭐ 直す直前に行が消えていたら「片付けてある」と言わず、台帳に無くなったと言う', async () => {
    const reply = await edit('vanished');

    expect(reply).not.toContain('片付けてある');
    expect(reply).toContain('台帳に無い');
    expect(reply).toContain('直していない');
  });

  it('⭐ 行が残っていて閉じてもいないなら、直せなかったと言う', async () => {
    const reply = await edit('still-open');

    expect(reply).not.toContain('片付けてある');
    expect(reply).toContain('直せなかった');
  });

  it('⭐ 読み直した行が読めない形でも、道具ごと落ちずに言う', async () => {
    const reply = await edit('unreadable');

    expect(reply).toContain('読めない');
    expect(reply).toContain('直していない');
  });
});
