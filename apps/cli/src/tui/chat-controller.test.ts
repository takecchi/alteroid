import { describe, expect, it } from 'vitest';

import { ChatController, MAX_ENTRIES } from './chat-controller.js';
import { fakeApi, gate } from './fake-api.js';

const open = (conversationId: string) => ({ type: 'open' as const, conversationId });

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

describe('send', () => {
  it('発言を積み、応答の本文を確定させ、done で進行中の合図を畳む', async () => {
    const { api, controller, state, texts } = setup();
    api.scripts.push([
      open('c1'),
      { type: 'queued' },
      { type: 'thinking' },
      { type: 'text', text: 'こん' },
      { type: 'text', text: 'にちは' },
      { type: 'done' },
    ]);
    await controller.send('やあ');
    expect(texts('user')).toEqual(['やあ']);
    expect(texts('assistant')).toEqual(['こんにちは']);
    expect(state()).toMatchObject({
      conversationId: 'c1',
      busy: false,
      transient: null,
      streaming: '',
    });
  });

  it('送ると決めた瞬間から「考えている…」を出し、queued / thinking で差し替える', async () => {
    const { api, controller, state } = setup();
    const g1 = gate();
    const g2 = gate();
    api.scripts.push([open('c1'), { type: 'queued' }, g1.wait, { type: 'thinking' }, g2.wait]);
    const sending = controller.send('x');
    expect(state()).toMatchObject({ busy: true, transient: '考えている…' });
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
    expect(state().transient).toBe('順番を待っている…');
    g1.open();
    await new Promise((r) => setTimeout(r, 0));
    expect(state().transient).toBe('考えている…');
    g2.open();
    await sending;
    expect(state()).toMatchObject({ busy: false, transient: null });
  });

  it('会話 id を引き継ぐ（新しい会話は id 無し、2 回目から open の id）', async () => {
    const { api, controller } = setup();
    api.scripts.push([open('c1'), { type: 'done' }], [open('c1'), { type: 'done' }]);
    await controller.send('一つ目');
    await controller.send('二つ目');
    expect(api.chatCalls).toEqual([{ text: '一つ目' }, { text: '二つ目', conversationId: 'c1' }]);
  });

  it('ツールが挟まる前に流れていた本文を確定させ、ツールをログに残す', async () => {
    const { api, controller, state, texts } = setup();
    api.scripts.push([
      open('c1'),
      { type: 'text', text: '調べます' },
      { type: 'tool', tool: 'Bash' },
      { type: 'text', text: '結果です' },
      { type: 'done' },
    ]);
    await controller.send('x');
    expect(state().entries.map((e) => [e.kind, e.text])).toEqual([
      ['user', 'x'],
      ['assistant', '調べます'],
      ['tool', 'Bash'],
      ['assistant', '結果です'],
    ]);
    expect(texts('tool')).toEqual(['Bash']);
  });

  it('ask_human は承認待ちの id と質問を残し、答えられる口を案内する', async () => {
    const { api, controller, texts, state } = setup();
    api.scripts.push([
      open('c1'),
      { type: 'ask_human', approvalId: 'ap-9', question: 'どちらにしますか' },
      { type: 'done' },
    ]);
    await controller.send('x');
    const [ask] = texts('ask');
    expect(ask).toContain('ap-9');
    expect(ask).toContain('どちらにしますか');
    expect(ask).toContain('/answer ap-9');
    // 承認待ちのタブの詳細へ飛ぶ口（a・/approvals <id>）も案内する。
    expect(ask).toContain('Esc のあと a');
    expect(ask).toContain('/approvals ap-9');
    expect(state().pendingAsk).toBe('ap-9');
  });

  it('新しい会話を始めると、前の会話の ask_human の覚えは消える', async () => {
    const { api, controller, state } = setup();
    api.scripts.push([
      open('c1'),
      { type: 'ask_human', approvalId: 'ap-9', question: 'q' },
      { type: 'done' },
    ]);
    await controller.send('x');
    expect(state().pendingAsk).toBe('ap-9');
    controller.newConversation();
    expect(state().pendingAsk).toBeNull();
  });

  it('usage_limited は文言を要約せず、発言が保持されていることを添えて残す', async () => {
    const { api, controller, texts } = setup();
    api.scripts.push([
      open('c1'),
      { type: 'usage_limited', message: '5時間の枠が閉じている（SDK の文言そのまま）' },
      { type: 'error', message: '枠が閉じている' },
    ]);
    await controller.send('x');
    expect(texts('system')[0]).toContain('5時間の枠が閉じている（SDK の文言そのまま）');
    expect(texts('system')[0]).toContain('保持されていて');
    expect(texts('error')).toEqual(['枠が閉じている']);
  });

  it('接続の失敗はログに残り、busy が戻る', async () => {
    const { api, controller, state, texts } = setup();
    api.scripts.push([new Error('接続が切れました')]);
    await controller.send('x');
    expect(texts('error')).toEqual(['接続が切れました']);
    expect(state()).toMatchObject({ busy: false, transient: null });
  });

  it('空の発言は送らない', async () => {
    const { api, controller } = setup();
    await controller.send('');
    expect(api.chatCalls).toEqual([]);
  });
});

