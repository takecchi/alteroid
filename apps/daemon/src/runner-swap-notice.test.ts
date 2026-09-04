import type { Job, JobStatus } from '@alteroid/core';
import { describe, expect, it } from 'vitest';

import {
  decideRunnerSwapNotice,
  noteRunnerSwap,
  type NoteRunnerSwapDeps,
} from './runner-swap-notice.js';

function job(id: string, status: JobStatus, runnerId?: string): Job {
  return {
    id,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    status,
    summary: `job ${id}`,
    runnerId,
  };
}

// -----------------------------------------------------------------------------
// decideRunnerSwapNotice: 純粋な判定関数。I/O を挟まないので、分岐それぞれを
// 直接呼び分けられる。
//
// ## 分岐一覧（このファイルの各 `it` が1つずつ対応する）
//
// B1  runnerId === undefined                              → runner-unnamed（起こす）
// B2  jobs === undefined                                   → ledger-unreadable（起こす）
// B3  job.status が running/waiting_human 以外              → 数えない
// B4  job.runnerId === undefined（未了）                    → 対象（unassigned）
// B5  job.runnerId === runnerId（未了・直撃）                → 対象（onThisRunner）
// B6  別宛先・aliveRunnerIds === undefined                  → 対象（silentElsewhere）
// B7  別宛先・aliveRunnerIds が生きていると言う               → 対象外
// B8  別宛先・aliveRunnerIds が死んでいる/載っていないと言う   → 対象（silentElsewhere）
// B9  affected > 0                                         → wake: true, reason: 'affected'
// B10 affected === 0                                       → wake: false, reason: 'none-affected'
// -----------------------------------------------------------------------------
describe('decideRunnerSwapNotice', () => {
  it('B1: runnerId を聞けていない → 数えられないので起こす', () => {
    const decision = decideRunnerSwapNotice({
      runnerId: undefined,
      jobs: [],
      aliveRunnerIds: new Set(),
    });
    expect(decision).toMatchObject({ wake: true, reason: 'runner-unnamed', affected: undefined });
  });

  it('B2: 台帳を読めなかった（jobs === undefined）→ 数えられないので起こす', () => {
    const decision = decideRunnerSwapNotice({
      runnerId: 'runner-1',
      jobs: undefined,
      aliveRunnerIds: new Set(),
    });
    expect(decision).toMatchObject({
      wake: true,
      reason: 'ledger-unreadable',
      affected: undefined,
    });
  });

  it('B3 + B10: 終わった委譲（done/failed/lost/stopped）だけなら対象は0本 → 起こさない', () => {
    const jobs = [
      job('a', 'done', 'runner-1'),
      job('b', 'failed', 'runner-1'),
      job('c', 'lost', 'runner-1'),
      job('d', 'stopped', 'runner-1'),
    ];
    const decision = decideRunnerSwapNotice({
      runnerId: 'runner-1',
      jobs,
      aliveRunnerIds: new Set(),
    });
    expect(decision).toMatchObject({ wake: false, reason: 'none-affected', affected: 0 });
  });

  it('B4 + B9: 宛先未記入の未了ジョブは対象に数え、1本以上あるので起こす', () => {
    const jobs = [job('a', 'running', undefined)];
    const decision = decideRunnerSwapNotice({
      runnerId: 'runner-1',
      jobs,
      aliveRunnerIds: new Set(),
    });
    expect(decision).toMatchObject({ wake: true, reason: 'affected', affected: 1 });
  });

  it('B5: この宛先そのものに載った running のジョブは対象（直撃）', () => {
    const jobs = [job('a', 'running', 'runner-1')];
    const decision = decideRunnerSwapNotice({
      runnerId: 'runner-1',
      jobs,
      aliveRunnerIds: new Set(),
    });
    expect(decision).toMatchObject({ wake: true, reason: 'affected', affected: 1 });
  });

  it('B5: waiting_human も直撃として対象に数える', () => {
    const jobs = [job('a', 'waiting_human', 'runner-1')];
    const decision = decideRunnerSwapNotice({
      runnerId: 'runner-1',
      jobs,
      aliveRunnerIds: new Set(),
    });
    expect(decision).toMatchObject({ wake: true, reason: 'affected', affected: 1 });
  });

  it('B6: 別宛先のジョブで、名簿を読めない（aliveRunnerIds === undefined）→ 対象', () => {
    const jobs = [job('a', 'running', 'runner-9')];
    const decision = decideRunnerSwapNotice({
      runnerId: 'runner-1',
      jobs,
      aliveRunnerIds: undefined,
    });
    expect(decision).toMatchObject({ wake: true, reason: 'affected', affected: 1 });
  });

  it('B7 + B10: 別宛先のジョブで、その宛先が名簿に生きている → 対象外（0本で起こさない）', () => {
    const jobs = [job('a', 'running', 'runner-9')];
    const decision = decideRunnerSwapNotice({
      runnerId: 'runner-1',
      jobs,
      aliveRunnerIds: new Set(['runner-9']),
    });
    expect(decision).toMatchObject({ wake: false, reason: 'none-affected', affected: 0 });
  });

  it('B8: 別宛先のジョブで、その宛先が名簿に居ない（死んでいる）→ 対象', () => {
    const jobs = [job('a', 'running', 'runner-9')];
    const decision = decideRunnerSwapNotice({
      runnerId: 'runner-1',
      jobs,
      aliveRunnerIds: new Set(['runner-other-alive']),
    });
    expect(decision).toMatchObject({ wake: true, reason: 'affected', affected: 1 });
  });

  it('数え方と内訳が grounds に日本語で残る', () => {
    const jobs = [
      job('a', 'running', 'runner-1'), // onThisRunner
      job('b', 'running', undefined), // unassigned
      job('c', 'running', 'runner-9'), // silent elsewhere（死んでいる）
      job('d', 'running', 'runner-8'), // alive elsewhere（対象外）
      job('e', 'done', 'runner-1'), // 終わっている（数えない）
    ];
    const decision = decideRunnerSwapNotice({
      runnerId: 'runner-1',
      jobs,
      aliveRunnerIds: new Set(['runner-8']),
    });
    expect(decision.affected).toBe(3);
    expect(decision.grounds).toContain('全 5 件');
    expect(decision.grounds).toContain('未了（running/waiting_human）4 件');
    expect(decision.grounds).toContain('この宛先 1 件');
    expect(decision.grounds).toContain('宛先未記入 1 件');
    expect(decision.grounds).toContain('黙った別宛先 1 件');
    expect(decision.grounds).toContain('生きている別宛先の 1 件は対象外');
  });
});

