import { describe, expect, it } from 'vitest';

import { createCloneWakeGate, reopenedTokenOf } from './index.js';
import type { CloneWakeGate } from './index.js';

function rotatedTo(toTokenId: string, toLabel: string) {
  const reopened = reopenedTokenOf({
    kind: 'rotated',
    toTokenId,
    toLabel,
  } as unknown as Parameters<typeof reopenedTokenOf>[0]);
  if (reopened === undefined) throw new Error('rotated must reopen');
  return reopened;
}

function recoveredOf(tokenId: string) {
  const reopened = reopenedTokenOf({
    kind: 'ignored',
    recovered: { tokenId, label: `label-${tokenId}` },
  } as unknown as Parameters<typeof reopenedTokenOf>[0]);
  if (reopened === undefined) throw new Error('recovered must reopen');
  return reopened;
}

function deliver(gate: CloneWakeGate, toTokenId: string) {
  return gate.decide(rotatedTo(toTokenId, `label-${toTokenId}`), true, false);
}

describe('CloneWakeGate: rotated の往復 A→B→A→B', () => {
  it('🔴 クローンが止まっているなら、2回目の「B へ回した」も配る（起こし直しが届く）', () => {
    const gate = createCloneWakeGate();

    expect(deliver(gate, 'tok-b')).toEqual({ kind: 'wake', folded: 0 });
    expect(deliver(gate, 'tok-a')).toEqual({ kind: 'wake', folded: 0 });
    expect(deliver(gate, 'tok-b')).toEqual({ kind: 'wake', folded: 0 });
    expect(deliver(gate, 'tok-a')).toEqual({ kind: 'wake', folded: 0 });
    expect(deliver(gate, 'tok-b')).toEqual({ kind: 'wake', folded: 0 });
  });

  it('🔴 #1223 は戻らない: 遷移なしに繰り返される「また通るようになった」は畳む', () => {
    const gate = createCloneWakeGate();

    expect(gate.decide(recoveredOf('tok-b'), true, false)).toEqual({ kind: 'wake', folded: 0 });
    for (let i = 0; i < 5; i++) {
      expect(gate.decide(recoveredOf('tok-b'), false, false)).toEqual({ kind: 'fold' });
      expect(gate.decide(recoveredOf('tok-b'), true, false)).toEqual({ kind: 'fold' });
    }
  });

  it('🔴 回した は他トークンの「また通るようになった」の印を消さない', () => {
    const gate = createCloneWakeGate();

    expect(gate.decide(recoveredOf('tok-a'), true, false)).toEqual({ kind: 'wake', folded: 0 });
    expect(deliver(gate, 'tok-b')).toEqual({ kind: 'wake', folded: 0 });
    expect(gate.decide(recoveredOf('tok-a'), true, false)).toEqual({ kind: 'fold' });
  });

  it('回した の直後でも、もう起こしてある（releasePending）なら畳み、母数は数える', () => {
    const gate = createCloneWakeGate();

    expect(deliver(gate, 'tok-b')).toEqual({ kind: 'wake', folded: 0 });
    expect(gate.decide(rotatedTo('tok-b', 'label-tok-b'), true, true)).toEqual({ kind: 'fold' });
    expect(deliver(gate, 'tok-b')).toEqual({ kind: 'wake', folded: 1 });
  });
});
