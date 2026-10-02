import { describe, expect, it } from 'vitest';

import { createCloneWakeGate, reopenedTokenOf } from './index.js';
import type { CloneWakeGate } from './index.js';

/**
 * PR #1288 の後に残った穴（Issue #2511）の再現: `rotated`（how='回した'）で鍵が
 * A→B→A→B と往復すると、2回目の「B へ回した」が `told[B]` と同じ身元になり、
 * クローンが枠で止まっているのに畳まれる（起こし直しが届かない）。
 *
 * `settleTokenOutcome` は `parked` / `exhausted` のときだけ `observeUnusable()` を
 * 呼ぶ。`rotated` の outcome の前には呼ばれない。本物の outcome 型を
 * `reopenedTokenOf` に通して `decide` へ渡す（偽の値のみ。時間待ち無し）。
 */
function rotatedTo(toTokenId: string, toLabel: string) {
  const reopened = reopenedTokenOf({
    kind: 'rotated',
    toTokenId,
    toLabel,
  } as unknown as Parameters<typeof reopenedTokenOf>[0]);
  if (reopened === undefined) throw new Error('rotated must reopen');
  return reopened;
}

/** 観測（turn_success / probe）による「また通るようになった」。 */
function recoveredOf(tokenId: string) {
  const reopened = reopenedTokenOf({
    kind: 'ignored',
    recovered: { tokenId, label: `label-${tokenId}` },
  } as unknown as Parameters<typeof reopenedTokenOf>[0]);
  if (reopened === undefined) throw new Error('recovered must reopen');
  return reopened;
}

/** 枠で止まっていて、まだ起こしていない状態で rotated が来る。 */
function deliver(gate: CloneWakeGate, toTokenId: string) {
  return gate.decide(rotatedTo(toTokenId, `label-${toTokenId}`), true, false);
}

describe('CloneWakeGate: rotated の往復 A→B→A→B', () => {
  it('🔴 クローンが止まっているなら、2回目の「B へ回した」も配る（起こし直しが届く）', () => {
    const gate = createCloneWakeGate();

    // 1回目 B: 配る
    expect(deliver(gate, 'tok-b')).toEqual({ kind: 'wake', folded: 0 });
    // B でまた枠に当たり A へ回る: 配る（別トークン）
    expect(deliver(gate, 'tok-a')).toEqual({ kind: 'wake', folded: 0 });
    // A でまた枠に当たり B へ回る。rotated の前に observeUnusable() は呼ばれない。
    expect(deliver(gate, 'tok-b')).toEqual({ kind: 'wake', folded: 0 });
    // さらに往復しても毎回配る。
    expect(deliver(gate, 'tok-a')).toEqual({ kind: 'wake', folded: 0 });
    expect(deliver(gate, 'tok-b')).toEqual({ kind: 'wake', folded: 0 });
  });

  it('🔴 #1223 は戻らない: 遷移なしに繰り返される「また通るようになった」は畳む', () => {
    const gate = createCloneWakeGate();

    expect(gate.decide(recoveredOf('tok-b'), true, false)).toEqual({ kind: 'wake', folded: 0 });
    // 鍵は B のまま、同じ根拠の合図が observeUnusable() 無しで繰り返し来る。
    for (let i = 0; i < 5; i++) {
      expect(gate.decide(recoveredOf('tok-b'), false, false)).toEqual({ kind: 'fold' });
      expect(gate.decide(recoveredOf('tok-b'), true, false)).toEqual({ kind: 'fold' });
    }
  });

  it('🔴 回した は他トークンの「また通るようになった」の印を消さない', () => {
    const gate = createCloneWakeGate();

    expect(gate.decide(recoveredOf('tok-a'), true, false)).toEqual({ kind: 'wake', folded: 0 });
    // B へ回す（A の印は残る）。
    expect(deliver(gate, 'tok-b')).toEqual({ kind: 'wake', folded: 0 });
    // A の同じ根拠の合図はまだ畳む。
    expect(gate.decide(recoveredOf('tok-a'), true, false)).toEqual({ kind: 'fold' });
  });

  it('回した の直後でも、もう起こしてある（releasePending）なら畳み、母数は数える', () => {
    const gate = createCloneWakeGate();

    expect(deliver(gate, 'tok-b')).toEqual({ kind: 'wake', folded: 0 });
    expect(gate.decide(rotatedTo('tok-b', 'label-tok-b'), true, true)).toEqual({ kind: 'fold' });
    // 次に起こす回は畳んだ1件ぶんを持って配られる。
    expect(deliver(gate, 'tok-b')).toEqual({ kind: 'wake', folded: 1 });
  });
});
