import { describe, expect, it } from 'vitest';

import { createUnreadableRowOnce, unreadableRowKey } from './unreadable-row-once.js';

describe('createUnreadableRowOnce (issue #2191)', () => {
  it('同じ鍵は1回目だけ true、2回目以降は false', () => {
    const tracker = createUnreadableRowOnce();
    expect(tracker.sawUnreadable('id:a')).toBe(true);
    expect(tracker.sawUnreadable('id:a')).toBe(false);
    expect(tracker.sawUnreadable('id:a')).toBe(false);
  });

  it('sawReadable で戻すと、次の sawUnreadable がまた true になる', () => {
    const tracker = createUnreadableRowOnce();
    expect(tracker.sawUnreadable('id:a')).toBe(true);
    tracker.sawReadable('id:a');
    expect(tracker.sawUnreadable('id:a')).toBe(true);
    expect(tracker.sawUnreadable('id:a')).toBe(false);
  });

  it('まだ知らせていない鍵に sawReadable を呼んでも何も起きない（冪等）', () => {
    const tracker = createUnreadableRowOnce();
    tracker.sawReadable('id:never-notified');
    expect(tracker.sawUnreadable('id:never-notified')).toBe(true);
  });

  it('鍵が違えば独立に数える', () => {
    const tracker = createUnreadableRowOnce();
    expect(tracker.sawUnreadable('id:a')).toBe(true);
    expect(tracker.sawUnreadable('id:b')).toBe(true);
    expect(tracker.sawUnreadable('id:a')).toBe(false);
    expect(tracker.sawUnreadable('id:b')).toBe(false);
  });

  it('作り直すと（＝別インスタンス）、以前の知らせ済みは引き継がない', () => {
    const first = createUnreadableRowOnce();
    expect(first.sawUnreadable('id:a')).toBe(true);

    const second = createUnreadableRowOnce();
    expect(second.sawUnreadable('id:a')).toBe(true);
  });
});

describe('unreadableRowKey (issue #2191)', () => {
  it('id が取れれば `id:<id>` を鍵にする', () => {
    expect(unreadableRowKey('grant-1', { anything: 'ignored' })).toBe('id:grant-1');
  });

  it('id が無ければ、内容の指紋（fingerprint:）を鍵にする', () => {
    const key = unreadableRowKey(undefined, { rule: 'x', allows: [] });
    expect(key.startsWith('fingerprint:')).toBe(true);
  });

  it('id が無いとき、同じ内容は同じ鍵、違う内容は違う鍵になる', () => {
    const keyA1 = unreadableRowKey(undefined, { rule: 'a' });
    const keyA2 = unreadableRowKey(undefined, { rule: 'a' });
    const keyB = unreadableRowKey(undefined, { rule: 'b' });
    expect(keyA1).toBe(keyA2);
    expect(keyA1).not.toBe(keyB);
  });

  it('id 名前空間（id:）と指紋の名前空間（fingerprint:）は衝突しない', () => {
    // 万一 sha256 の先頭16桁がたまたま id と同じ文字列になっても、接頭辞が
    // 違うので同じ鍵にはならない。
    const idKey = unreadableRowKey('deadbeefdeadbeef', {});
    const fingerprintKey = unreadableRowKey(undefined, {});
    expect(idKey).not.toBe(fingerprintKey);
  });

  it('本文（値そのもの）は鍵の文字列に出ない', () => {
    const key = unreadableRowKey(undefined, {
      allows: ['この文字列は鍵に出てはいけない'],
      denies: ['これも出てはいけない'],
    });
    expect(key).not.toContain('この文字列は鍵に出てはいけない');
    expect(key).not.toContain('これも出てはいけない');
  });
});
