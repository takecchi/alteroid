import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { DEFAULT_ATTACHMENT_LIMITS, type AttachmentLimits } from '@alteroid/core';
import { describe, expect, it, vi } from 'vitest';

import { makeTempDir } from '../../../../vitest.tmpdir.js';

import { ChatController, MAX_ENTRIES, RESUME_PROBE_LIMIT } from './chat-controller.js';
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
    expect(controller.shutdownFailure).toBeNull();
    api.scripts.push([open('c1'), { type: 'done' }]);
    await controller.send('x');
    api.endFails = true;
    await expect(controller.shutdown()).resolves.toBeUndefined();
    expect(api.ended).toEqual(['c1']);
    // 握りつぶさない: 終えられなかったことと、あとで終える手段を持つ（終了後に端末へ出す）。
    expect(controller.shutdownFailure).toContain('会話 c1 を終えられませんでした（終えられない）');
    expect(controller.shutdownFailure).toContain('会話は終わっておらず');
    expect(controller.shutdownFailure).toContain('/end');
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

describe('/resume（明示して進行中の会話へ戻る）', () => {
  const openIn = (conversationId: string, inProgress: boolean) => ({
    type: 'open' as const,
    conversationId,
    inProgress,
  });
  // 実時間を待たず、積まれた約束だけを流す。
  const flush = async () => {
    for (let i = 0; i < 50; i += 1) await Promise.resolve();
  };
  const summary = (conversationId: string) => ({
    conversationId,
    startedAt: 't',
    updatedAt: 't',
    messages: 2,
    preview: conversationId,
  });
  const withHistory = (api: ReturnType<typeof fakeApi>, ids: string[]) => {
    api.conversations = ids.map(summary);
    for (const id of ids) {
      api.messages[id] = [
        { id: `${id}a`, at: 't', role: 'inbound', text: `${id} の質問` },
        { id: `${id}b`, at: 't', role: 'outbound', text: `${id} の前の答え` },
        { id: `${id}c`, at: 't', role: 'inbound', text: `${id} の今の質問` },
      ];
    }
  };

  it('id 無しは、新しい順に探して最初の進行中の会話へ戻る（途中経過を再生し、続きを流す）', async () => {
    const { api, controller, state, texts } = setup();
    withHistory(api, ['c1', 'c2', 'c3']);
    const hold = gate();
    api.streamScripts.push(
      [openIn('c1', false)], // 探す: 進行中でない
      [openIn('c2', true)], // 探す: 進行中
      [
        openIn('c2', true),
        { type: 'text', text: 'ここまで' },
        hold.wait,
        { type: 'text', text: '続き' },
        { type: 'done' },
      ],
    );
    expect(await controller.resumeConversation()).toBe(true);
    await flush();
    expect(api.streamCalls.map((c) => c.conversationId)).toEqual(['c1', 'c2', 'c2']);
    expect(api.streamCalls[0]?.aborted()).toBe(true); // 探すための接続は閉じる
    expect(api.streamCalls[1]?.aborted()).toBe(true);
    expect(state()).toMatchObject({ conversationId: 'c2', busy: true, streaming: 'ここまで' });
    hold.open();
    await flush();
    expect(state()).toMatchObject({ busy: false, streaming: '' });
    expect(texts('assistant')).toEqual(['c2 の前の答え', 'ここまで続き']);
  });

  it('id 指定は、その会話だけを見る', async () => {
    const { api, controller, state } = setup();
    withHistory(api, ['c1', 'c2']);
    api.streamScripts.push([openIn('c2', true)], [openIn('c2', true), { type: 'done' }]);
    expect(await controller.resumeConversation('c2')).toBe(true);
    await flush();
    expect(api.streamCalls.map((c) => c.conversationId)).toEqual(['c2', 'c2']);
    expect(state().conversationId).toBe('c2');
  });

  it('進行中の会話が無ければ通知を出し、画面は変えない', async () => {
    const { api, controller, state, texts } = setup();
    withHistory(api, ['c1', 'c2']);
    api.streamScripts.push([openIn('c1', false)], [openIn('c2', false)]);
    expect(await controller.resumeConversation()).toBe(false);
    expect(texts('system')).toEqual(['進行中の会話は無い（/history で履歴から開ける）']);
    expect(state()).toMatchObject({ conversationId: null, busy: false });
    expect(api.streamCalls).toHaveLength(2);
  });

  it('id 指定で進行中でなければ、その id を添えて通知する', async () => {
    const { api, controller, texts } = setup();
    withHistory(api, ['c1']);
    api.streamScripts.push([openIn('c1', false)]);
    expect(await controller.resumeConversation('c1')).toBe(false);
    expect(texts('system')).toEqual([
      '会話 c1 に進行中のターンは無い（/history で履歴から開ける）',
    ]);
  });

  it('探すのは新しい順に最大 RESUME_PROBE_LIMIT 件まで', async () => {
    const { api, controller } = setup();
    const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
    withHistory(api, ids);
    for (const id of ids) api.streamScripts.push([openIn(id, false)]);
    await controller.resumeConversation();
    expect(api.streamCalls.map((c) => c.conversationId)).toEqual(ids.slice(0, RESUME_PROBE_LIMIT));
  });

  it('履歴が空なら接続を張らずに通知する', async () => {
    const { api, controller, texts } = setup();
    expect(await controller.resumeConversation()).toBe(false);
    expect(api.streamCalls).toEqual([]);
    expect(texts('system')).toEqual(['進行中の会話は無い（/history で履歴から開ける）']);
  });

  it('接続できなければエラーを残す', async () => {
    const { api, controller, texts } = setup();
    withHistory(api, ['c1']);
    api.streamScripts.push([new Error('つながらない')]);
    expect(await controller.resumeConversation()).toBe(false);
    expect(texts('error')).toHaveLength(1);
  });

  it('自分のターンが応答中は切り替えない', async () => {
    const { api, controller, texts } = setup();
    withHistory(api, ['c1']);
    const hold = gate();
    api.scripts.push([open('c9'), hold.wait, { type: 'done' }]);
    const sending = controller.send('x');
    await flush();
    expect(await controller.resumeConversation()).toBe(false);
    expect(api.streamCalls).toEqual([]);
    expect(texts('system').at(-1)).toContain('応答中は会話を切り替えられない');
    hold.open();
    await sending;
  });

  it('すでに戻って再生中なら、もう1本は張らない', async () => {
    const { api, controller, texts } = setup();
    withHistory(api, ['c1']);
    const hold = gate();
    api.streamScripts.push([openIn('c1', true)], [openIn('c1', true), hold.wait, { type: 'done' }]);
    await controller.resumeConversation();
    await flush();
    expect(await controller.resumeConversation()).toBe(true);
    expect(api.streamCalls).toHaveLength(2);
    expect(texts('system').at(-1)).toBe('すでにこの会話の進行中のターンを表示している');
    hold.open();
    await flush();
  });

  it('履歴から開く（/history）の自動の戻りは変えない（resume を呼ばなくても戻る）', async () => {
    const { api, controller, state } = setup();
    withHistory(api, ['c1']);
    const hold = gate();
    api.streamScripts.push([openIn('c1', true), hold.wait, { type: 'done' }]);
    await controller.openConversation('c1');
    await flush();
    expect(state().busy).toBe(true);
    hold.open();
    await flush();
  });
});