describe('追送（応答中の発言）', () => {
  it('open で決まった会話へ投函し、open を見たところで受信をやめる', async () => {
    const { api, controller, state } = setup();
    const hold = gate();
    api.scripts.push(
      [open('c1'), hold.wait, { type: 'text', text: '応答' }, { type: 'done' }],
      [open('c1'), { type: 'text', text: '(使われない)' }],
    );
    const first = controller.send('一つ目');
    await new Promise((r) => setTimeout(r, 0));
    await controller.send('追送です');
    expect(api.chatCalls).toEqual([{ text: '一つ目' }, { text: '追送です', conversationId: 'c1' }]);
    expect(state().entries.map((e) => e.text)).toEqual(['一つ目', '追送です']);
    hold.open();
    await first;
    // 追送側のストリームの本文は取り込まない（応答は走っている側に流れてくる）。
    expect(state().entries.map((e) => e.text)).toEqual(['一つ目', '追送です', '応答']);
  });

  it('新しい会話で id が未確定でも、open を待ってその会話へ投函する', async () => {
    const { api, controller } = setup();
    const lateOpen = gate();
    api.scripts.push([lateOpen.wait, open('c7'), { type: 'done' }], [open('c7')]);
    const first = controller.send('一つ目');
    const follow = controller.send('追送');
    await new Promise((r) => setTimeout(r, 0));
    expect(api.chatCalls).toEqual([{ text: '一つ目' }]); // まだ投函しない（別の会話になってしまう）
    lateOpen.open();
    await Promise.all([first, follow]);
    expect(api.chatCalls[1]).toEqual({ text: '追送', conversationId: 'c7' });
  });

  it('open を見ないまま接続が終わったら、追送は失敗として残る', async () => {
    const { api, controller, texts } = setup();
    const g = gate();
    api.scripts.push([g.wait, new Error('落ちた')]);
    const first = controller.send('一つ目');
    const follow = controller.send('追送');
    g.open();
    await Promise.all([first, follow]);
    expect(texts('error')).toContain('会話が始まらないまま接続が終わったので、続きを送れなかった');
  });
});

