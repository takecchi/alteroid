import { describe, expect, it } from 'vitest';

import { commitmentFor } from './clone.js';
import type { InboxEvent } from './schema.js';

const ref = (id: string, name: string) => ({
  id,
  name,
  mediaType: 'text/plain',
  size: 1,
  sha256: 'a'.repeat(64),
});

const human = (text: string, attachments?: ReturnType<typeof ref>[]): InboxEvent => ({
  type: 'human_message',
  id: 'evt-h',
  at: '2026-10-07T00:00:00.000Z',
  text,
  conversationId: 'conv-1',
  ...(attachments === undefined ? {} : { attachments }),
});

const external = (payload: unknown, attachments?: ReturnType<typeof ref>[]): InboxEvent => ({
  type: 'external',
  id: 'evt-e',
  at: '2026-10-07T00:00:00.000Z',
  source: 'ci.main',
  payload,
  ...(attachments === undefined ? {} : { attachments }),
});

describe('台帳の body に添付の控えを出す（#4029）', () => {
  it('添付だけの人間の発言は、body が空にならず添付の名前が入る', () => {
    expect(commitmentFor(human('', [ref('a1', 'shot.png')]))?.body).toBe('［添付 1件: shot.png］');
  });

  it('本文と添付の両方がある人間の発言は、本文の後ろに添付の名前が付く', () => {
    expect(
      commitmentFor(human('これを見て', [ref('a1', 'shot.png'), ref('a2', 'run.log')]))?.body,
    ).toBe('これを見て［添付 2件: shot.png、run.log］');
  });

  it('添付が多いときは先頭の3件の名前だけを出し、残りは件数にする', () => {
    const many = ['a', 'b', 'c', 'd', 'e'].map((n) => ref(n, `${n}.txt`));
    expect(commitmentFor(human('', many))?.body).toBe(
      '［添付 5件: a.txt、b.txt、c.txt、ほか 2 件］',
    );
  });

  it('添付の無い人間の発言の body は変わらない', () => {
    expect(commitmentFor(human('やって'))?.body).toBe('やって');
  });

  it('中身が空で添付だけの外部イベントは、「中身のない通知」と言わず添付が届いたと言う', () => {
    for (const payload of [undefined, null, '']) {
      expect(commitmentFor(external(payload, [ref('a1', 'run.log')]))?.body).toBe(
        '（本文なし。添付だけが届いた）',
      );
    }
  });

  it('中身も添付も無い外部イベントは、今までどおり「中身のない通知」', () => {
    expect(commitmentFor(external(''))?.body).toBe('（中身のない通知。source だけが届いた。）');
  });
});
