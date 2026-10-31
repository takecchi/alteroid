import { describe, expect, it } from 'vitest';

import { CloneRedeliveryState } from './clone-redelivery-state.js';
import type { PendingInboxEvent } from './store.js';
import { humanMessage } from './testing.js';

function pending(event: PendingInboxEvent['event'] = humanMessage('拾い直し')): PendingInboxEvent {
  return { event, at: '2026-09-01T00:00:00.000Z', deliveries: 1 };
}

describe('CloneRedeliveryState — get/markRedelivered（素の読み書き）', () => {
  it('載せていない id は get が undefined', () => {
    const state = new CloneRedeliveryState();
    expect(state.get('evt-1')).toBeUndefined();
  });

  it('markRedelivered で控えた record がそのまま get で引ける', () => {
    const state = new CloneRedeliveryState();
    const record = pending();
    state.markRedelivered('evt-1', record);
    expect(state.get('evt-1')).toBe(record);
  });
});

describe('CloneRedeliveryState — drop（Issue #1534 案2）', () => {
  it('載った id を drop すると get が undefined になる', () => {
    const state = new CloneRedeliveryState();
    const record = pending();
    state.markRedelivered('evt-1', record);
    expect(state.get('evt-1')).toBe(record);

    state.drop('evt-1');

    expect(state.get('evt-1')).toBeUndefined();
  });

  it('drop は指定した id 以外に影響しない', () => {
    const state = new CloneRedeliveryState();
    const keptRecord = pending(humanMessage('残る'));
    state.markRedelivered('evt-keep', keptRecord);
    state.markRedelivered('evt-drop', pending());

    state.drop('evt-drop');

    expect(state.get('evt-keep')).toBe(keptRecord);
    expect(state.get('evt-drop')).toBeUndefined();
  });

  it('載っていない id を drop しても例外を投げない（冪等）', () => {
    const state = new CloneRedeliveryState();
    expect(() => state.drop('never-existed')).not.toThrow();
  });

  it('redeliveredSize は drop で減る', () => {
    const state = new CloneRedeliveryState();
    state.markRedelivered('evt-1', pending());
    expect(state.redeliveredSize).toBe(1);

    state.drop('evt-1');

    expect(state.redeliveredSize).toBe(0);
  });
});