describe('会話の操作', () => {
  it('interrupt は結果を文言にして残す', async () => {
    const { api, controller, texts } = setup();
    await controller.interrupt();
    expect(api.interrupts).toBe(1);
    expect(texts('system')).toEqual(['いま走っていたクローンのターンを止めた。']);
  });

  it('endConversation は会話を終えて新しい会話に戻る。会話が無ければ何もしない', async () => {
    const { api, controller, state, texts } = setup();
    await controller.endConversation();
    expect(api.ended).toEqual([]);
    expect(texts('system')).toEqual(['終える会話がまだ無い']);

    api.scripts.push([open('c1'), { type: 'done' }]);
    await controller.send('x');
    await controller.endConversation();
    expect(api.ended).toEqual(['c1']);
    expect(state().conversationId).toBeNull();
    expect(texts('system').at(-1)).toContain('会話を終えた');
  });

  it('end の失敗では会話を手放さない', async () => {
    const { api, controller, state, texts } = setup();
    api.scripts.push([open('c1'), { type: 'done' }]);
    await controller.send('x');
    api.endFails = true;
    await controller.endConversation();
    expect(state().conversationId).toBe('c1');
    expect(texts('error')).toEqual(['終えられない']);
  });

  it('shutdown は会話があれば終える（既存 CLI の chat と同じ）。失敗しても投げない', async () => {
    const { api, controller } = setup();
    await controller.shutdown();
    expect(api.ended).toEqual([]);
    api.scripts.push([open('c1'), { type: 'done' }]);
    await controller.send('x');
    api.endFails = true;
    await expect(controller.shutdown()).resolves.toBeUndefined();
    expect(api.ended).toEqual(['c1']);
  });

  it('履歴の会話を開き直すと、発言と応答を並べて会話 id を引き継ぐ', async () => {
    const { api, controller, state } = setup();
    api.messages.c9 = [
      { id: '1', at: 't', role: 'inbound', text: '前の質問' },
      { id: '2', at: 't', role: 'outbound', text: '前の答え' },
    ];
    expect(await controller.openConversation('c9')).toBe(true);
    expect(state().conversationId).toBe('c9');
    expect(state().entries.map((e) => [e.kind, e.text])).toEqual([
      ['user', '前の質問'],
      ['assistant', '前の答え'],
    ]);
    api.scripts.push([open('c9'), { type: 'done' }]);
    await controller.send('続き');
    expect(api.chatCalls[0]).toEqual({ text: '続き', conversationId: 'c9' });
  });

  it('窓が先頭に届いていない会話は、中身が空なら開かず、あれば古い側が欠けうる旨を添える', async () => {
    const { api, controller, state, texts } = setup();
    api.messages.empty = [];
    api.unreachedStart.add('empty');
    expect(await controller.openConversation('empty')).toBe(false);
    expect(texts('error')[0]).toContain('判定できない');
    expect(state().conversationId).toBeNull();

    api.messages.partial = [{ id: '1', at: 't', role: 'inbound', text: '途中から' }];
    api.unreachedStart.add('partial');
    expect(await controller.openConversation('partial')).toBe(true);
    expect(state().conversationId).toBe('partial');
    expect(texts('system').at(-1)).toContain('遡れた範囲だけ');
  });

  it('無い会話は開かず、いまの会話を残す', async () => {
    const { controller, state, texts } = setup();
    expect(await controller.openConversation('nope')).toBe(false);
    expect(texts('error')).toEqual(['そんな会話はありません: nope']);
    expect(state().conversationId).toBeNull();
  });

  it('応答中は会話を切り替えない', async () => {
    const { api, controller, state, texts } = setup();
    const g = gate();
    api.scripts.push([open('c1'), g.wait, { type: 'done' }]);
    const sending = controller.send('x');
    await new Promise((r) => setTimeout(r, 0));
    expect(controller.newConversation()).toBe(false);
    expect(await controller.openConversation('c9')).toBe(false);
    expect(state().conversationId).toBe('c1');
    expect(texts('system').filter((t) => t.includes('応答中'))).toHaveLength(2);
    g.open();
    await sending;
  });

  it('ログは MAX_ENTRIES を超えたら古い側から捨てる（長く開いても膨らまない）', () => {
    const { controller, state } = setup();
    for (let i = 0; i < MAX_ENTRIES + 50; i += 1) controller.addSystem(`n${String(i)}`);
    expect(state().entries).toHaveLength(MAX_ENTRIES);
    expect(state().entries.at(-1)?.text).toBe(`n${String(MAX_ENTRIES + 49)}`);
  });
});

