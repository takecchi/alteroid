import { afterEach, describe, expect, it, vi } from 'vitest';

import { setStderrSinkForTesting } from './dropped-record.js';
import {
  AwaitingBackgroundStallWatch,
  MANAGER_AWAITING_BACKGROUND_STALL_NOTICE_MS,
} from './manager-awaiting-background-stall-watch.js';
import type { ManagerRecord } from './manager.js';

// 実時間も fake timer も使わない: 時計を進めて `sweep()` を直接呼ぶ。閾値は定数（10 分）だが、値そのものも縛るため字面で置く。
const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const THRESHOLD_MS = 10 * MINUTE;
const START = Date.parse('2026-11-27T10:00:00.000Z');

afterEach(() => {
  setStderrSinkForTesting(null);
});

interface Env {
  record: ManagerRecord;
  advance: (ms: number) => void;
  sweep: () => Promise<void>;
  setWithheld: (count: number | undefined) => void;
  setTasks: (tasks: number | undefined) => void;
  /** 出来事が届いたことにする（`noteProgressEvent` の結果と同じ欄を進める） */
  event: (type: string) => void;
  reports: string[];
  journal: string[];
}

function setup(): Env {
  let clock = START;
  let withheld: number | undefined = 3;
  let tasks: number | undefined = 0;
  const reports: string[] = [];
  const journal: string[] = [];
  const record = {
    job: { id: 'mgr-stall', status: 'done' },
    attached: true,
    waiting: [],
    lastEventAt: new Date(START).toISOString(),
    lastEventType: 'report',
  } as unknown as ManagerRecord;
  const watch = new AwaitingBackgroundStallWatch({
    records: new Map([['mgr-stall', record]]),
    now: () => clock,
    stopped: () => false,
    withheldCount: () => withheld,
    liveBackgroundTasks: () => tasks,
    emitReport: (_managerId, text) => {
      reports.push(text);
    },
    journalExchange: async (_role, text) => {
      journal.push(text);
    },
  });
  return {
    record,
    advance: (ms) => {
      clock += ms;
    },
    sweep: async () => {
      watch.sweep();
      await vi.waitFor(() => undefined);
    },
    setWithheld: (count) => {
      withheld = count;
    },
    setTasks: (value) => {
      tasks = value;
    },
    event: (type) => {
      record.lastEventAt = new Date(clock).toISOString();
      record.lastEventType = type;
    },
    reports,
    journal,
  };
}

