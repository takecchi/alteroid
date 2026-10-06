import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { makeTempDir } from '../../../../vitest.tmpdir.js';

import { AttachmentMissingError } from '../attachments.js';
import { NotDeliveredError, type ConversationMessage } from './api.js';
import { ChatController, EDIT_EMPTY_MESSAGE } from './chat-controller.js';
import { resolveCommand } from './commands.js';
import { fakeApi, gate } from './fake-api.js';

// #3681: TUI の /edit。readline の CLI（#3691）と同じ「添えかけ」の流れ。
// 番号は、いま開いている会話の編集できる発言（人間の発言で、まだ畳まれていないもの）の並び。
// 実時間の待ちは書かない（gate と await だけで進める）。

const open = (conversationId: string) => ({ type: 'open' as const, conversationId });

const ORIGINAL = { id: 'a1', name: 'a.log', mediaType: 'text/plain', size: 3 };

const MESSAGES: ConversationMessage[] = [
  {
    id: 'm1',
    at: '2026-10-01T00:00:00Z',
    role: 'inbound',
    text: 'もとの本文',
    attachments: [ORIGINAL],
  },
  { id: 'm2', at: '2026-10-01T00:00:01Z', role: 'outbound', text: 'こたえ' },
  {
    id: 'm3',
    at: '2026-10-01T00:00:02Z',
    role: 'inbound',
    text: 'ふるい版',
    supersededBy: 'm4',
  },
  {
    id: 'm4',
    at: '2026-10-01T00:00:03Z',
    role: 'inbound',
    text: 'あたらしい版',
    supersedes: 'm3',
  },
  { id: 'm5', at: '2026-10-01T00:00:04Z', role: 'inbound', text: '/slash で始まる文' },
];

async function setup() {
  const api = fakeApi();
  api.messages.c1 = MESSAGES;
  const controller = new ChatController(api);
  const state = () => controller.store.getSnapshot();
  const texts = (kind?: string) =>
    state()
      .entries.filter((e) => kind === undefined || e.kind === kind)
      .map((e) => e.text);
  expect(await controller.openConversation('c1')).toBe(true);
  return { api, controller, state, texts };
}

async function tempFile(name: string): Promise<string> {
  const dir = await makeTempDir('alteroid-tui-edit-');
  const path = join(dir, name);
  await writeFile(path, 'log');
  return path;
}

