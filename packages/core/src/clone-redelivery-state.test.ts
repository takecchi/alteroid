import { describe, expect, it } from 'vitest';

import { commitmentFor } from './clone.js';
import { CloneRedeliveryState } from './clone-redelivery-state.js';
import type { Commitment } from './schema.js';
import type { PendingInboxEvent } from './store.js';
import { humanMessage } from './testing.js';

function pending(event: PendingInboxEvent['event'] = humanMessage('拾い直し')): PendingInboxEvent {
  return { event, at: '2026-09-01T00:00:00.000Z', deliveries: 1 };
}

function closedCommitment(label = '片付いた拾い直し'): Commitment {
  const base = commitmentFor(humanMessage(label)) as Commitment;
  return { ...base, closedAt: '2026-09-01T00:05:00.000Z', closedBy: 'clone' };
}

describe('CloneRedeliveryState — get/markRedelivered、getClosed/markClosed（素の読み書き）', () => {
  it('載せていない id は get / getClosed のどちらも undefined', () => {
    const state = new CloneRedeliveryState();
    expect(state.get('evt-1')).toBeUndefined();
    expect(state.getClosed('evt-1')).toBeUndefined();
  });

  it('markRedelivered で控えた record がそのまま get で引ける', () => {
    const state = new CloneRedeliveryState();
    const record = pending();
    state.markRedelivered('evt-1', record);
    expect(state.get('evt-1')).toBe(record);
  });

  it('markClosed で控えた commitment がそのまま getClosed で引ける', () => {
    const state = new CloneRedeliveryState();
    const commitment = closedCommitment();
    state.markClosed('evt-1', commitment);
    expect(state.getClosed('evt-1')).toBe(commitment);
  });
});

describe('CloneRedeliveryState — drop は redelivered / redeliveredClosed の両方からまとめて外す（Issue #1534 案2）', () => {
  it('markRedelivered と markClosed の両方が載った id を drop すると、両方から消える', () => {
    const state = new CloneRedeliveryState();
    const record = pending();
    const commitment = closedCommitment();
    state.markRedelivered('evt-1', record);
    state.markClosed('evt-1', commitment);
    expect(state.get('evt-1')).toBe(record);
    expect(state.getClosed('evt-1')).toBe(commitment);

    state.drop('evt-1');

    expect(state.get('evt-1')).toBeUndefined();
    expect(state.getClosed('evt-1')).toBeUndefined();
  });

  it('redelivered にしか載っていない id を drop しても例外にならず、get が undefined になる', () => {
    const state = new CloneRedeliveryState();
    state.markRedelivered('evt-only-redelivered', pending());
    expect(() => state.drop('evt-only-redelivered')).not.toThrow();
    expect(state.get('evt-only-redelivered')).toBeUndefined();
    expect(state.getClosed('evt-only-redelivered')).toBeUndefined();
  });

  it('redeliveredClosed にしか載っていない（redelivered には無い）id を drop すると、そちらも消える', () => {
    const state = new CloneRedeliveryState();
    state.markClosed('evt-only-closed', closedCommitment());
    state.drop('evt-only-closed');
    expect(state.getClosed('evt-only-closed')).toBeUndefined();
  });

  it('drop は指定した id 以外に影響しない', () => {
    const state = new CloneRedeliveryState();
    const keptRecord = pending(humanMessage('残る'));
    const keptCommitment = closedCommitment('残る（closed）');
    state.markRedelivered('evt-keep', keptRecord);
    state.markClosed('evt-keep', keptCommitment);
    state.markRedelivered('evt-drop', pending());
    state.markClosed('evt-drop', closedCommitment());

    state.drop('evt-drop');

    expect(state.get('evt-keep')).toBe(keptRecord);
    expect(state.getClosed('evt-keep')).toBe(keptCommitment);
    expect(state.get('evt-drop')).toBeUndefined();
    expect(state.getClosed('evt-drop')).toBeUndefined();
  });

  it('載っていない id を drop しても例外を投げない（冪等）', () => {
    const state = new CloneRedeliveryState();
    expect(() => state.drop('never-existed')).not.toThrow();
  });

  it('redeliveredSize / redeliveredClosedSize は drop で両方いっしょに減る', () => {
    const state = new CloneRedeliveryState();
    state.markRedelivered('evt-1', pending());
    state.markClosed('evt-1', closedCommitment());
    expect(state.redeliveredSize).toBe(1);
    expect(state.redeliveredClosedSize).toBe(1);

    state.drop('evt-1');

    expect(state.redeliveredSize).toBe(0);
    expect(state.redeliveredClosedSize).toBe(0);
  });
});
