import { describe, expect, it } from 'vitest';

import { describeRecoveredSource } from './tokens-describe';

describe('describeRecoveredSource（#5989）', () => {
  it('試しで通った回復は「ターンの成功」とは別の言葉で出す', () => {
    const trial = describeRecoveredSource('trial');
    expect(trial).toContain('試し');
    expect(trial).not.toBe(describeRecoveredSource('turn_success'));
  });

  it('試しを turn_success と書いていた古い行も、壊れずに読める', () => {
    expect(describeRecoveredSource('turn_success')).toContain('応答が成功');
  });

  it('知らない値は捨てずに素の値のまま出す', () => {
    expect(describeRecoveredSource('future_source' as never)).toContain('future_source');
  });
});