describe('TUI /edit: 始める', () => {
  it('引数なしは、編集できる発言だけに番号を振った一覧を出す（クローンの返答・畳まれた版は除く）', async () => {
    const { controller, texts } = await setup();
    expect(await controller.edit('')).toBeNull();
    const listing = texts('system').at(-1) ?? '';
    expect(listing).toContain('[1] もとの本文（添付 1 件）');
    expect(listing).toContain('[2] あたらしい版');
    expect(listing).toContain('[3] /slash で始まる文');
    expect(listing).not.toContain('こたえ');
    expect(listing).not.toContain('ふるい版');
  });

  it('番号で始めると、元の本文と添付が出て、元の添付が上げ直さずに添えかけへ載る。本文は入力欄用に返る', async () => {
    const { api, controller, texts } = await setup();
    await controller.edit('');
    expect(await controller.edit('1')).toBe('もとの本文');
    const started = texts('system').at(-1) ?? '';
    expect(started).toContain('元の本文: もとの本文');
    expect(started).toContain('[添付] a.log (text/plain, 3 B) id=a1');
    expect(controller.hasAttachments()).toBe(true);
    expect(controller.isEditing()).toBe(true);
    controller.listAttachments();
    expect(texts('system').at(-1)).toContain('上げ済み id=a1');
    expect(texts('system').at(-1)).toContain('（元の添付）');
    expect(api.uploads).toEqual([]);
    expect(api.chatCalls).toEqual([]);
  });

  it('id でも始められる（一覧を先に出さなくてよい）', async () => {
    const { controller } = await setup();
    expect(await controller.edit('m4')).toBe('あたらしい版');
    expect(controller.isEditing()).toBe(true);
  });

  it('番号は、一覧を見せる前には引かない（一覧を出して、もう一度と案内する）', async () => {
    const { controller, texts } = await setup();
    expect(await controller.edit('1')).toBeNull();
    expect(controller.isEditing()).toBe(false);
    expect(texts('system').join('\n')).toContain('もう一度 /edit 1');
  });

  it('指せない発言（クローンの返答・畳まれた版・一覧に無い番号・開いていない会話）は始めない', async () => {
    const { controller, texts } = await setup();
    await controller.edit('');
    expect(await controller.edit('m2')).toBeNull();
    expect(texts('system').at(-1)).toContain('クローンの返答');
    expect(await controller.edit('m3')).toBeNull();
    expect(texts('system').at(-1)).toContain('もう別の編集に置き換えられている');
    expect(await controller.edit('9')).toBeNull();
    expect(texts('system').at(-1)).toContain('編集できる発言にない');
    expect(controller.isEditing()).toBe(false);

    const fresh = new ChatController(fakeApi());
    expect(await fresh.edit('1')).toBeNull();
    expect(fresh.store.getSnapshot().entries.at(-1)?.text).toContain(
      '編集できる会話が開いていない',
    );
  });

  it('1 行の形（/edit <番号> <本文>）は用意しない。使い方を出して始めない', async () => {
    const { api, controller, texts } = await setup();
    expect(await controller.edit('1 直した本文')).toBeNull();
    expect(texts('system').at(-1)).toContain('使い方');
    expect(controller.isEditing()).toBe(false);
    expect(api.chatCalls).toEqual([]);
  });

  it('編集の途中の別の /edit は断る（元の編集は続く）。添えかけが残っていれば始めない', async () => {
    const { controller, texts } = await setup();
    await controller.edit('');
    await controller.edit('1');
    expect(await controller.edit('m4')).toBeNull();
    expect(texts('system').at(-1)).toContain('編集の途中');
    expect(controller.isEditing()).toBe(true);
    // 途中でも一覧は見られる
    expect(await controller.edit('')).toBeNull();
    expect(texts('system').at(-1)).toContain('編集できる発言');
    controller.cancelEdit();

    const path = await tempFile('b.log');
    await controller.attach(path);
    expect(await controller.edit('m4')).toBeNull();
    expect(texts('system').at(-1)).toContain('添えかけのファイルが残っている');
    expect(controller.isEditing()).toBe(false);
  });

  it('/ で始まる本文は // にして返す（Enter でコマンドとして読まれず、送るとき元に戻る）', async () => {
    const { controller } = await setup();
    const prefill = await controller.edit('m5');
    expect(prefill).toBe('//slash で始まる文');
    const resolved = resolveCommand(prefill ?? '');
    expect(resolved).toEqual({ kind: 'text', text: '/slash で始まる文' });
  });
});

