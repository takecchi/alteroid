import { describe, expect, it } from 'vitest';

import { ChatController } from './chat-controller.js';
import { fakeApi } from './fake-api.js';

function setup() {
  const api = fakeApi();
  const controller = new ChatController(api);
  const entries = () =>
    controller.store.getSnapshot().entries.map((e) => [e.kind, e.text] as const);
  return { api, controller, entries };
}

const said = (id: string, text: string, delivery?: 'withdrawn') => ({
  id,
  at: 't',
  role: 'inbound' as const,
  text,
  ...(delivery === undefined ? {} : { delivery }),
});

describe('TUI の履歴: 取り下げた発言（#3990）', () => {
  it('取り下げた発言は ❯ の発言の行にせず、「（取り下げた発言）」の system の行で出す', async () => {
    const { api, controller, entries } = setup();
    api.messages.c9 = [said('1', '届いた発言'), said('2', '取り下げた発言', 'withdrawn')];
    expect(await controller.openConversation('c9')).toBe(true);
    expect(entries()).toEqual([
      ['user', '届いた発言'],
      ['system', '（取り下げた発言）取り下げた発言'],
    ]);
  });

  it('欄の無い応答（古いデーモン）は今までどおり、普通の発言の行', async () => {
    const { api, controller, entries } = setup();
    api.messages.c9 = [said('1', '一つ目'), said('2', '二つ目')];
    expect(await controller.openConversation('c9')).toBe(true);
    expect(entries()).toEqual([
      ['user', '一つ目'],
      ['user', '二つ目'],
    ]);
  });
});
