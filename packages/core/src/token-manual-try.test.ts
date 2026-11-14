import { describe, expect, it, vi } from 'vitest';

import type { AgentToken } from './token-pool.js';
import { createManualTokenTry, MANUAL_TOKEN_TRY_MIN_INTERVAL_MS } from './token-manual-try.js';

const AT = Date.parse('2026-09-25T00:00:00.000Z');

function setup(tokens: AgentToken[]) {
  let now = AT;
  const recordTrialSuccess = vi.fn(() =>
    Promise.resolve({ kind: 'ignored' as const, signal: 'none' as const, why: 'テスト' }),
  );
  const recordTrialVerdict = vi.fn(() => Promise.resolve('written' as const));
  const trial = vi.fn(() => Promise.resolve({ verdict: 'usable' as const }));
  const tryer = createManualTokenTry({
    listTokens: () => Promise.resolve(tokens),
    trial: { trial },
    recordTrialSuccess,
    recordTrialVerdict,
    onOutcome: () => Promise.resolve(),
    now: () => now,
  });
  return {
    tryer,
    trial,
    recordTrialSuccess,
    recordTrialVerdict,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

const cooling: AgentToken = {
  id: 'a',
  label: 'a',
  order: 0,
  value: 'v-a',
  cooldownUntil: AT + 3_600_000,
};

describe('createManualTokenTry', () => {
  it('値の無い鍵は試さずに断る', async () => {
    const { tryer, trial } = setup([{ id: 'a', label: 'a', order: 0 }]);

    expect(await tryer.try('a')).toEqual({ kind: 'not_tryable', cause: 'no_value' });
    expect(trial).not.toHaveBeenCalled();
  });

  it('断った回（外した鍵）は最終試行時刻を書かない', async () => {
    const tokens: AgentToken[] = [{ ...cooling, disabledAt: '2026-09-01T00:00:00.000Z' }];
    const { tryer } = setup(tokens);
    await tryer.try('a');
    tokens[0] = cooling;

    expect((await tryer.try('a')).kind).toBe('passed');
  });

  it('通った鍵だけ回し手へ渡し、冷却中でない鍵は渡さない', async () => {
    const { tryer, recordTrialSuccess, advance } = setup([
      cooling,
      { id: 'r', label: 'r', order: 1, value: 'v-r' },
    ]);

    expect(await tryer.try('r')).toEqual({ kind: 'passed', cooldownCleared: false });
    expect(recordTrialSuccess).not.toHaveBeenCalled();
    advance(MANUAL_TOKEN_TRY_MIN_INTERVAL_MS);
    expect((await tryer.try('a')).kind).toBe('passed');
    expect(recordTrialSuccess).toHaveBeenCalledWith({ tokenId: 'a' });
  });
});