describe('TUI /edit: 確定', () => {
  it('元の添付を付けたまま、supersedes 付きで、編集する発言の会話へ送る（上げ直さない）', async () => {
    const { api, controller, texts } = await setup();
    await controller.edit('');
    await controller.edit('1');
    api.scripts.push([open('c1'), { type: 'done' }]);
    expect(await controller.send('直した本文')).toBe(true);
    expect(api.chatCalls).toEqual([
      { text: '直した本文', conversationId: 'c1', attachments: ['a1'], supersedes: 'm1' },
    ]);
    expect(api.uploads).toEqual([]);
    expect(texts('user').at(-1)).toContain('（編集）');
    expect(controller.isEditing()).toBe(false);
    expect(controller.hasAttachments()).toBe(false);
    // 編集が終わったら、次の発言は普通の発言（supersedes も添付も付かない）
    api.scripts.push([open('c1'), { type: 'done' }]);
    await controller.send('次');
    expect(api.chatCalls[1]).toEqual({ text: '次', conversationId: 'c1' });
  });

  it('/detach で外した添付は送られない', async () => {
    const { api, controller } = await setup();
    await controller.edit('');
    await controller.edit('1');
    controller.detach('1');
    expect(controller.hasAttachments()).toBe(false);
    api.scripts.push([open('c1'), { type: 'done' }]);
    await controller.send('添付なしで直す');
    expect(api.chatCalls).toEqual([
      { text: '添付なしで直す', conversationId: 'c1', supersedes: 'm1' },
    ]);
  });

  it('本文を空にして、添付だけで確定できる', async () => {
    const { api, controller } = await setup();
    await controller.edit('');
    await controller.edit('1');
    api.scripts.push([open('c1'), { type: 'done' }]);
    expect(await controller.send('')).toBe(true);
    expect(api.chatCalls).toEqual([
      { text: '', conversationId: 'c1', attachments: ['a1'], supersedes: 'm1' },
    ]);
  });

  it('添付も本文も無ければ送らない。理由を出し、編集は続く', async () => {
    const { api, controller, texts } = await setup();
    await controller.edit('');
    await controller.edit('1');
    controller.detach('all');
    expect(await controller.send('')).toBe(true);
    expect(api.chatCalls).toEqual([]);
    expect(texts('system').at(-1)).toBe(EDIT_EMPTY_MESSAGE);
    expect(controller.isEditing()).toBe(true);
  });

  it('/attach で足した分は新しく上げて付く（元の添付の後ろ）', async () => {
    const { api, controller } = await setup();
    await controller.edit('');
    await controller.edit('1');
    await controller.attach(await tempFile('new.log'));
    api.scripts.push([open('c1'), { type: 'done' }]);
    await controller.send('足した');
    expect(api.uploads.map((u) => u.name)).toEqual(['new.log']);
    expect(api.chatCalls).toEqual([
      { text: '足した', conversationId: 'c1', attachments: ['a1', 'att-1'], supersedes: 'm1' },
    ]);
  });

  it('取り消しで何も送らない。添えかけも空になり、次の発言は普通の発言', async () => {
    const { api, controller, texts } = await setup();
    await controller.edit('');
    await controller.edit('1');
    controller.cancelEdit();
    expect(texts('system').at(-1)).toContain('編集をやめた');
    expect(api.chatCalls).toEqual([]);
    expect(controller.isEditing()).toBe(false);
    expect(controller.hasAttachments()).toBe(false);
    api.scripts.push([open('c1'), { type: 'done' }]);
    await controller.send('ふつうの発言');
    expect(api.chatCalls).toEqual([{ text: 'ふつうの発言', conversationId: 'c1' }]);
    controller.cancelEdit();
    expect(texts('system').at(-1)).toBe('編集は始めていない');
  });

  it('元の添付が期限切れなら、/detach で外して送るか取り消すかを案内する。編集は続き、外せば送れる', async () => {
    const { api, controller, texts } = await setup();
    await controller.edit('');
    await controller.edit('1');
    api.scripts.push([new AttachmentMissingError('添付が見つからない（期限切れの可能性）: a1')]);
    expect(await controller.send('直す')).toBe(false); // 呼び手が文を入力欄へ戻す
    const notice = texts('error').at(-1) ?? '';
    expect(notice).toContain('元の添付が期限切れだったので送っていない（a.log）');
    expect(notice).toContain('/detach で外して送るか、/edit-cancel で編集をやめる');
    expect(controller.isEditing()).toBe(true);
    expect(controller.hasAttachments()).toBe(true); // 上げ直せないので印は捨てない
    controller.detach('1');
    api.scripts.push([open('c1'), { type: 'done' }]);
    expect(await controller.send('直す')).toBe(true);
    expect(api.chatCalls.at(-1)).toEqual({ text: '直す', conversationId: 'c1', supersedes: 'm1' });
    expect(controller.isEditing()).toBe(false);
  });

  it('受け取られなかった送信（繋がらない）では編集が続き、添えかけも戻る', async () => {
    const { api, controller } = await setup();
    await controller.edit('');
    await controller.edit('1');
    api.scripts.push([new Error('落ちた')]);
    await controller.send('直す');
    expect(controller.isEditing()).toBe(true);
    expect(controller.hasAttachments()).toBe(true);
    api.scripts.push([open('c1'), { type: 'done' }]);
    await controller.send('直す');
    expect(api.chatCalls.at(-1)).toEqual({
      text: '直す',
      conversationId: 'c1',
      attachments: ['a1'],
      supersedes: 'm1',
    });
  });

  it('会話を移ると編集は落ちる（元の添付が別の会話へ付かない）', async () => {
    const { api, controller, texts } = await setup();
    await controller.edit('');
    await controller.edit('1');
    expect(controller.newConversation()).toBe(true);
    expect(controller.isEditing()).toBe(false);
    expect(controller.hasAttachments()).toBe(false);
    expect(texts('system').at(-1)).toContain('編集をやめた');
    api.scripts.push([open('c9'), { type: 'done' }]);
    await controller.send('べつの会話');
    expect(api.chatCalls).toEqual([{ text: 'べつの会話' }]);
  });
});

