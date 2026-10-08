import { describe, expect, it } from 'vitest';

import { humanConversationHeader } from './clone.js';
import { lastSessionCall, setup, waitForDone, wireEvents } from './clone-test-harness.js';
import { humanMessage } from './testing.js';

describe('人間の発言のターンは、どの会話の発言かを名乗る（#4210）', () => {
  it('同じ会話が続く回と、再起動直後の最初の回は、会話 id の1行だけ', () => {
    expect(humanConversationHeader('conv-hoge', null)).toBe('[system] 会話 conv-hoge');
    expect(humanConversationHeader('conv-hoge', 'conv-hoge')).toBe('[system] 会話 conv-hoge');
  });

  it('会話が切り替わった回は、直前の会話と、別の件の書き先を添える', () => {
    const header = humanConversationHeader('conv-fuga', 'conv-hoge');
    expect(header.startsWith('[system] 会話 conv-fuga')).toBe(true);
    expect(header).toContain('直前の人間の発言は別の会話 conv-hoge だった');
    expect(header).toContain('`conversation_post`');
  });

  it('クローンのターンの入力: 名乗りは本文の前に置かれ、切り替わった回だけ切り替わりを言う', async () => {
    const s = setup();
    const hoge = wireEvents(s.clone, 'conv-hoge');
    const fuga = wireEvents(s.clone, 'conv-fuga');

    s.clone.post(humanMessage('Hoge を調べて', 'conv-hoge'));
    await waitForDone(hoge.events);
    s.clone.post(humanMessage('Fuga の相談', 'conv-fuga'));
    await waitForDone(fuga.events);
    fuga.events.length = 0;
    s.clone.post(humanMessage('Fuga の続き', 'conv-fuga'));
    await waitForDone(fuga.events);

    const inputs = lastSessionCall(s.calls).inputs;
    const inputOf = (body: string) => inputs.find((input) => input.includes(body)) ?? '';

    const first = inputOf('Hoge を調べて');
    expect(first).toContain('[system] 会話 conv-hoge\n\nHoge を調べて');
    expect(first).not.toContain('直前の人間の発言');

    const switched = inputOf('Fuga の相談');
    expect(switched).toContain('[system] 会話 conv-fuga（直前の人間の発言は別の会話 conv-hoge だった');
    // 本文は末尾で探す: 前置きの断り書き（台帳の未了の一覧など）にも同じ文が引かれるため
    expect(switched.endsWith('書くこと）\n\nFuga の相談')).toBe(true);

    const same = inputOf('Fuga の続き');
    expect(same).toContain('[system] 会話 conv-fuga\n\nFuga の続き');
    expect(same).not.toContain('直前の人間の発言');
    await s.clone.stop();
  });
});
