import { describe, expect, it, vi } from 'vitest';

import { CloneDelivery } from './clone-delivery.js';
import { Inbox } from './inbox.js';
import { CloneRedeliveryState } from './clone-redelivery-state.js';
import type { InboxEvent } from './schema.js';
import { humanMessage } from './testing.js';

/**
 * `clone-delivery.ts` の歯。**純粋なクラスなので I/O のモック無しで全分岐に
 * 通せる**（`clone-redelivery-state.test.ts` と同じ作法。前例は PR #1359 /
 * #1433 / #1507 / #1523 / #1611 / #1613 / #1614——このクラス自身の doc
 * 「なぜ切り出したか」が同じ並びに挙げている）。
 *
 * `Clone` 側の配線（`#pump` / `#handle` / `#restoreUnread*` / `post()` が
 * 実際にこのクラスのメソッドを呼ぶ順序）までは測らない——それは
 * `clone.test.ts` がブラックボックスで持つ。ここが固定するのは、切り出した
 * 11フィールドの**器としての性質**だけである。
 */

describe('CloneDelivery — inbox / redeliveryState はフィールドとして1本持つだけ', () => {
  it('inbox は Inbox のインスタンスで、中身には触っていない（空で始まる）', () => {
    const delivery = new CloneDelivery();
    expect(delivery.inbox).toBeInstanceOf(Inbox);
    expect(delivery.inbox.size).toBe(0);
    expect(delivery.inbox.closed).toBe(false);
  });

  it('redeliveryState は CloneRedeliveryState のインスタンス', () => {
    const delivery = new CloneDelivery();
    expect(delivery.redeliveryState).toBeInstanceOf(CloneRedeliveryState);
  });
});

describe('CloneDelivery — subscribeListener/unsubscribeListener/dropListenersIfEmpty/listenersFor', () => {
  it('subscribeListener で登録した listener を listenersFor が返す', () => {
    const delivery = new CloneDelivery();
    const listener = vi.fn();
    delivery.subscribeListener('conv-1', listener);
    expect([...delivery.listenersFor('conv-1')]).toEqual([listener]);
  });

  it('購読していない conversationId は listenersFor が空を返す', () => {
    const delivery = new CloneDelivery();
    expect([...delivery.listenersFor('conv-none')]).toEqual([]);
  });

  it('同じ conversationId に2件 subscribe すると、同じ Set にまとまる', () => {
    const delivery = new CloneDelivery();
    const a = vi.fn();
    const b = vi.fn();
    const setA = delivery.subscribeListener('conv-1', a);
    const setB = delivery.subscribeListener('conv-1', b);
    expect(setA).toBe(setB);
    expect([...delivery.listenersFor('conv-1')]).toEqual([a, b]);
  });

  it('unsubscribeListener はその listener だけを外し、Set が空になれば conversationId ごと消す', () => {
    const delivery = new CloneDelivery();
    const listener = vi.fn();
    const set = delivery.subscribeListener('conv-1', listener);
    delivery.unsubscribeListener('conv-1', listener, set);
    expect([...delivery.listenersFor('conv-1')]).toEqual([]);
  });

  it('unsubscribeListener は「同じ Set」でなければ、空でも conversationId を消さない（同一性チェック）', () => {
    const delivery = new CloneDelivery();
    const first = vi.fn();
    const firstSet = delivery.subscribeListener('conv-1', first);
    // 呼び出し元の閉包が古い `set` を握ったまま、外から解除される
    delivery.unsubscribeListener('conv-1', first, firstSet);
    // 新しい購読が同じ conversationId に来る（新しい Set が作られる）
    const second = vi.fn();
    delivery.subscribeListener('conv-1', second);
    // 古い set への「解除」をもう一度呼んでも、新しい Set には影響しない
    delivery.unsubscribeListener('conv-1', first, firstSet);
    expect([...delivery.listenersFor('conv-1')]).toEqual([second]);
  });

  it('dropListenersIfEmpty は、Set が存在してかつ空のときだけ conversationId を消す', () => {
    const delivery = new CloneDelivery();
    const listener = vi.fn();
    const set = delivery.subscribeListener('conv-1', listener);
    set.delete(listener); // 直接空にする（`unsubscribeListener` を経由しない）
    delivery.dropListenersIfEmpty('conv-1');
    expect([...delivery.listenersFor('conv-1')]).toEqual([]);
  });

  it('dropListenersIfEmpty は、Set が空でなければ何もしない', () => {
    const delivery = new CloneDelivery();
    const listener = vi.fn();
    delivery.subscribeListener('conv-1', listener);
    delivery.dropListenersIfEmpty('conv-1');
    expect([...delivery.listenersFor('conv-1')]).toEqual([listener]);
  });

  it('dropListenersIfEmpty は、購読が無い conversationId を渡しても例外にならない', () => {
    const delivery = new CloneDelivery();
    expect(() => delivery.dropListenersIfEmpty('conv-none')).not.toThrow();
  });
});

