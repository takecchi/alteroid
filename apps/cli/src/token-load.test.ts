import { describe, expect, it } from 'vitest';

import { describeTokenLoad } from './token.js';

describe('alteroid token list の鍵ごとの枠（#6633）', () => {
  it('測れた鍵は窓ごとの使用率と観測時刻を出す', () => {
    const line = describeTokenLoad(
      [
        {
          tokenId: 'a',
          state: {
            state: 'ok',
            usage: {
              at: '2026-11-09T08:00:00.000Z',
              limitsAvailable: true,
              windows: [
                { kind: 'five_hour', utilization: 34.4 },
                { kind: 'seven_day', utilization: 12 },
              ],
            },
          },
        },
      ],
      'a',
    );
    expect(line).toBe('枠: 5時間 34% / 週 12%（2026-11-09T08:00:00.000Z 時点）');
  });

  it('測っていない鍵を 0% と書かない', () => {
    const line = describeTokenLoad([], 'a');
    expect(line).toContain('まだ測っていない');
    expect(line).not.toContain('0%');
  });

  it('使用率の無い観測は「取れない」と言う（0% と書かない）', () => {
    const line = describeTokenLoad(
      [
        {
          tokenId: 'a',
          state: {
            state: 'ok',
            usage: { at: '2026-11-09T08:00:00.000Z', limitsAvailable: false, windows: [] },
          },
        },
      ],
      'a',
    );
    expect(line).toContain('使用率が取れない');
    expect(line).not.toContain('0%');
  });

  it('測れなかった回は理由を出す', () => {
    const line = describeTokenLoad(
      [
        {
          tokenId: 'a',
          state: { state: 'failed', at: '2026-11-09T08:00:00Z', reason: '締め切り' },
        },
      ],
      'a',
    );
    expect(line).toBe('枠: 測れなかった — 締め切り（2026-11-09T08:00:00Z）');
  });
});
