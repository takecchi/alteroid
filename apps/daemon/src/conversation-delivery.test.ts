import { createMemoryStores, type CloneHost, type Stores } from '@alteroid/core';
import { beforeEach, describe, expect, it } from 'vitest';

import { createApp } from './app.js';

let stores: Stores;
let app: ReturnType<typeof createApp>;

beforeEach(() => {
  stores = createMemoryStores();
  app = createApp({
    clone: {} as unknown as CloneHost,
    stores,
    token: 'test-token',
    shutdown: () => undefined,
  });
});

const said = (conversationId: string, text: string, clientMessageId?: string) =>
  stores.journal.append({
    type: 'exchange',
    with: 'human',
    role: 'inbound',
    text,
    conversationId,
    ...(clientMessageId === undefined ? {} : { clientMessageId }),
  });

/** `Clone#interruptTurn` が取り下げのときに足す印の行と同じ形。 */
const withdrew = (conversationId: string, clientMessageId: string) =>
  stores.journal.append({
    type: 'exchange',
    with: 'self',
    role: 'outbound',
    text: `[判断] 人間の求めで、順番待ちだった発言（clientMessageId ${clientMessageId}）を取り下げた。`,
    conversationId,
    withdrawnClientMessageId: clientMessageId,
  });

interface Body {
  messages: { text: string; role: string; delivery?: string; clientMessageId?: string }[];
}
const read = async (id: string, query = ''): Promise<Body> => {
  const response = await app.request(`/conversations/${id}${query}`);
  expect(response.status).toBe(200);
  return (await response.json()) as Body;
};
const deliveryOf = (body: Body) => body.messages.map((m) => [m.text, m.delivery]);

describe('GET /conversations/:id の delivery（#3990）', () => {
  it('取り下げた発言だけに withdrawn が付き、取り下げていない発言は欄を出さない', async () => {
    await said('c', '前の発言', 'cm-1');
    await said('c', '取り下げた発言', 'cm-2');
    await withdrew('c', 'cm-2');
    await said('c', '後の発言', 'cm-3');

    const body = await read('c');

    expect(deliveryOf(body)).toEqual([
      ['前の発言', undefined],
      ['取り下げた発言', 'withdrawn'],
      ['後の発言', undefined],
    ]);
    // 欄そのものを出さない（`delivery: undefined` のキーも無い）
    expect('delivery' in body.messages[0]!).toBe(false);
    expect(body.messages[1]!.clientMessageId).toBe('cm-2');
  });

  it('別の会話で取り下げた同じ id・文面だけで推し量らない・clientMessageId の無い発言には付けない', async () => {
    await said('c', '取り下げた発言', 'cm-2');
    await said('c', 'id が無い', undefined);
    await withdrew('other', 'cm-2');
    // 文面に id が書いてあるだけの印の無い行は根拠にならない
    await stores.journal.append({
      type: 'exchange',
      with: 'self',
      role: 'outbound',
      text: '[判断] 順番待ちだった発言（clientMessageId cm-2）を取り下げた',
      conversationId: 'c',
    });

    expect(deliveryOf(await read('c'))).toEqual([
      ['取り下げた発言', undefined],
      ['id が無い', undefined],
    ]);
  });

  it('編集で畳まれた旧発言を含めて返すときも、取り下げた発言に付く', async () => {
    await said('c', '送った発言', 'cm-1');
    await withdrew('c', 'cm-1');

    expect(deliveryOf(await read('c', '?includeSuperseded=true'))).toEqual([
      ['送った発言', 'withdrawn'],
    ]);
  });

  it('取り下げの印が多数の内部の行の向こうにあっても読み落とさない（頁をまたぐ）', async () => {
    await said('c', '取り下げた発言', 'cm-1');
    for (let i = 0; i < 520; i += 1) {
      await stores.journal.append({
        type: 'exchange',
        with: 'self',
        role: 'outbound',
        text: `内部の行 ${String(i)}`,
        conversationId: 'c',
      });
    }
    await withdrew('c', 'cm-1');

    expect(deliveryOf(await read('c'))).toEqual([['取り下げた発言', 'withdrawn']]);
  });
});
