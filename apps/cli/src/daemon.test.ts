import { describe, expect, it } from 'vitest';

import { stopDaemon, type DaemonRuntimeInfo, type StopDeps } from './daemon.js';

const INFO: DaemonRuntimeInfo = {
  pid: 4242,
  port: 4517,
  startedAt: '2026-08-12T00:00:00.000Z',
  token: 'token-of-the-real-daemon',
};

interface Harness {
  deps: StopDeps;
  killed: number[];
  shutdownRequests: number;
  cleared: number;
}

function harness(overrides: Partial<StopDeps> = {}): Harness {
  const state = { killed: [] as number[], shutdownRequests: 0, cleared: 0 };

  const deps: StopDeps = {
    readInfo: async () => INFO,
    verify: async () => true,
    async requestShutdown() {
      state.shutdownRequests += 1;
    },
    terminate(pid) {
      state.killed.push(pid);
    },
    async clearInfo() {
      state.cleared += 1;
    },
    wait: async () => undefined,
    ...overrides,
  };

  return {
    deps,
    get killed() {
      return state.killed;
    },
    get shutdownRequests() {
      return state.shutdownRequests;
    },
    get cleared() {
      return state.cleared;
    },
  };
}

describe('alteroid daemon stop', () => {
  it('状態ファイルが無ければ何もしない', async () => {
    const h = harness({ readInfo: async () => null });

    expect(await stopDaemon(h.deps)).toBe('not-running');
    expect(h.killed).toEqual([]);
  });

  it('本人確認できたら停止を要求し、居なくなったら記録を片付ける', async () => {
    let alive = true;
    const h = harness({
      verify: async () => alive,
      async requestShutdown() {
        alive = false;
      },
    });

    expect(await stopDaemon(h.deps)).toBe('stopped');
    expect(h.killed).toEqual([]);
    expect(h.cleared).toBe(1);
  });

  it('本人確認できない PID には絶対にシグナルを送らない（PID 再利用で無関係なプロセスを殺さない）', async () => {
    // デーモンが SIGKILL やクラッシュで死に、daemon.json だけが残った状態。
    // その PID を OS が別のプロセスへ再利用している（= 生きているが別人）。
    const h = harness({ verify: async () => false });

    expect(await stopDaemon(h.deps)).toBe('stale');
    expect(h.killed).toEqual([]);
    expect(h.shutdownRequests).toBe(0);
    // 二度と同じ取り違えをしないよう、腐った記録は片付ける
    expect(h.cleared).toBe(1);
  });

  it('停止要求が失敗しても、本人確認済みならシグナルで押せる', async () => {
    let alive = true;
    const h = harness({
      verify: async () => alive,
      requestShutdown: async () => {
        throw new Error('接続できない');
      },
      terminate(pid) {
        expect(pid).toBe(INFO.pid);
        alive = false;
      },
    });

    expect(await stopDaemon(h.deps)).toBe('stopped');
  });

  it('応答し続けて止まらないなら unresponsive を返す（黙って殺し続けない）', async () => {
    const h = harness({ verify: async () => true });

    expect(await stopDaemon(h.deps)).toBe('unresponsive');
    // 本人確認済みなので SIGTERM 自体は許されるが、無限には送らない
    expect(h.killed.every((pid) => pid === INFO.pid)).toBe(true);
    expect(h.killed.length).toBeLessThanOrEqual(1);
  });
});