describe('/attach（添えかけ）', () => {
  it('送るときに上げ、id を /chat の attachments に入れ、受理後に添えかけを空にする。失敗なら送らず残す', async () => {
    const dir = await makeTempDir('alteroid-tui-attach-');
    const path = join(dir, 'a.log');
    await writeFile(path, 'log');
    const { api, controller } = setup();
    await controller.attach(path);
    api.uploadFails = '繋がらない';
    await controller.send('見て');
    expect(api.chatCalls).toEqual([]);
    expect(controller.store.getSnapshot().entries.at(-1)?.text).toContain('添えかけは残してある');
    api.uploadFails = null;
    api.scripts.push([{ type: 'open', conversationId: 'c1' }, { type: 'done' }]);
    await controller.send('見て');
    expect(api.chatCalls).toEqual([{ text: '見て', attachments: ['att-2'] }]);
    expect(
      controller.store.getSnapshot().entries.some((e) => e.text.includes('[添付] a.log')),
    ).toBe(true);
    api.scripts.push([{ type: 'done' }]);
    await controller.send('次');
    expect(api.chatCalls[1]).toEqual({ text: '次', conversationId: 'c1' });
  });

  it('添えかけがあれば空の発言で添付だけを送れる。添えかけが無い空の発言は送らない', async () => {
    const dir = await makeTempDir('alteroid-tui-attach-');
    const path = join(dir, 'a.log');
    await writeFile(path, 'log');
    const { api, controller } = setup();
    await controller.send('');
    expect(api.chatCalls).toEqual([]);
    expect(controller.hasAttachments()).toBe(false);
    await controller.attach(path);
    expect(controller.hasAttachments()).toBe(true);
    api.scripts.push([{ type: 'open', conversationId: 'c1' }, { type: 'done' }]);
    await controller.send('');
    expect(api.chatCalls).toEqual([{ text: '', attachments: ['att-1'] }]);
    expect(controller.hasAttachments()).toBe(false);
  });
});

