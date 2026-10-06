import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { makeTempDir } from '../../../../vitest.tmpdir.js';

import { ChatController } from './chat-controller.js';
import { fakeApi, gate } from './fake-api.js';

// 監査 (#3111 系統): TUI の送信は、添付を上げているあいだ busy を立てない。
// 上げ終わる前にもう一度 Enter（または別の文）を送ると、同じ添えかけが二重に上がり、二重に送られる。
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
    const second = controller.send('二回目'); // 上げ待ちのあいだにもう一度 Enter
    await settle();
    hold.open();
    const results = await Promise.all([first, second]);
    // 2回目は送らなかった印（false。入力欄へ戻る）で、止めたことを使い手へ知らせる。
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

// 上げている最中の /detach・/attach は、走査中の添えかけ（生きた配列）を直接変える。
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
    controller.detach('1'); // 上げている最中なので外せない
    expect(controller.store.getSnapshot().entries.at(-1)?.text).toContain('上げている最中');
    hold.open();
    await sending;
    // 外せていないので、a・b とも上がって送られる（外したのに送られる、残したのに飛ばされる、が起きない）。
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