describe('背景処理待ちで畳んだまま、背景処理 0 本から 10 分次のターンが来ない担当を 1 通だけ知らせる', () => {
  it('定数は 10 分', () => {
    expect(MANAGER_AWAITING_BACKGROUND_STALL_NOTICE_MS).toBe(THRESHOLD_MS);
  });

  it('条件が揃って 10 分たつと 1 通だけ出る（日誌の [障害] も 1 行）。11 分・12 分の周回でも 2 通目は出ない', async () => {
    const env = setup();
    await env.sweep(); // 最初の観測
    env.advance(THRESHOLD_MS);
    await env.sweep();
    expect(env.reports).toHaveLength(1);
    const [text] = env.reports;
    expect(text).toContain('mgr-stall');
    expect(text).toContain('10分');
    expect(text).toContain('畳んだ報告が 3 本');
    expect(text).toContain('manager_send');
    expect(text).toContain('自動では起こさない');
    expect(env.journal).toHaveLength(1);
    expect(env.journal[0]).toMatch(/^\[障害\] /);

    env.advance(MINUTE);
    await env.sweep();
    env.advance(MINUTE);
    await env.sweep();
    expect(env.reports).toHaveLength(1);
    expect(env.journal).toHaveLength(1);
  });

  it('9 分 59 秒では出ない', async () => {
    const env = setup();
    await env.sweep();
    env.advance(THRESHOLD_MS - SECOND);
    await env.sweep();
    expect(env.reports).toEqual([]);
  });

  it('背景処理の本数の観測が undefined なら出ない（0 を捏造しない）', async () => {
    const env = setup();
    env.setTasks(undefined);
    await env.sweep();
    env.advance(THRESHOLD_MS * 3);
    await env.sweep();
    expect(env.reports).toEqual([]);
  });

  it('背景処理が 1 本以上なら出ない。0 に戻ったときが起点になる', async () => {
    const env = setup();
    env.setTasks(1);
    await env.sweep();
    env.advance(THRESHOLD_MS * 3);
    await env.sweep();
    expect(env.reports).toEqual([]);

    env.setTasks(0);
    await env.sweep(); // 0 本を初めて見た
    env.advance(THRESHOLD_MS - SECOND);
    await env.sweep();
    expect(env.reports).toEqual([]);
    env.advance(SECOND);
    await env.sweep();
    expect(env.reports).toHaveLength(1);
  });

  it('0 本の間に lastEventAt が進めば、起点がそこへ動く', async () => {
    const env = setup();
    await env.sweep();
    env.advance(THRESHOLD_MS - MINUTE);
    env.event('session');
    await env.sweep();
    env.advance(THRESHOLD_MS - SECOND);
    await env.sweep();
    expect(env.reports).toEqual([]);
    env.advance(SECOND);
    await env.sweep();
    expect(env.reports).toHaveLength(1);
  });

  it('見張りが最初に見たのが出来事より後なら、起点は見た時刻（遅いほう）', async () => {
    const env = setup();
    env.advance(30 * MINUTE); // 最後の出来事から 30 分たってから初めて見る
    await env.sweep();
    expect(env.reports).toEqual([]);
    env.advance(THRESHOLD_MS);
    await env.sweep();
    expect(env.reports).toHaveLength(1);
  });

  it('最後の出来事が tool_use / tool_running（前景の長い道具の途中）なら、10 分を超えても出ない。次の出来事から新しく数える', async () => {
    for (const type of ['tool_use', 'tool_running']) {
      const env = setup();
      env.event(type);
      await env.sweep();
      env.advance(THRESHOLD_MS * 3);
      await env.sweep();
      expect(env.reports).toEqual([]);

      env.event('tool_end');
      await env.sweep(); // 観測を捨てていたので、ここが最初の観測
      env.advance(THRESHOLD_MS - SECOND);
      await env.sweep();
      expect(env.reports).toEqual([]);
      env.advance(SECOND);
      await env.sweep();
      expect(env.reports).toHaveLength(1);
    }
  });

  it('在庫が無い（背景処理待ちでない）done では出ない', async () => {
    const env = setup();
    env.setWithheld(undefined);
    await env.sweep();
    env.advance(THRESHOLD_MS * 3);
    await env.sweep();
    expect(env.reports).toEqual([]);
  });

  it('done でない・attached でない担当では出ない', async () => {
    const env = setup();
    (env.record.job as { status: string }).status = 'running';
    await env.sweep();
    env.advance(THRESHOLD_MS * 3);
    await env.sweep();
    expect(env.reports).toEqual([]);

    (env.record.job as { status: string }).status = 'done';
    env.record.attached = false;
    await env.sweep();
    env.advance(THRESHOLD_MS * 3);
    await env.sweep();
    expect(env.reports).toEqual([]);
  });

  it('知らせた後に出来事が来たら episode が閉じ（[復旧] は日誌のみ）、また条件が揃えば次の 1 通が出る', async () => {
    const env = setup();
    await env.sweep();
    env.advance(THRESHOLD_MS);
    await env.sweep();
    expect(env.reports).toHaveLength(1);

    env.advance(MINUTE);
    env.event('session');
    await env.sweep();
    expect(env.reports).toHaveLength(1);
    expect(env.journal.filter((line) => line.startsWith('[復旧] '))).toHaveLength(1);

    env.advance(THRESHOLD_MS - SECOND);
    await env.sweep();
    expect(env.reports).toHaveLength(1);
    env.advance(SECOND);
    await env.sweep();
    expect(env.reports).toHaveLength(2);
    expect(env.journal.filter((line) => line.startsWith('[障害] '))).toHaveLength(2);
  });

  it('report の配達が投げても、日誌は書かれ、sweep は投げない', async () => {
    const env = setup();
    const lines: string[] = [];
    setStderrSinkForTesting((line) => {
      lines.push(line);
    });
    // 最初の観測を START に置くため、時計を 2 段で進める
    let clock = START;
    const watch = new AwaitingBackgroundStallWatch({
      records: new Map([['mgr-stall', env.record]]),
      now: () => clock,
      stopped: () => false,
      withheldCount: () => 1,
      liveBackgroundTasks: () => 0,
      emitReport: () => {
        throw new Error('受信箱へ積めない（試験用）');
      },
      journalExchange: async (_role, text) => {
        env.journal.push(text);
      },
    });
    watch.sweep();
    clock = START + THRESHOLD_MS;
    expect(() => {
      watch.sweep();
    }).not.toThrow();
    await vi.waitFor(() => expect(env.journal).toHaveLength(1));
    expect(lines.join('')).toContain('背景処理待ちの停滞の知らせ');
  });
});