describe('追送の待ちのあいだに足した添えかけ（#3245）', () => {
  // ファイルの読み込みを挟むので、マクロタスクも何度か回す（実時間は待たない）。
  const settle = async () => {
    for (let i = 0; i < 10; i += 1) await new Promise((r) => setTimeout(r, 0));
  };

  it('追送が待っているあいだに /attach した分は、最初のイベントのあとも残る（送った分だけ空にする）', async () => {
    const dir = await makeTempDir('alteroid-tui-attach-');
    const a = join(dir, 'a.log');
    const b = join(dir, 'b.log');
    await writeFile(a, 'a');
    await writeFile(b, 'b');
    const { api, controller, texts } = setup();
    const hold = gate();
    const end = gate();
    api.scripts.push([hold.wait, open('c1'), end.wait, { type: 'done' }], [open('c1')]);
    const first = controller.send('最初');
    await settle();
    await controller.attach(a);
    const followUp = controller.send('追送');
    await settle();
    // 追送は a を上げて、会話が決まる（opened）のを待っている。そのあいだに b を足す。
    await controller.attach(b);
    hold.open();
    await settle();
    expect(api.chatCalls[1]).toEqual({
      text: '追送',
      conversationId: 'c1',
      attachments: ['att-1'],
    });
    expect(controller.hasAttachments()).toBe(true);
    controller.listAttachments();
    const listing = texts('system').at(-1) ?? '';
    expect(listing).toContain('b.log');
    expect(listing).not.toContain('a.log');
    end.open();
    await Promise.all([first, followUp]);
  });
});

describe('既読（返答を画面に表示したとき。docs/architecture.md「会話の既読」）', () => {
  const withReply = (api: ReturnType<typeof fakeApi>) => {
    api.messages.c1 = [
      { id: 'm1', at: 't', role: 'inbound', text: '質問' },
      { id: 'm2', at: 't', role: 'outbound', text: '答え' },
    ];
  };

  it('送信して返答が done まで表示されたら、取り直した最後の発言まで既読にする', async () => {
    const { api, controller } = setup();
    withReply(api);
    api.scripts.push([open('c1'), { type: 'text', text: '答え' }, { type: 'done' }]);
    await controller.send('質問');
    expect(api.readMarks).toEqual([{ id: 'c1', through: 'm2' }]);
  });

  it('done が来ない（接続が切れた）なら既読にしない', async () => {
    const { api, controller } = setup();
    withReply(api);
    api.scripts.push([open('c1'), { type: 'text', text: '途中' }, new Error('切れた')]);
    await controller.send('質問');
    expect(api.readMarks).toEqual([]);
  });

  it('error / usage_limited で終わったら既読にしない', async () => {
    const { api, controller } = setup();
    withReply(api);
    api.scripts.push([open('c1'), { type: 'error', message: '失敗' }, { type: 'done' }]);
    await controller.send('質問');
    api.scripts.push([open('c1'), { type: 'usage_limited', message: '枠' }, { type: 'done' }]);
    await controller.send('もう一度');
    expect(api.readMarks).toEqual([]);
  });

  it('既読の要求が失敗しても、返答も会話も残り、1 行だけ知らせる', async () => {
    const { api, controller, state, texts } = setup();
    withReply(api);
    api.readMarkFails = '落ちた';
    api.scripts.push([open('c1'), { type: 'text', text: '答え' }, { type: 'done' }]);
    await controller.send('質問');
    expect(texts('assistant')).toEqual(['答え']);
    expect(state()).toMatchObject({ conversationId: 'c1', busy: false });
    expect(texts('system')).toEqual(['この会話を既読にできなかった（落ちた）']);
    // 失敗の後は、同じ位置でも次の機会に送り直す。
    api.readMarkFails = null;
    api.scripts.push([open('c1'), { type: 'done' }]);
    await controller.send('続き');
    expect(api.readMarks.map((m) => m.through)).toEqual(['m2', 'm2']);
  });

  it('履歴から開いて表示したときも、表示した最後の発言まで既読にする', async () => {
    const { api, controller } = setup();
    withReply(api);
    await controller.openConversation('c1');
    expect(api.readMarks).toEqual([{ id: 'c1', through: 'm2' }]);
  });

  it('開けなかった会話・発言の無い会話は既読にしない', async () => {
    const { api, controller } = setup();
    api.unreachedStart.add('c2');
    api.messages.c2 = [];
    await controller.openConversation('c2');
    await controller.openConversation('nai');
    expect(api.readMarks).toEqual([]);
  });

  it('戻った進行中のターンが done まで表示されたら、既読にする', async () => {
    const { api, controller } = setup();
    withReply(api);
    const hold = gate();
    api.streamScripts.push([
      { type: 'open', conversationId: 'c1', inProgress: true },
      { type: 'text', text: '続き' },
      hold.wait,
      { type: 'done' },
    ]);
    await controller.openConversation('c1');
    expect(api.readMarks.map((m) => m.through)).toEqual(['m2']);
    // 続きが日誌に載り、done が来る。
    api.messages.c1 = [
      ...(api.messages.c1 ?? []),
      { id: 'm3', at: 't', role: 'outbound', text: '続き' },
    ];
    hold.open();
    await vi.waitFor(() => expect(api.readMarks.map((m) => m.through)).toEqual(['m2', 'm3']));
  });
});

