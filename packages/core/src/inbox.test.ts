import { describe, expect, it } from 'vitest';

import { Inbox } from './inbox.js';
import type { InboxEvent } from './schema.js';

function humanMessage(text: string): InboxEvent {
  return {
    type: 'human_message',
    id: `evt-${text}`,
    at: new Date(0).toISOString(),
    text,
    conversationId: 'c1',
  };
}

describe('Inbox', () => {
  it('積まれた順に取り出せる', async () => {
    const inbox = new Inbox();
    inbox.push(humanMessage('a'));
    inbox.push(humanMessage('b'));

    expect((await inbox.next())?.id).toBe('evt-a');
    expect((await inbox.next())?.id).toBe('evt-b');
  });

  it('空のときは push されるまで待つ（イベント駆動）', async () => {
    const inbox = new Inbox();
    const pending = inbox.next();
    inbox.push(humanMessage('later'));

    expect((await pending)?.id).toBe('evt-later');
  });

  it('close すると待機中の取り出しが null で解ける', async () => {
    const inbox = new Inbox();
    const pending = inbox.next();
    inbox.close();

    expect(await pending).toBeNull();
    expect(inbox.closed).toBe(true);
  });

  it('close 後も残っているイベントは取り出せる', async () => {
    const inbox = new Inbox();
    inbox.push(humanMessage('a'));
    inbox.close();

    expect((await inbox.next())?.id).toBe('evt-a');
    expect(await inbox.next()).toBeNull();
  });

  it('for await で回せる', async () => {
    const inbox = new Inbox();
    inbox.push(humanMessage('a'));
    inbox.push(humanMessage('b'));
    inbox.close();

    const seen: string[] = [];
    for await (const event of inbox) seen.push(event.id);

    expect(seen).toEqual(['evt-a', 'evt-b']);
  });

  it('まだ読まれていないイベントを覗ける（同じ合図の重複判定に使う）', async () => {
    const inbox = new Inbox();
    inbox.push(humanMessage('a'));

    expect(inbox.hasPending((event) => event.type === 'human_message')).toBe(true);
    expect(inbox.hasPending((event) => event.type === 'timer')).toBe(false);

    // 取り出したものは「処理中」であって、もう待ち行列には居ない
    await inbox.next();
    expect(inbox.hasPending(() => true)).toBe(false);
  });

  it('起点の種類を問わず同じ口から入る（4つの起点が同じ受信箱を通る）', async () => {
    const inbox = new Inbox();
    inbox.push({ type: 'timer', id: 'evt-timer', at: new Date(0).toISOString(), kind: 'daily' });
    inbox.push({
      type: 'self_initiative',
      id: 'evt-self',
      at: new Date(0).toISOString(),
      reason: '目的から次の一手を決める',
    });
    inbox.close();

    const types = [];
    for await (const event of inbox) types.push(event.type);

    expect(types).toEqual(['timer', 'self_initiative']);
  });
});