// -----------------------------------------------------------------------------
// noteRunnerSwap: I/O を伴う口。副作用（起こす／日誌へ残す）の順序と、
// 判定に失敗したときに必ず「起こす」側へ倒れることを確かめる。
// -----------------------------------------------------------------------------

function recordingWake(): { wake: (text: string) => void; calls: string[] } {
  const calls: string[] = [];
  return { wake: (text) => calls.push(text), calls };
}

function recordingWarn(): { warn: (message: string) => void; calls: string[] } {
  const calls: string[] = [];
  return { warn: (message) => calls.push(message), calls };
}

function recordingJournal(opts: { rejects?: boolean } = {}): {
  journal: NoteRunnerSwapDeps['journal'];
  calls: Array<{ decision: string; grounds: string }>;
} {
  const calls: Array<{ decision: string; grounds: string }> = [];
  return {
    calls,
    journal: async (entry) => {
      if (opts.rejects === true) throw new Error('journal 書き込み失敗（テスト用）');
      calls.push({ decision: entry.decision, grounds: entry.grounds });
      return undefined;
    },
  };
}

describe('noteRunnerSwap', () => {
  it('対象が0本のときは起こさない。ただし判断は日誌に1本残る', async () => {
    const { wake, calls: wakeCalls } = recordingWake();
    const { warn } = recordingWarn();
    const { journal, calls: journalCalls } = recordingJournal();

    await noteRunnerSwap({
      notice: '入れ替えの知らせ',
      runnerId: 'runner-1',
      listJobs: () => Promise.resolve([job('a', 'done', 'runner-1')]),
      aliveRunnerIds: () => new Set(),
      journal,
      wake,
      warn,
    });

    expect(wakeCalls).toEqual([]);
    expect(journalCalls).toHaveLength(1);
    expect(journalCalls[0]?.decision).toContain('0 本だったので、クローンを起こさなかった');
  });

  it('対象が1本以上あるときは必ず起こす（notice そのもので）。日誌にも1本残る', async () => {
    const { wake, calls: wakeCalls } = recordingWake();
    const { warn } = recordingWarn();
    const { journal, calls: journalCalls } = recordingJournal();

    await noteRunnerSwap({
      notice: '入れ替えの知らせ・本文そのもの',
      runnerId: 'runner-1',
      listJobs: () => Promise.resolve([job('a', 'running', 'runner-1')]),
      aliveRunnerIds: () => new Set(),
      journal,
      wake,
      warn,
    });

    expect(wakeCalls).toEqual(['入れ替えの知らせ・本文そのもの']);
    expect(journalCalls).toHaveLength(1);
    expect(journalCalls[0]?.decision).toContain('1 本あったので、クローンを起こした');
  });

  it('runnerId を聞けていないときは起こす', async () => {
    const { wake, calls: wakeCalls } = recordingWake();
    const { warn } = recordingWarn();
    const { journal, calls: journalCalls } = recordingJournal();

    await noteRunnerSwap({
      notice: 'n',
      runnerId: undefined,
      listJobs: () => Promise.resolve([]),
      aliveRunnerIds: () => new Set(),
      journal,
      wake,
      warn,
    });

    expect(wakeCalls).toEqual(['n']);
    expect(journalCalls[0]?.decision).toContain(
      '対象の本数を数えられなかったので、クローンを起こした',
    );
  });

  it('listJobs() が同期に投げても起こす', async () => {
    const { wake, calls: wakeCalls } = recordingWake();
    const { warn } = recordingWarn();
    const { journal, calls: journalCalls } = recordingJournal();

    await noteRunnerSwap({
      notice: 'n',
      runnerId: 'runner-1',
      listJobs: () => {
        throw new Error('同期に投げる（テスト用）');
      },
      aliveRunnerIds: () => new Set(),
      journal,
      wake,
      warn,
    });

    expect(wakeCalls).toEqual(['n']);
    expect(journalCalls[0]?.decision).toContain('数えられなかった');
  });

  it('listJobs() が reject しても起こす', async () => {
    const { wake, calls: wakeCalls } = recordingWake();
    const { warn } = recordingWarn();
    const { journal, calls: journalCalls } = recordingJournal();

    await noteRunnerSwap({
      notice: 'n',
      runnerId: 'runner-1',
      listJobs: () => Promise.reject(new Error('台帳が読めない（テスト用）')),
      aliveRunnerIds: () => new Set(),
      journal,
      wake,
      warn,
    });

    expect(wakeCalls).toEqual(['n']);
    expect(journalCalls[0]?.decision).toContain('数えられなかった');
  });

  it('aliveRunnerIds() が投げても、未了の委譲があれば起こす（名簿が読めない＝全部対象）', async () => {
    const { wake, calls: wakeCalls } = recordingWake();
    const { warn } = recordingWarn();
    const { journal, calls: journalCalls } = recordingJournal();

    await noteRunnerSwap({
      notice: 'n',
      runnerId: 'runner-1',
      // 別宛先の未了ジョブが1本ある。名簿が読めないので生死を確かめられず、対象に数える。
      listJobs: () => Promise.resolve([job('a', 'running', 'runner-9')]),
      aliveRunnerIds: () => {
        throw new Error('名簿が読めない（テスト用）');
      },
      journal,
      wake,
      warn,
    });

    expect(wakeCalls).toEqual(['n']);
    expect(journalCalls[0]?.decision).toContain('1 本あったので、クローンを起こした');
  });

  it('日誌の追記が reject しても wake は既に呼ばれている（＋ stderr に残る）', async () => {
    const { wake, calls: wakeCalls } = recordingWake();
    const { warn, calls: warnCalls } = recordingWarn();
    const { journal } = recordingJournal({ rejects: true });

    await noteRunnerSwap({
      notice: '起こすべき知らせ',
      runnerId: 'runner-1',
      listJobs: () => Promise.resolve([job('a', 'running', 'runner-1')]),
      aliveRunnerIds: () => new Set(),
      journal,
      wake,
      warn,
    });

    expect(wakeCalls).toEqual(['起こすべき知らせ']);
    expect(warnCalls.some((message) => message.includes('日誌へ残せませんでした'))).toBe(true);
  });

  it('wake が undefined（クローン未起動）でも落ちず、日誌にその旨が残る', async () => {
    const { warn, calls: warnCalls } = recordingWarn();
    const { journal, calls: journalCalls } = recordingJournal();

    await noteRunnerSwap({
      notice: '起こすべき知らせ（クローン未起動）',
      runnerId: 'runner-1',
      listJobs: () => Promise.resolve([job('a', 'running', 'runner-1')]),
      aliveRunnerIds: () => new Set(),
      journal,
      wake: undefined,
      warn,
    });

    // stderr へ「クローンの受信箱がまだ無い」旨が残る。
    expect(warnCalls.some((message) => message.includes('受信箱がまだ無い'))).toBe(true);
    // 日誌にもその事実が残る。
    expect(journalCalls[0]?.grounds).toContain('stderr にだけ残した');
  });

  it('listJobs は noteRunnerSwap が返る前（＝呼び出し側が引き取りを始める前）に発行される', async () => {
    let calls = 0;
    let resolveJobs: (jobs: Job[]) => void = () => {
      throw new Error('never assigned');
    };
    const jobsPromise = new Promise<Job[]>((resolve) => {
      resolveJobs = resolve;
    });
    const { wake } = recordingWake();
    const { warn } = recordingWarn();
    const { journal } = recordingJournal();

    // 呼び出し側の実際の書き方を模す: `void noteRunnerSwap(...)` の直後に
    // 別の同期処理（ここでは assert）が続く。
    const pending = noteRunnerSwap({
      notice: 'n',
      runnerId: 'runner-1',
      listJobs: () => {
        calls += 1;
        return jobsPromise;
      },
      aliveRunnerIds: () => new Set(),
      journal,
      wake,
      warn,
    });

    // `await` を挟まず、同期に確かめる——ここで既に1回呼ばれているはず。
    expect(calls).toBe(1);

    resolveJobs([]);
    await pending;
  });
});