describe('CloneDelivery — registerCompletion/settleAllCompletions/takeCompletion', () => {
  it('takeCompletion は登録した resolve をそのまま返し、消費する読みとして消す', () => {
    const delivery = new CloneDelivery();
    const resolve = vi.fn();
    delivery.registerCompletion('evt-1', resolve);
    const taken = delivery.takeCompletion('evt-1');
    expect(taken).toBe(resolve);
    expect(delivery.takeCompletion('evt-1')).toBeUndefined();
  });

  it('登録していない id を takeCompletion しても undefined で、例外にならない', () => {
    const delivery = new CloneDelivery();
    expect(delivery.takeCompletion('never')).toBeUndefined();
  });

  it('settleAllCompletions は控えていた全部の resolve を呼んで、まとめて捨てる', () => {
    const delivery = new CloneDelivery();
    const a = vi.fn();
    const b = vi.fn();
    delivery.registerCompletion('evt-a', a);
    delivery.registerCompletion('evt-b', b);
    delivery.settleAllCompletions();
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    expect(delivery.takeCompletion('evt-a')).toBeUndefined();
    expect(delivery.takeCompletion('evt-b')).toBeUndefined();
  });
});

describe('CloneDelivery — pushDeferred/drainDeferred/removeDeferredWhere/removeDeferredById/someDeferred/matchingDeferredCount/deferredCount', () => {
  it('pushDeferred で積んだ順に deferredCount が増える', () => {
    const delivery = new CloneDelivery();
    expect(delivery.deferredCount).toBe(0);
    delivery.pushDeferred(humanMessage('a'));
    delivery.pushDeferred(humanMessage('b'));
    expect(delivery.deferredCount).toBe(2);
  });

  it('drainDeferred は積んだ順のまま全部取り出し、空にする', () => {
    const delivery = new CloneDelivery();
    const a = humanMessage('a');
    const b = humanMessage('b');
    delivery.pushDeferred(a);
    delivery.pushDeferred(b);
    expect(delivery.drainDeferred()).toEqual([a, b]);
    expect(delivery.deferredCount).toBe(0);
    expect(delivery.drainDeferred()).toEqual([]);
  });

  it('removeDeferredWhere は該当分を到着順で返し、該当しない分は残す', () => {
    const delivery = new CloneDelivery();
    const a = humanMessage('a', 'conv-x');
    const b = humanMessage('b', 'conv-y');
    const c = humanMessage('c', 'conv-x');
    delivery.pushDeferred(a);
    delivery.pushDeferred(b);
    delivery.pushDeferred(c);
    const removed = delivery.removeDeferredWhere((event) => event.id === a.id || event.id === c.id);
    expect(removed).toEqual([a, c]);
    expect(delivery.deferredCount).toBe(1);
    expect(delivery.drainDeferred()).toEqual([b]);
  });

  it('removeDeferredWhere は何も一致しなければ空配列を返し、中身を変えない', () => {
    const delivery = new CloneDelivery();
    const a = humanMessage('a');
    delivery.pushDeferred(a);
    expect(delivery.removeDeferredWhere(() => false)).toEqual([]);
    expect(delivery.deferredCount).toBe(1);
  });

  it('removeDeferredById は id が一致する1件だけを取り除いて返す', () => {
    const delivery = new CloneDelivery();
    const a = humanMessage('a');
    const b = humanMessage('b');
    delivery.pushDeferred(a);
    delivery.pushDeferred(b);
    expect(delivery.removeDeferredById(b.id)).toBe(b);
    expect(delivery.deferredCount).toBe(1);
    expect(delivery.drainDeferred()).toEqual([a]);
  });

  it('removeDeferredById は見つからなければ undefined を返す（null ではない）', () => {
    const delivery = new CloneDelivery();
    expect(delivery.removeDeferredById('never')).toBeUndefined();
  });

  it('someDeferred / matchingDeferredCount は述語に一致する分だけ数える', () => {
    const delivery = new CloneDelivery();
    const a = humanMessage('a', 'conv-x');
    const b = humanMessage('b', 'conv-y');
    const c = humanMessage('c', 'conv-x');
    delivery.pushDeferred(a);
    delivery.pushDeferred(b);
    delivery.pushDeferred(c);
    const isConvX = (event: InboxEvent) => event.id === a.id || event.id === c.id;
    const isNone = (event: InboxEvent) => event.id === 'never';
    expect(delivery.someDeferred(isConvX)).toBe(true);
    expect(delivery.matchingDeferredCount(isConvX)).toBe(2);
    expect(delivery.someDeferred(isNone)).toBe(false);
    expect(delivery.matchingDeferredCount(isNone)).toBe(0);
  });
});

