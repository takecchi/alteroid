import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { makeTempDir } from '../../../../vitest.tmpdir.js';

import { ChatController } from './chat-controller.js';
import { fakeApi } from './fake-api.js';

// 周回の数で待たない: 添えたファイルを読むのは実 I/O なので、混んだ runner では10周では上げ始めに届かない（#4342 の CI で揺れた。#3943 と同じ形）
const untilUploading = (signals: (AbortSignal | undefined)[]) =>
  vi.waitFor(() => {
    expect(signals.length).toBeGreaterThan(0);
  });

// 止まったデーモンの代わり: signal が abort されるまで返らない
function stallUntilAborted(api: ReturnType<typeof fakeApi>) {
  const signals: (AbortSignal | undefined)[] = [];
  let stalls = 1;
  const realUpload = api.uploadAttachment.bind(api);
  api.uploadAttachment = async (file, signal) => {
    signals.push(signal);
    if (stalls > 0 && signal !== undefined) {
      stalls -= 1;
      await new Promise<void>((_, reject) => {
        signal.addEventListener('abort', () => reject(new Error('This operation was aborted')));
      });
    }
    return realUpload(file, signal);
  };
  return signals;
}

describe('TUI: 添付を上げている最中の Ctrl-C で上げるのをやめる（#4056）', () => {
  it('上げる fetch が abort され、送らずに戻り、何も積まれない', async () => {
    const dir = await makeTempDir('alteroid-tui-upload-cancel-');
    const path = join(dir, 'a.log');
    await writeFile(path, 'log');
    const api = fakeApi();
    const controller = new ChatController(api);
    const signals = stallUntilAborted(api);
    await controller.attach(path);

    const sending = controller.send('添えて送る');
    await untilUploading(signals);
    expect(signals).toHaveLength(1);
    expect(signals[0]?.aborted).toBe(false);

    const result = await controller.interrupt();
    expect(result.ok).toBe(true);
    expect(signals[0]?.aborted).toBe(true);
    expect(await sending).toBe(false);
    expect(api.chatCalls).toEqual([]);
    expect(api.interrupts).toBe(0);
    const texts = controller.store.getSnapshot().entries.map((e) => `${e.kind}:${e.text}`);
    expect(texts).toContain(
      'system:添付を上げるのをやめた（何も送っていない。上がった分の印と添えかけは残してある）',
    );
    expect(texts.some((t) => t.startsWith('error:'))).toBe(false);
  });

  it('やめた後は「上げている最中」が解け、/detach・/attach・会話を移る操作が通る', async () => {
    const dir = await makeTempDir('alteroid-tui-upload-cancel-free-');
    const a = join(dir, 'a.log');
    const b = join(dir, 'b.log');
    await writeFile(a, 'a');
    await writeFile(b, 'b');
    const api = fakeApi();
    const controller = new ChatController(api);
    const signals = stallUntilAborted(api);
    await controller.attach(a);
    const sending = controller.send('x');
    await untilUploading(signals);
    await controller.interrupt();
    expect(await sending).toBe(false);

    await controller.attach(b);
    expect(controller.hasAttachments()).toBe(true);
    controller.detach('2');
    controller.detach('1');
    expect(controller.hasAttachments()).toBe(false);
    const entries = controller.store.getSnapshot().entries.map((e) => e.text);
    expect(entries.some((t) => t.includes('上げている最中'))).toBe(false);
    expect(controller.newConversation()).toBe(true);
  });

  it('添えかけは残り、もう一度送れば上げて送れる', async () => {
    const dir = await makeTempDir('alteroid-tui-upload-cancel-retry-');
    const path = join(dir, 'a.log');
    await writeFile(path, 'log');
    const api = fakeApi();
    const controller = new ChatController(api);
    const signals = stallUntilAborted(api);
    await controller.attach(path);
    const first = controller.send('一回目');
    await untilUploading(signals);
    await controller.interrupt();
    expect(await first).toBe(false);
    expect(controller.hasAttachments()).toBe(true);

    api.scripts.push([{ type: 'open', conversationId: 'c1' }, { type: 'done' }]);
    expect(await controller.send('二回目')).toBe(true);
    expect(api.uploads).toHaveLength(1);
    expect(api.chatCalls).toHaveLength(1);
    expect(api.chatCalls[0]).toMatchObject({ text: '二回目', attachments: ['att-1'] });
    expect(controller.hasAttachments()).toBe(false);
  });

  it('上げていないときの interrupt はデーモンへ届く', async () => {
    const api = fakeApi();
    const controller = new ChatController(api);
    await controller.interrupt();
    expect(api.interrupts).toBe(1);
  });
});
