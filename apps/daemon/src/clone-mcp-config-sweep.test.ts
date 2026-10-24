import type { CloneMcpConfigSweepOptions, CloneMcpConfigSweepResult } from '@alteroid/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CLONE_MCP_CONFIG_SWEEP_EVERY_MS,
  startCloneMcpConfigSweeping,
} from './clone-mcp-config-sweep.js';

const EMPTY: CloneMcpConfigSweepResult = { removed: [], failed: [] };

function setup(results: CloneMcpConfigSweepResult[]) {
  const appended: unknown[] = [];
  const lines: string[] = [];
  const calls: CloneMcpConfigSweepOptions[] = [];
  const queue = [...results];
  const sweeper = startCloneMcpConfigSweeping({
    journal: {
      append: async (entry) => {
        appended.push(entry);
        return undefined as never;
      },
    },
    sweep: async (options) => {
      calls.push(options);
      return queue.shift() ?? EMPTY;
    },
    now: () => Date.now(),
    tmpRoot: '/fake-tmp',
    ownPid: 99,
    liveDirs: () => new Set(['/fake-tmp/live']),
    writeLine: (line) => lines.push(line),
  });
  return { sweeper, appended, lines, calls };
}

describe('デーモンのクローンの MCP 設定の掃きの配線', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('周期は runner の掃き（scratch の周期）と同じ 10 分', () => {
    expect(CLONE_MCP_CONFIG_SWEEP_EVERY_MS).toBe(10 * 60_000);
  });

  it('起動時に1回掃き、入力に tmpRoot・live・自分の pid・now を渡す', async () => {
    const { sweeper, calls } = setup([]);
    await sweeper.runOnce();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ tmpRoot: '/fake-tmp', ownPid: 99, now: Date.now() });
    expect([...calls[0]!.liveDirs]).toEqual(['/fake-tmp/live']);
    sweeper.stop();
  });

  it('何も起きない回は日誌も標準エラーも書かず、周期で再び掃く', async () => {
    const { sweeper, appended, lines, calls } = setup([]);
    await vi.advanceTimersByTimeAsync(CLONE_MCP_CONFIG_SWEEP_EVERY_MS * 2);
    expect(calls.length).toBe(3);
    expect(appended).toEqual([]);
    expect(lines).toEqual([]);
    sweeper.stop();
  });

  it('消した回だけ decision を1行書き、標準エラーにも1行出す（中身は載せない）', async () => {
    const { sweeper, appended, lines } = setup([
      EMPTY,
      { removed: ['alteroid-clone-mcp-1-abc'], failed: [] },
    ]);
    await vi.advanceTimersByTimeAsync(0);
    expect(appended).toEqual([]);
    await vi.advanceTimersByTimeAsync(CLONE_MCP_CONFIG_SWEEP_EVERY_MS);
    expect(appended).toHaveLength(1);
    const entry = appended[0] as { type: string; decision: string; grounds: string };
    expect(entry.type).toBe('decision');
    expect(entry.decision).toContain(
      'デーモンが /tmp に残っていたクローンの MCP 設定（資格入り）の一時ディレクトリを片付けた',
    );
    expect(entry.grounds).toContain('  - 消した alteroid-clone-mcp-1-abc（directory）');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^alteroidd: .*\n$/);
    sweeper.stop();
  });

  it('消せなかった・走査の失敗は書き、同じ失敗は次の回に繰り返さない', async () => {
    const failed = {
      removed: [],
      failed: [{ name: 'alteroid-clone-mcp-1-bad', reason: 'EPERM' }],
      scanError: '/x を読めなかった: EACCES',
    };
    const { sweeper, appended } = setup([failed, failed, EMPTY]);
    await vi.advanceTimersByTimeAsync(0);
    expect(appended).toHaveLength(1);
    const entry = appended[0] as { grounds: string };
    expect(entry.grounds).toContain('走査の失敗: /x を読めなかった: EACCES');
    expect(entry.grounds).toContain(
      '  - 残した alteroid-clone-mcp-1-bad（directory） 理由 rm-failed:',
    );
    await vi.advanceTimersByTimeAsync(CLONE_MCP_CONFIG_SWEEP_EVERY_MS);
    expect(appended).toHaveLength(1);
    sweeper.stop();
  });

  it('掃きが投げてもデーモンは落ちず、次の周期でまた掃く', async () => {
    let n = 0;
    const sweeper = startCloneMcpConfigSweeping({
      journal: { append: async () => undefined as never },
      sweep: async () => {
        n += 1;
        if (n === 1) throw new Error('boom');
        return EMPTY;
      },
      writeLine: () => undefined,
    });
    await vi.advanceTimersByTimeAsync(CLONE_MCP_CONFIG_SWEEP_EVERY_MS);
    expect(n).toBe(2);
    sweeper.stop();
  });

  it('止めた後は掃かない', async () => {
    const { sweeper, calls } = setup([]);
    await vi.advanceTimersByTimeAsync(0);
    sweeper.stop();
    await vi.advanceTimersByTimeAsync(CLONE_MCP_CONFIG_SWEEP_EVERY_MS * 3);
    expect(calls).toHaveLength(1);
  });
});