describe('CloneDelivery — getUnread/setUnread/deleteUnread/unreadSize（素通しの同期メソッド）', () => {
  it('setUnread で積んだ Promise がそのまま getUnread で引ける（同一性が保たれる）', () => {
    const delivery = new CloneDelivery();
    const written = Promise.resolve();
    delivery.setUnread('evt-1', written);
    expect(delivery.getUnread('evt-1')).toBe(written);
    expect(delivery.unreadSize).toBe(1);
  });

  it('deleteUnread で消すと、getUnread は undefined、unreadSize も減る', () => {
    const delivery = new CloneDelivery();
    delivery.setUnread('evt-1', Promise.resolve());
    delivery.deleteUnread('evt-1');
    expect(delivery.getUnread('evt-1')).toBeUndefined();
    expect(delivery.unreadSize).toBe(0);
  });

  it('積んでいない id を getUnread しても undefined、deleteUnread しても例外にならない', () => {
    const delivery = new CloneDelivery();
    expect(delivery.getUnread('never')).toBeUndefined();
    expect(() => delivery.deleteUnread('never')).not.toThrow();
  });
});

describe('CloneDelivery — getCollapseEntry/registerCollapseRepresentative/dropCollapseEntryIfMatches/hasCollapseKey/collapseSize', () => {
  it('registerCollapseRepresentative は collapsed: 0 の代表を登録し、getCollapseEntry で読める', () => {
    const delivery = new CloneDelivery();
    delivery.registerCollapseRepresentative('key-1', 'evt-1', '2026-09-01T00:00:00.000Z');
    expect(delivery.getCollapseEntry('key-1')).toEqual({
      id: 'evt-1',
      at: '2026-09-01T00:00:00.000Z',
      collapsed: 0,
    });
    expect(delivery.hasCollapseKey('key-1')).toBe(true);
    expect(delivery.collapseSize).toBe(1);
  });

  it('getCollapseEntry が返すのは Map が持つ実体そのもの——呼び出し側の直接 mutate が反映される', () => {
    const delivery = new CloneDelivery();
    delivery.registerCollapseRepresentative('key-1', 'evt-1', '2026-09-01T00:00:00.000Z');
    const existing = delivery.getCollapseEntry('key-1');
    expect(existing).toBeDefined();
    if (existing === undefined) throw new Error('unreachable');
    existing.collapsed += 1;
    expect(delivery.getCollapseEntry('key-1')?.collapsed).toBe(1);
  });

  it('dropCollapseEntryIfMatches は id が一致するときだけ落とし、その中身を返す', () => {
    const delivery = new CloneDelivery();
    delivery.registerCollapseRepresentative('key-1', 'evt-1', '2026-09-01T00:00:00.000Z');
    const existing = delivery.getCollapseEntry('key-1');
    if (existing !== undefined) existing.collapsed = 3;

    const dropped = delivery.dropCollapseEntryIfMatches('key-1', 'evt-1');
    expect(dropped).toEqual({ id: 'evt-1', at: '2026-09-01T00:00:00.000Z', collapsed: 3 });
    expect(delivery.hasCollapseKey('key-1')).toBe(false);
    expect(delivery.collapseSize).toBe(0);
  });

  it('dropCollapseEntryIfMatches は id が一致しなければ何もせず undefined を返す', () => {
    const delivery = new CloneDelivery();
    delivery.registerCollapseRepresentative(
      'key-1',
      'evt-representative',
      '2026-09-01T00:00:00.000Z',
    );
    const dropped = delivery.dropCollapseEntryIfMatches('key-1', 'evt-other');
    expect(dropped).toBeUndefined();
    expect(delivery.hasCollapseKey('key-1')).toBe(true);
  });

  it('dropCollapseEntryIfMatches は鍵が無ければ undefined を返し、例外にならない', () => {
    const delivery = new CloneDelivery();
    expect(delivery.dropCollapseEntryIfMatches('never', 'evt-1')).toBeUndefined();
  });
});