describe('進行中の会話へ戻る（履歴から開く）', () => {
  const openIn = (conversationId: string, inProgress: boolean) => ({
    type: 'open' as const,
    conversationId,
    inProgress,
  });
  const tick = () => new Promise((r) => setTimeout(r, 0));
  const history = (api: ReturnType<typeof fakeApi>) => {
    api.messages.c9 = [
      { id: '1', at: 't', role: 'inbound', text: '前の質問' },
      { id: '2', at: 't', role: 'outbound', text: '前の答え' },
      { id: '3', at: 't', role: 'inbound', text: '今の質問' },
    ];
  };

  it('進行中なら考え中と途中の文章が出て、続きが流れ、done で確定する（履歴と二重にならない）', async () => {
    const { api, controller, state, texts } = setup();
    history(api);
    const hold = gate();
    api.streamScripts.push([
      openIn('c9', true),
      { type: 'thinking' },
      { type: 'text', text: 'ここまで' },
      hold.wait,
      { type: 'text', text: 'の続き' },
      { type: 'done' },
    ]);
    expect(await controller.openConversation('c9')).toBe(true);
    await tick();
    expect(api.streamCalls.map((c) => c.conversationId)).toEqual(['c9']);
    expect(state()).toMatchObject({ busy: true, streaming: 'ここまで', transient: null });
    expect(texts('assistant')).toEqual(['前の答え']); // 途中の文章はまだログに入らない
    hold.open();
    await tick();
    expect(state()).toMatchObject({ busy: false, streaming: '', transient: null });
    expect(texts('assistant')).toEqual(['前の答え', 'ここまでの続き']);
    expect(texts('user')).toEqual(['前の質問', '今の質問']);
  });

  it('再生の前は考え中が出る', async () => {
    const { api, controller, state } = setup();
    history(api);
    const hold = gate();
    api.streamScripts.push([openIn('c9', true), hold.wait, { type: 'done' }]);
    await controller.openConversation('c9');
    await tick();
    expect(state()).toMatchObject({ busy: true, transient: '考えている…' });
    hold.open();
    await tick();
    expect(state().busy).toBe(false);
  });

  it('進行中でなければ何も出さず、busy も立たない', async () => {
    const { api, controller, state } = setup();
    history(api);
    api.streamScripts.push([openIn('c9', false), { type: 'text', text: '(出ない)' }]);
    await controller.openConversation('c9');
    await tick();
    expect(api.streamCalls).toHaveLength(1);
    expect(state()).toMatchObject({ busy: false, transient: null, streaming: '' });
    expect(state().entries.map((e) => e.text)).toEqual(['前の質問', '前の答え', '今の質問']);
    api.scripts.push([open('c9'), { type: 'done' }]);
    await controller.send('続き'); // busy でないので追送ではなく通常の送信
    expect(api.chatCalls).toEqual([{ text: '続き', conversationId: 'c9' }]);
  });

  it('履歴を読んだ後、open までにターンが終わっていたら、読み直して返信を出す', async () => {
    const { api, controller, texts } = setup();
    history(api);
    const hold = gate();
    api.streamScripts.push([hold.wait, openIn('c9', false)]);
    await controller.openConversation('c9');
    await tick();
    expect(texts('assistant')).toEqual(['前の答え']);
    // 接続を張るまでの間にターンが終わり、返信が日誌に載った。
    api.messages.c9 = [
      ...(api.messages.c9 ?? []),
      { id: '4', at: 't', role: 'outbound', text: '今の答え' },
    ];
    hold.open();
    await tick();
    expect(texts('assistant')).toEqual(['前の答え', '今の答え']);
    expect(texts('user')).toEqual(['前の質問', '今の質問']);
  });

  it('読み直しの最中に別の会話へ移ったら、差し替えない', async () => {
    const { api, controller, state, texts } = setup();
    history(api);
    api.messages.other = [{ id: '9', at: 't', role: 'inbound', text: '別の会話' }];
    api.streamScripts.push([openIn('c9', false)], [openIn('other', false)]);
    const original = api.readConversation.bind(api);
    const reread = gate();
    let calls = 0;
    api.readConversation = async (id) => {
      calls += 1;
      if (calls === 2) await reread.wait; // 戻り接続の読み直し
      return original(id);
    };
    await controller.openConversation('c9');
    await tick();
    expect(calls).toBe(2);
    expect(await controller.openConversation('other')).toBe(true);
    reread.open();
    await tick();
    expect(state().conversationId).toBe('other');
    expect(texts()).toEqual(['別の会話']);
  });

  it('開けなかった会話では接続を張らない', async () => {
    const { api, controller } = setup();
    expect(await controller.openConversation('nope')).toBe(false);
    expect(api.streamCalls).toEqual([]);
  });

  it('再生中に送ると追送になる（もう1本の応答ストリームを取り込まない）', async () => {
    const { api, controller, state, texts } = setup();
    history(api);
    const hold = gate();
    api.streamScripts.push([
      openIn('c9', true),
      hold.wait,
      { type: 'text', text: '応答' },
      { type: 'done' },
    ]);
    api.scripts.push([open('c9'), { type: 'text', text: '(使われない)' }]);
    await controller.openConversation('c9');
    await tick();
    await controller.send('追送です');
    expect(api.chatCalls).toEqual([{ text: '追送です', conversationId: 'c9' }]);
    expect(texts('user').at(-1)).toBe('追送です');
    expect(state().busy).toBe(true);
    hold.open();
    await tick();
    expect(texts('assistant')).toEqual(['前の答え', '応答']);
    expect(state().busy).toBe(false);
  });

  it('接続を張っただけ（open 前）に送ると、通常の送信になり戻り接続は捨てる（二重にならない）', async () => {
    const { api, controller, state, texts } = setup();
    history(api);
    const hold = gate();
    api.streamScripts.push([
      hold.wait,
      openIn('c9', true),
      { type: 'text', text: '二重' },
      { type: 'done' },
    ]);
    api.scripts.push([open('c9'), { type: 'text', text: '本物' }, { type: 'done' }]);
    await controller.openConversation('c9');
    await tick();
    await controller.send('すぐ送る');
    hold.open();
    await tick();
    expect(api.streamCalls[0]?.aborted()).toBe(true);
    expect(texts('assistant')).toEqual(['前の答え', '本物']);
    expect(state().busy).toBe(false);
  });

  it('再生中に別の会話を開くと abort され、古い出来事は新しい画面に混ざらない', async () => {
    const { api, controller, state, texts } = setup();
    history(api);
    api.messages.other = [{ id: '9', at: 't', role: 'inbound', text: '別の会話' }];
    const hold = gate();
    api.streamScripts.push(
      [
        openIn('c9', true),
        { type: 'text', text: '途中' },
        hold.wait,
        { type: 'text', text: '漏れる' },
      ],
      [openIn('other', false)],
    );
    await controller.openConversation('c9');
    await tick();
    expect(await controller.openConversation('other')).toBe(true);
    expect(api.streamCalls[0]?.aborted()).toBe(true);
    expect(state()).toMatchObject({ conversationId: 'other', busy: false, streaming: '' });
    hold.open();
    await tick();
    expect(state()).toMatchObject({ conversationId: 'other', busy: false, streaming: '' });
    expect(texts('assistant')).toEqual([]);
  });

  it('newConversation / endConversation / shutdown でも abort される', async () => {
    for (const leave of ['new', 'end', 'shutdown'] as const) {
      const { api, controller, state } = setup();
      history(api);
      const hold = gate();
      api.streamScripts.push([openIn('c9', true), hold.wait, { type: 'text', text: '漏れる' }]);
      await controller.openConversation('c9');
      await tick();
      expect(state().busy).toBe(true);
      if (leave === 'new') expect(controller.newConversation()).toBe(true);
      else if (leave === 'end') await controller.endConversation();
      else await controller.shutdown();
      expect(api.streamCalls[0]?.aborted()).toBe(true);
      hold.open();
      await tick();
      expect(state().streaming).toBe('');
    }
  });

  it('接続が途中で切れたら、エラーを残して busy を畳む', async () => {
    const { api, controller, state, texts } = setup();
    history(api);
    api.streamScripts.push([
      openIn('c9', true),
      { type: 'text', text: '途中' },
      new Error('切れた'),
    ]);
    await controller.openConversation('c9');
    await tick();
    expect(state()).toMatchObject({ busy: false, streaming: '' });
    expect(texts('assistant')).toEqual(['前の答え', '途中']);
    expect(texts('error')).toHaveLength(1);
  });
});
