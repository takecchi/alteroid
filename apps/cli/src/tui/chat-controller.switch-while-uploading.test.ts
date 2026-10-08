import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { makeTempDir } from '../../../../vitest.tmpdir.js';

import { ChatController } from './chat-controller.js';
import { fakeApi, gate } from './fake-api.js';

describe('TUI: 添付を上げている最中に会話を移る（#4055）', () => {
  const settle = async () => {
    for (let i = 0; i < 10; i += 1) await new Promise((r) => setTimeout(r, 0));
  };

  it('/new・会話を開く・続きを開く・/end は断られ、発言は元の会話へ送られる', async () => {
    const dir = await makeTempDir('alteroid-tui-switch-uploading-');
    const path = join(dir, 'a.log');
    await writeFile(path, 'log');
    const api = fakeApi();
    const controller = new ChatController(api);
    api.scripts.push([{ type: 'open', conversationId: 'c1' }, { type: 'done' }]);
    expect(await controller.send('一回目')).toBe(true);

    const hold = gate();
    const realUpload = api.uploadAttachment.bind(api);
    api.uploadAttachment = async (file) => {
      await hold.wait;
      return realUpload(file);
    };
    await controller.attach(path);
    api.scripts.push([{ type: 'open', conversationId: 'c1' }, { type: 'done' }]);
    const sending = controller.send('c1 へ');
    await settle();

    expect(controller.newConversation()).toBe(false);
    expect(await controller.openConversation('c9')).toBe(false);
    expect(await controller.resumeConversation('c9')).toBe(false);
    await controller.endConversation();
    expect(api.ended).toEqual([]);
    expect(
      controller.store
        .getSnapshot()
        .entries.filter((e) => e.text.includes('添付を上げている最中は会話を移れない')).length,
    ).toBe(4);

    hold.open();
    expect(await sending).toBe(true);
    expect(api.chatCalls.at(-1)).toMatchObject({ text: 'c1 へ', conversationId: 'c1' });
    expect(controller.newConversation()).toBe(true);
  });
});