describe('CloneDelivery — pendingTokenPoolNotice/setPendingTokenPoolNotice/clearPendingTokenPoolNoticeIfMatches', () => {
  it('初期値は null', () => {
    const delivery = new CloneDelivery();
    expect(delivery.pendingTokenPoolNotice).toBeNull();
  });

  it('setPendingTokenPoolNotice で控えた値がそのまま読める', () => {
    const delivery = new CloneDelivery();
    const value = { id: 'evt-1', at: '2026-09-01T00:00:00.000Z', key: 'k1', folded: 0 };
    delivery.setPendingTokenPoolNotice(value);
    expect(delivery.pendingTokenPoolNotice).toBe(value);
  });

  it('clearPendingTokenPoolNoticeIfMatches は id が一致するときだけ null に戻す', () => {
    const delivery = new CloneDelivery();
    delivery.setPendingTokenPoolNotice({
      id: 'evt-1',
      at: '2026-09-01T00:00:00.000Z',
      key: 'k1',
      folded: 0,
    });
    delivery.clearPendingTokenPoolNoticeIfMatches('evt-other');
    expect(delivery.pendingTokenPoolNotice).not.toBeNull();

    delivery.clearPendingTokenPoolNoticeIfMatches('evt-1');
    expect(delivery.pendingTokenPoolNotice).toBeNull();
  });

  it('clearPendingTokenPoolNoticeIfMatches は既に null のときに呼んでも例外にならない', () => {
    const delivery = new CloneDelivery();
    expect(() => delivery.clearPendingTokenPoolNoticeIfMatches('evt-1')).not.toThrow();
  });
});

describe('CloneDelivery — chainRecord は #recordChain の直列化そのもの（Issue #1190「配送」束の核）', () => {
  it('getRecorded は chainRecord が返した Promise と同一のものを返す', () => {
    const delivery = new CloneDelivery();
    const written = delivery.chainRecord('evt-1', () => Promise.resolve());
    expect(delivery.getRecorded('evt-1')).toBe(written);
  });

  it('deleteRecorded は控えを消すだけで、書き込みそのものは取り消さない', async () => {
    const delivery = new CloneDelivery();
    let wrote = false;
    const written = delivery.chainRecord('evt-1', () => {
      wrote = true;
      return Promise.resolve();
    });
    delivery.deleteRecorded('evt-1');
    expect(delivery.getRecorded('evt-1')).toBeUndefined();
    await written;
    expect(wrote).toBe(true);
  });

  it('2本の chainRecord は受け取った順に直列で走る——2本目は1本目が解決するまで始まらない', async () => {
    const delivery = new CloneDelivery();
    const order: string[] = [];
    let releaseFirst: () => void = () => {};
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = delivery.chainRecord('evt-1', async () => {
      order.push('first-start');
      await firstGate;
      order.push('first-end');
    });
    const second = delivery.chainRecord('evt-2', async () => {
      order.push('second-start');
    });

    // 1本目がまだ解決していない段階では、2本目はまだ走っていない
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual(['first-start']);

    releaseFirst();
    await first;
    await second;
    expect(order).toEqual(['first-start', 'first-end', 'second-start']);
  });

  it('1本目が失敗しても、列そのものは切れず2本目は走る（catch(() => undefined) の効果）', async () => {
    const delivery = new CloneDelivery();
    const order: string[] = [];

    const first = delivery.chainRecord('evt-1', async () => {
      order.push('first');
      throw new Error('書き込み失敗');
    });
    const second = delivery.chainRecord('evt-2', async () => {
      order.push('second');
    });

    await expect(first).rejects.toThrow('書き込み失敗');
    await second;
    expect(order).toEqual(['first', 'second']);
  });

  it('chainRecord へ渡した write は、返した Promise を待たなくても同期的に呼ばれる形にはならない——.then の実行は次の tick 以降（Promise の同一性・tick 数を変えていないことの対照）', async () => {
    const delivery = new CloneDelivery();
    let called = false;
    delivery.chainRecord('evt-1', () => {
      called = true;
      return Promise.resolve();
    });
    // `#recordChain` の初期値は `Promise.resolve()` なので、`.then(write)` の
    // コールバックは同期では走らない（micro-task 待ち）。
    expect(called).toBe(false);
    await Promise.resolve();
    expect(called).toBe(true);
  });
});

describe('CloneDelivery — getCommitted/setCommitted/deleteCommitted（素通しの同期メソッド）', () => {
  it('setCommitted で積んだ Promise がそのまま getCommitted で引ける（同一性が保たれる）', () => {
    const delivery = new CloneDelivery();
    const outcome = Promise.resolve<'opened'>('opened');
    delivery.setCommitted('evt-1', outcome);
    expect(delivery.getCommitted('evt-1')).toBe(outcome);
  });

  it('deleteCommitted で消すと getCommitted は undefined', () => {
    const delivery = new CloneDelivery();
    delivery.setCommitted('evt-1', Promise.resolve<'opened'>('opened'));
    delivery.deleteCommitted('evt-1');
    expect(delivery.getCommitted('evt-1')).toBeUndefined();
  });

  it('積んでいない id を getCommitted/deleteCommitted しても例外にならない', () => {
    const delivery = new CloneDelivery();
    expect(delivery.getCommitted('never')).toBeUndefined();
    expect(() => delivery.deleteCommitted('never')).not.toThrow();
  });
});
