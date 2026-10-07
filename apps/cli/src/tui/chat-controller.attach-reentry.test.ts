import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { makeTempDir } from '../../../../vitest.tmpdir.js';

import { ChatController } from './chat-controller.js';
import { fakeApi, gate } from './fake-api.js';

describe('TUI: 添付を上げている最中の2回目の送信', () => {
  const settle = async () => {
    for (let i = 0; i < 10; i += 1) await new Promise((r) => setTimeout(r, 0));
  };

  it('同じ添えかけを二重に上げず、二重に送らない', async () => {
    const dir = await makeTempDir('alteroid-tui-attach-reentry-');
    const path = join(dir, 'a.log');
    await writeFile(path, 'log');
    const api = fakeApi();
    const hold = gate();
    const realUpload = api.uploadAttachment.bind(api);
    api.uploadAttachment = async (file) => {
      await hold.wait;
      return realUpload(file);
    };
    const controller = new ChatController(api);
    await controller.attach(path);
    api.scripts.push(
      [{ type: 'open', conversationId: 'c1' }, { type: 'done' }],
      [{ type: 'open', conversationId: 'c2' }, { type: 'done' }],
    );
    const first = controller.send('一回目');
    await settle();
    const second = controller.send('二回目');
    await settle();
    hold.open();
    const results = await Promise.all([first, second]);
    expect(results).toEqual([true, false]);
    expect(
      controller.store.getSnapshot().entries.some((e) => e.text.includes('上げている最中')),
    ).toBe(true);
    const withAttachment = api.chatCalls.filter((c) => (c.attachments?.length ?? 0) > 0);
    expect({ uploads: api.uploads.length, sentWithAttachment: withAttachment.length }).toEqual({
      uploads: 1,
      sentWithAttachment: 1,
    });
  });
});

describe('TUI: 添付を上げている最中の /detach と /attach', () => {
  const settle = async () => {
    for (let i = 0; i < 10; i += 1) await new Promise((r) => setTimeout(r, 0));
  };

  async function twoFiles() {
    const dir = await makeTempDir('alteroid-tui-attach-reentry-');
    const a = join(dir, 'a.log');
    const b = join(dir, 'b.log');
    await writeFile(a, 'a');
    await writeFile(b, 'b');
    return { a, b };
  }

  function heldApi() {
    const api = fakeApi();
    const hold = gate();
    const realUpload = api.uploadAttachment.bind(api);
    api.uploadAttachment = async (file) => {
      await hold.wait;
      return realUpload(file);
    };
    return { api, hold };
  }

  it('上げ待ちの /detach は止める（理由を出す）。添えかけは崩れず、送ると決めた分が全部送られる（Web の uploading と同じ）', async () => {
    const { a, b } = await twoFiles();
    const { api, hold } = heldApi();
    const controller = new ChatController(api);
    await controller.attach(a);
    await controller.attach(b);
    api.scripts.push([{ type: 'open', conversationId: 'c1' }, { type: 'done' }]);
    const sending = controller.send('見て');
    await settle();
    controller.detach('1');
    expect(controller.store.getSnapshot().entries.at(-1)?.text).toContain('上げている最中');
    hold.open();
    await sending;
    expect(api.uploads.map((u) => u.name)).toEqual(['a.log', 'b.log']);
    expect(api.chatCalls[0]?.attachments).toHaveLength(2);
    expect(controller.hasAttachments()).toBe(false);
  });

  it('上げ待ちに /attach で足したファイルを、いま送る発言へ混ぜない（#3245 と同じ「あとから足した分は残す」）', async () => {
    const { a, b } = await twoFiles();
    const { api, hold } = heldApi();
    const controller = new ChatController(api);
    await controller.attach(a);
    api.scripts.push([{ type: 'open', conversationId: 'c1' }, { type: 'done' }]);
    const sending = controller.send('見て');
    await settle();
    await controller.attach(b);
    hold.open();
    await sending;
    expect(api.chatCalls[0]?.attachments).toHaveLength(1);
    expect(controller.hasAttachments()).toBe(true);
  });
});

