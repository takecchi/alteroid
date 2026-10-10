import { describe, expect, it } from 'vitest';

import { describeProbeFailure } from './runner-protocol.js';

// 全台が同時に「名乗らなくなった」とされたとき、遅れたのが器かデーモン自身かを、失敗の文言だけで分けられることを保証する（#4454）。
describe('名乗りの確認の失敗の文言', () => {
  it('期限切れの文言に、投げてから失敗までの時間とイベントループ使用率を添える', () => {
    const text = describeProbeFailure(new Error('5000ms 以内に名乗りが返らなかった'), {
      elapsedMs: 7312.4,
      loopUtilization: 0.973,
    });
    expect(text).toBe(
      'Error: 5000ms 以内に名乗りが返らなかった' +
        '（デーモン側の観測: 投げてから失敗まで 7312ms・その間のイベントループ使用率 97%）',
    );
  });

  it('`fetch failed` は cause とその code を落とさない', () => {
    const cause = Object.assign(new Error('Connect Timeout Error'), {
      code: 'UND_ERR_CONNECT_TIMEOUT',
    });
    const text = describeProbeFailure(new TypeError('fetch failed', { cause }), {
      elapsedMs: 120,
      loopUtilization: 0.05,
    });
    expect(text).toBe(
      'TypeError: fetch failed cause=Error: Connect Timeout Error code=UND_ERR_CONNECT_TIMEOUT' +
        '（デーモン側の観測: 投げてから失敗まで 120ms・その間のイベントループ使用率 5%）',
    );
  });

  it('code を持たない cause は cause だけを添える', () => {
    const text = describeProbeFailure(new Error('x', { cause: 'plain' }), {
      elapsedMs: 0,
      loopUtilization: 0,
    });
    expect(text).toBe(
      'Error: x cause=plain（デーモン側の観測: 投げてから失敗まで 0ms・その間のイベントループ使用率 0%）',
    );
  });
});
