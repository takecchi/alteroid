import { describe, expect, it } from 'vitest';

import { ChatController } from './chat-controller.js';
import { fakeApi, gate } from './fake-api.js';

const open = (conversationId: string) => ({ type: 'open' as const, conversationId });

function setup() {
  const api = fakeApi();
  const controller = new ChatController(api);
  const texts = (kind?: string) =>
    controller.store
      .getSnapshot()
      .entries.filter((e) => kind === undefined || e.kind === kind)
      .map((e) => e.text);
  return { api, controller, texts };
}

// 追送の POST が open を出さずに閉じる（デーモンが受信箱へ書けずに閉じた・経路が切れた）（#4697）
describe('追送が open を返さずに閉じたら、送れなかった扱いにする（#4697）', () => {
  it('⭐ false を返し（文は入力欄へ戻る）、行は「送れなかった発言」に替わり、失敗を出す', async () => {
    const { api, controller, texts } = setup();
    const hold = gate();
    api.scripts.push([open('c1'), hold.wait, { type: 'done' }], []);
    const first = controller.send('一つ目');
    await new Promise((r) => setTimeout(r, 0));

    expect(await controller.send('追送')).toBe(false);
    expect(texts('system')).toContain('送れなかった発言:\n追送');
    expect(texts('user')).toEqual(['一つ目']);
    expect(texts('error').some((text) => text.includes('受け取られなかった'))).toBe(true);

    hold.open();
    await first;
  });

  it('⭐ 同じ文を送り直すときは同じ clientMessageId を使う（実は受け取られていても二重に届かない）。別の文には新しい id を付ける', async () => {
    const { api, controller } = setup();
    const hold = gate();
    api.scripts.push([open('c1'), hold.wait, { type: 'done' }], [], [open('c1')], [open('c1')]);
    const first = controller.send('一つ目');
    await new Promise((r) => setTimeout(r, 0));

    expect(await controller.send('追送')).toBe(false);
    expect(await controller.send('追送')).toBe(true);
    expect(await controller.send('別の追送')).toBe(true);
    const [, quiet, resent, other] = api.chatClientMessageIds;
    expect(resent).toBe(quiet);
    expect(other).not.toBe(quiet);

    hold.open();
    await first;
  });
});