describe('TUI: 添付を上げ終えて最初のイベントが届く前の2回目の送信', () => {
  it('同じ添えかけを、追送でもう一度送らない', async () => {
    const dir = await makeTempDir('alteroid-tui-audit5-');
    const path = join(dir, 'a.log');
    await writeFile(path, 'log');
    const api = fakeApi();
    const hold = gate();
    const started = gate();
    const realChat = api.chat.bind(api);
    api.chat = (input, signal) => {
      started.open();
      return realChat(input, signal);
    };
    const controller = new ChatController(api);
    await controller.attach(path);
    api.scripts.push(
      [hold.wait, { type: 'open', conversationId: 'c1' }, { type: 'done' }],
      [{ type: 'open', conversationId: 'c1' }],
    );
    const first = controller.send('一回目');
    await started.wait;
    const second = controller.send('二回目');
    hold.open();
    await Promise.all([first, second]);
    const withAttachment = api.chatCalls.filter((c) => (c.attachments?.length ?? 0) > 0);
    expect(withAttachment.map((c) => c.text)).toEqual(['一回目']);
  });
});

describe('TUI: 添付を上げられなかった送信は、送らなかった印を返す', () => {
  it('新しい会話の送信: 上げ失敗で false（打った文は入力欄へ戻る）', async () => {
    const dir = await makeTempDir('alteroid-tui-audit5-');
    const path = join(dir, 'a.log');
    await writeFile(path, 'log');
    const api = fakeApi();
    const controller = new ChatController(api);
    await controller.attach(path);
    api.uploadFails = '繋がらない';
    const sent = await controller.send('見て');
    expect(api.chatCalls).toEqual([]);
    expect(sent).toBe(false);
  });

  it('追送: 上げ失敗で false', async () => {
    const dir = await makeTempDir('alteroid-tui-audit5-');
    const path = join(dir, 'a.log');
    await writeFile(path, 'log');
    const api = fakeApi();
    const hold = gate();
    const controller = new ChatController(api);
    api.scripts.push([{ type: 'open', conversationId: 'c1' }, hold.wait, { type: 'done' }]);
    const first = controller.send('一回目');
    await controller.attach(path);
    api.uploadFails = '繋がらない';
    const sent = await controller.send('追送');
    hold.open();
    await first;
    expect(api.chatCalls.map((c) => c.text)).toEqual(['一回目']);
    expect(sent).toBe(false);
  });
});

describe('TUI: 追送の添付を上げている最中にターンが終わった', () => {
  it('追送は取り下げずに、通常の送信として送る（会話は始まっている）', async () => {
    const dir = await makeTempDir('alteroid-tui-audit5-');
    const path = join(dir, 'a.log');
    await writeFile(path, 'log');
    const api = fakeApi();
    const turn = gate();
    const upload = gate();
    const realUpload = api.uploadAttachment.bind(api);
    api.uploadAttachment = async (file) => {
      await upload.wait;
      return realUpload(file);
    };
    const controller = new ChatController(api);
    api.scripts.push(
      [{ type: 'open', conversationId: 'c1' }, turn.wait, { type: 'done' }],
      [{ type: 'open', conversationId: 'c1' }, { type: 'done' }],
    );
    const first = controller.send('一回目');
    await controller.attach(path);
    const follow = controller.send('追送');
    turn.open();
    await first;
    upload.open();
    const sent = await follow;
    expect(sent).toBe(true);
    expect(api.chatCalls.map((c) => [c.text, c.attachments?.length ?? 0])).toEqual([
      ['一回目', 0],
      ['追送', 1],
    ]);
  });

  it('上げている最中に /attach で足した添付は、いまの発言に混ぜず、次の発言のために残す', async () => {
    const dir = await makeTempDir('alteroid-tui-audit6-');
    const pathA = join(dir, 'a.log');
    const pathB = join(dir, 'b.log');
    await writeFile(pathA, 'log-a');
    await writeFile(pathB, 'log-b');
    const api = fakeApi();
    const turn = gate();
    const upload = gate();
    const realUpload = api.uploadAttachment.bind(api);
    api.uploadAttachment = async (file) => {
      await upload.wait;
      return realUpload(file);
    };
    const controller = new ChatController(api);
    api.scripts.push(
      [{ type: 'open', conversationId: 'c1' }, turn.wait, { type: 'done' }],
      [{ type: 'open', conversationId: 'c1' }, { type: 'done' }],
    );
    const first = controller.send('一回目');
    await controller.attach(pathA);
    const follow = controller.send('追送');
    await controller.attach(pathB);
    turn.open();
    await first;
    upload.open();
    await follow;
    expect(api.chatCalls.map((c) => [c.text, c.attachments?.length ?? 0])).toEqual([
      ['一回目', 0],
      ['追送', 1],
    ]);
    expect(controller.hasAttachments()).toBe(true);
  });
});
