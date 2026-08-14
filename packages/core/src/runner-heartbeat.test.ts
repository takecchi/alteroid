import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createRunnerRegistry } from './runner-protocol.js';
import type {
  RunnerClient,
  RunnerCredentialFingerprint,
  RunnerManagerState,
  RunnerProfileFingerprint,
  RunnerProfileResult,
  RunnerResumeCommand,
  RunnerStartCommand,
} from './runner-protocol.js';

/**
 * runner の生存判定（roadmap M5）。
 *
 * ここで固定したいのは、**黙って死んだ器を名簿が自分で見つけられる**ことである。
 * SSE の `hello` は器が礼儀正しく落ちたときにしか届かない — 電源が抜けた器も、
 * ネットワークだけが切れた器も、ストリームは開いたまま何も言わなくなる。
 * その沈黙を拾うのがこの層で、`hello` の**置き換えではなく補完**である。
 *
 * **時計は手で進める。** 実時間を待つ形にすると、判定の猶予（30秒）を確かめる
 * テストがそのまま 30秒かかり、CI が遅く・不安定になる。
 */

/** 偽 runner。**`/health` の応え方だけを外から決められる**（他は名簿が触らない）。 */
class FakeRunner implements RunnerClient {
  readonly runnerId: string;
  readonly workspacePath = '/work/project';
  /** `/health` を叩かれた回数。名乗りが本当に飛んでいるかを見る。 */
  pings = 0;
  /** `'ok'` = 応える / `'error'` = 即座にこける / `'hang'` = 黙ったまま返さない。 */
  reply: 'ok' | 'error' | 'hang' = 'ok';
  closed = false;

  constructor(runnerId: string) {
    this.runnerId = runnerId;
  }

  async ping(): Promise<void> {
    this.pings += 1;
    if (this.reply === 'ok') return;
    if (this.reply === 'error') throw new Error('fetch failed');
    // **黙って死んだ器。** 繋がってはいるが、いつまでも返事が返らない。
    await new Promise<never>(() => undefined);
  }

  async connect(): Promise<void> {}
  async start(_command: RunnerStartCommand): Promise<void> {}
  async resume(_command: RunnerResumeCommand): Promise<void> {}
  async send(_managerId: string, _text: string): Promise<void> {}
  async answer(): Promise<boolean> {
    return false;
  }
  async stop(_managerId: string): Promise<void> {}
  async list(): Promise<RunnerManagerState[]> {
    return [];
  }
  async transcript(_managerId: string): Promise<string | null> {
    return null;
  }
  async credentials(): Promise<RunnerCredentialFingerprint[]> {
    return [];
  }
  async setCredentials(): Promise<RunnerCredentialFingerprint[]> {
    return [];
  }
  async profile(): Promise<RunnerProfileFingerprint | undefined> {
    return undefined;
  }
  async setProfile(_script: string): Promise<RunnerProfileResult> {
    return { ok: true };
  }
  async close(): Promise<void> {
    this.closed = true;
  }
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('runner の生存判定', () => {
  it('10秒ごとに /health を叩き、30秒応答が無ければ onLost が1回だけ出る', async () => {
    const lost: { label: string; runnerId?: string }[] = [];
    const runner = new FakeRunner('runner-a');
    const registry = createRunnerRegistry([], { onLost: (event) => lost.push(event) });
    await registry.register({ label: 'http://runner:4518', open: async () => runner });

    // 名乗りは10秒ごと。**1回の取りこぼしでは落とさない**（瞬きで宛先を失わない）。
    runner.reply = 'error';
    await vi.advanceTimersByTimeAsync(10_000);
    expect(runner.pings).toBe(1);
    expect(lost).toEqual([]);
    expect(registry.entries()).toMatchObject([{ state: 'connected' }]);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(lost).toEqual([]);

    // 3回分＝30秒。ここで初めて「落ちた」と判定する。
    await vi.advanceTimersByTimeAsync(10_000);
    expect(lost).toMatchObject([{ label: 'http://runner:4518', runnerId: 'runner-a' }]);
    expect(registry.entries()).toMatchObject([{ state: 'lost' }]);

    // **何度も出さない。** 落ちたことは1度の出来事であって、状態は `entries()` で見る。
    await vi.advanceTimersByTimeAsync(60_000);
    expect(lost).toHaveLength(1);

    await registry.stop();
  });
});
