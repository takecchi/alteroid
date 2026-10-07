import { describe, expect, it } from 'vitest';

import { ChatController } from './chat-controller.js';
import { fakeApi, gate } from './fake-api.js';

const open = (conversationId: string) => ({ type: 'open' as const, conversationId });
const tick = () => new Promise((r) => setTimeout(r, 0));

function setup() {
  const api = fakeApi();
  const controller = new ChatController(api);
  const state = () => controller.store.getSnapshot();
  const texts = (kind?: string) =>
    state()
      .entries.filter((e) => kind === undefined || e.kind === kind)
      .map((e) => e.text);
  return { api, controller, state, texts };
}

describe('interrupt の対象（#3989）', () => {
  it('応答中の Ctrl+C は、いま送った発言（会話 id と clientMessageId）を対象にして止める', async () => {
    const { api, controller } = setup();
    const g = gate();
    api.scripts.push([open('c1'), { type: 'thinking' }, g.wait, { type: 'done' }]);
    const sending = controller.send('やあ');
    await tick();
    await controller.interrupt();
    expect(api.interruptTargets).toEqual([
      { conversationId: 'c1', clientMessageId: api.chatClientMessageIds[0] },
    ]);
    g.open();
    expect(await sending).toBe(true);
  });

  it('既存の会話への送信は、open を待たずに対象が分かる', async () => {
    const { api, controller } = setup();
    api.scripts.push([open('c1'), { type: 'done' }]);
    await controller.send('一つ目');
    const g = gate();
    api.scripts.push([g.wait, { type: 'done' }]);
    const sending = controller.send('二つ目');
    await tick();
    await controller.interrupt();
    expect(api.interruptTargets).toEqual([
      { conversationId: 'c1', clientMessageId: api.chatClientMessageIds[1] },
    ]);
    g.open();
    await sending;
  });

  it('順番待ちのあいだの Ctrl+C は取り下げで、先客を止めず、送らなかった本文を戻させる', async () => {
    const { api, controller, state, texts } = setup();
    const g = gate();
    api.scripts.push([open('c1'), { type: 'queued' }, g.wait, { type: 'done' }]);
    api.interruptOutcome = 'withdrawn';
    const sending = controller.send('順番待ちの発言');
    await tick();
    expect(state().transient).toBe('順番を待っている…');
    const result = await controller.interrupt();
    expect(result.ok).toBe(true);
    expect(api.interruptTargets).toEqual([
      { conversationId: 'c1', clientMessageId: api.chatClientMessageIds[0] },
    ]);
    expect(await sending).toBe(false);
    expect(state()).toMatchObject({ busy: false, transient: null });
    expect(texts('system')).toEqual(
      expect.arrayContaining([
        '送れなかった発言:\n順番待ちの発言',
        expect.stringContaining('順番待ちだった発言を取り下げた'),
      ]),
    );
    expect(texts('error')).toEqual([]);
    g.open();
  });

  it('取り下げた発言は送り直すと新しい clientMessageId になる', async () => {
    const { api, controller } = setup();
    const g = gate();
    api.scripts.push([open('c1'), { type: 'queued' }, g.wait]);
    api.interruptOutcome = 'withdrawn';
    const sending = controller.send('もう一度');
    await tick();
    await controller.interrupt();
    await sending;
    api.scripts.push([open('c1'), { type: 'done' }]);
    await controller.send('もう一度');
    const [first, second] = api.chatClientMessageIds;
    expect(first).not.toBe(second);
  });

  it.each([
    ['not_target', '別の起点'],
    ['starting', 'もう一度 Ctrl+C'],
  ] as const)('%s のときは自分の流れを閉じず、そのまま続ける', async (outcome, word) => {
    const { api, controller, state, texts } = setup();
    const g = gate();
    api.scripts.push([
      open('c1'),
      { type: 'queued' },
      g.wait,
      { type: 'text', text: '返答' },
      { type: 'done' },
    ]);
    api.interruptOutcome = outcome;
    const sending = controller.send('x');
    await tick();
    await controller.interrupt();
    expect(state().busy).toBe(true);
    expect(texts('system').join('\n')).toContain(word);
    g.open();
    expect(await sending).toBe(true);
    expect(texts('assistant')).toEqual(['返答']);
    expect(texts('system').join('\n')).not.toContain('送れなかった発言');
  });

  it('新しい会話で open の前なら、対象を省かずに何も止めない', async () => {
    const { api, controller, texts } = setup();
    const g = gate();
    api.scripts.push([g.wait, open('c1'), { type: 'done' }]);
    const sending = controller.send('x');
    await tick();
    await controller.interrupt();
    expect(api.interrupts).toBe(0);
    expect(texts('system').join('\n')).toContain('何も止めていない');
    g.open();
    await sending;
  });

  it('自分の発言が無いとき（走っていない）は、従来どおり対象を付けない', async () => {
    const { api, controller } = setup();
    await controller.interrupt();
    expect(api.interruptTargets).toEqual([undefined]);
  });
});