describe('TUI /edit: 既存の送信の止めとの組み合わせ', () => {
  it('添付を上げている最中の2回目の確定は断る。編集は崩れず、上がった分で 1 回だけ送る', async () => {
    const { api, controller } = await setup();
    await controller.edit('');
    await controller.edit('1');
    await controller.attach(await tempFile('new.log'));
    const hold = gate();
    const realUpload = api.uploadAttachment.bind(api);
    api.uploadAttachment = async (file) => {
      await hold.wait;
      return realUpload(file);
    };
    api.scripts.push([open('c1'), { type: 'done' }]);
    const first = controller.send('確定');
    const second = controller.send('もう一度'); // 上げ待ち（uploading）のあいだ
    expect(await second).toBe(false);
    // 上げている最中は外せない・やめられない
    controller.detach('1');
    controller.cancelEdit();
    expect(controller.isEditing()).toBe(true);
    hold.open();
    expect(await first).toBe(true);
    expect(api.chatCalls).toEqual([
      { text: '確定', conversationId: 'c1', attachments: ['a1', 'att-1'], supersedes: 'm1' },
    ]);
    expect(controller.isEditing()).toBe(false);
  });

  it('応答中（送り中）の確定は追送になり、supersedes と元の添付が付く', async () => {
    const { api, controller } = await setup();
    const g = gate();
    api.scripts.push([g.wait, open('c1'), { type: 'done' }]);
    api.scripts.push([open('c1')]);
    const running = controller.send('走っているターン');
    await controller.edit('');
    expect(await controller.edit('1')).toBe('もとの本文');
    const follow = controller.send('追送で直す');
    g.open();
    expect(await follow).toBe(true);
    await running;
    expect(api.chatCalls[1]).toEqual({
      text: '追送で直す',
      conversationId: 'c1',
      attachments: ['a1'],
      supersedes: 'm1',
    });
    expect(controller.isEditing()).toBe(false);
    expect(controller.hasAttachments()).toBe(false);
  });

  it('追送が受け取られなかったら、編集と添えかけは残る', async () => {
    const { api, controller } = await setup();
    const g = gate();
    api.scripts.push([g.wait, open('c1'), { type: 'done' }]);
    api.scripts.push([new NotDeliveredError('送信できませんでした（HTTP 409）')]);
    const running = controller.send('走っているターン');
    await controller.edit('');
    await controller.edit('1');
    const follow = controller.send('追送で直す');
    g.open();
    expect(await follow).toBe(false);
    await running;
    expect(controller.isEditing()).toBe(true);
    expect(controller.hasAttachments()).toBe(true);
  });
});