describe('/attach の上限はデーモンの値で先に検査する（#3204）', () => {
  const MIB = 1024 * 1024;
  const limitsOf = (over: Partial<AttachmentLimits>): AttachmentLimits => ({
    ...DEFAULT_ATTACHMENT_LIMITS,
    ...over,
  });

  it('上限を上げたデーモンでは、既定値を超えてデーモンの内側にある添付を断らず、そのまま上げて送る。取るのは1回', async () => {
    const dir = await makeTempDir('alteroid-tui-attach-');
    const path = join(dir, 'big.bin');
    await writeFile(path, Buffer.alloc(DEFAULT_ATTACHMENT_LIMITS.maxFileBytes + MIB));
    const { api, controller, texts } = setup();
    api.limits = limitsOf({ maxFileBytes: 200 * MIB, maxTotalBytes: 400 * MIB });
    await controller.attach(path);
    await controller.attach(path);
    expect(texts('system').join('\n')).not.toContain('添えられない');
    expect(api.limitsCalls).toBe(1);
    api.scripts.push([{ type: 'open', conversationId: 'c1' }, { type: 'done' }]);
    await controller.send('見て');
    expect(api.uploads).toHaveLength(2);
    expect(api.chatCalls[0]?.attachments).toHaveLength(2);
  });

  it('一時的な失敗（null）は覚えず、次の /attach で取り直してデーモンの値を使う', async () => {
    const dir = await makeTempDir('alteroid-tui-attach-');
    const path = join(dir, 'big.bin');
    await writeFile(path, Buffer.alloc(DEFAULT_ATTACHMENT_LIMITS.maxFileBytes + MIB));
    const { api, controller, texts } = setup();
    api.limits = null;
    await controller.attach(path);
    expect(texts('system').join('\n')).toContain('添えられない');
    api.limits = limitsOf({ maxFileBytes: 200 * MIB });
    await controller.attach(path);
    expect(controller.hasAttachments()).toBe(true);
    expect(api.limitsCalls).toBe(2);
    await controller.attach(path);
    expect(api.limitsCalls).toBe(2);
  });

  it('上限を下げたデーモンでは、既定値の内側でも先に断る', async () => {
    const dir = await makeTempDir('alteroid-tui-attach-');
    const path = join(dir, 'a.bin');
    await writeFile(path, Buffer.alloc(300));
    const { api, controller, texts } = setup();
    api.limits = limitsOf({ maxFileBytes: 200 });
    await controller.attach(path);
    expect(texts('system').join('\n')).toContain('添えられない');
    expect(controller.hasAttachments()).toBe(false);
  });

  it('口が取れず既定値が返るときは、既定を超えるものを断る', async () => {
    const dir = await makeTempDir('alteroid-tui-attach-');
    const path = join(dir, 'big.bin');
    await writeFile(path, Buffer.alloc(DEFAULT_ATTACHMENT_LIMITS.maxFileBytes + MIB));
    const { controller, texts } = setup();
    await controller.attach(path);
    expect(texts('system').join('\n')).toContain('添えられない');
  });
});
